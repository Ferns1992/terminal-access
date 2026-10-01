const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const BIND_ADDR = process.env.BIND_ADDR || '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'connections.json');
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS;
const SESSION_SECRET = process.env.SESSION_SECRET;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SHELL = process.env.SHELL_TYPE || 'xterm-256color';
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

// Fail closed rather than silently falling back to a guessable secret.
if (!AUTH_PASS || !SESSION_SECRET) {
  console.error('FATAL: AUTH_PASS and SESSION_SECRET must be set in the environment (see .env).');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Never '*' — a wildcard origin lets any page on the internet open an
  // authenticated socket against this app.
  cors: { origin: false },
  maxHttpBufferSize: 1e6
});

if (TRUST_PROXY) app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const sessionMiddleware = session({
  name: 'th.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: TRUST_PROXY,
    maxAge: 8 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);

// ---------------------------------------------------------------------------
// Login rate limiting (in-memory, per-IP + per-user)
// ---------------------------------------------------------------------------
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function loginBlocked(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

function clearFailures(key) {
  attempts.delete(key);
}

// Sweep expired buckets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.first > WINDOW_MS) attempts.delete(k);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path === '/login') return next();
  if (req.path === '/api/login') return next();
  if (
    req.path.startsWith('/css/') ||
    req.path.startsWith('/js/') ||
    req.path.startsWith('/img/') ||
    req.path === '/favicon.png' ||
    req.path === '/favicon.ico' ||
    req.path === '/manifest.json' ||
    req.path === '/apple-touch-icon.png'
  ) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}
app.use(requireAuth);

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

app.get('/api/me', (req, res) => {
  if (req.session && req.session.authenticated) return res.json({ user: req.session.username });
  res.status(401).json({ error: 'Unauthorized' });
});

app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  const { username, password } = req.body || {};

  // Constant-time compare so response timing cannot leak the credential.
  const userOk =
    typeof username === 'string' &&
    username.length === AUTH_USER.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(AUTH_USER));
  const passOk =
    typeof password === 'string' &&
    password.length === AUTH_PASS.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(AUTH_PASS));

  const ipKey = `ip:${ip}`;
  if (loginBlocked(ipKey)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  if (!userOk || !passOk) {
    recordFailure(ipKey);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  clearFailures(ipKey);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.authenticated = true;
    req.session.username = AUTH_USER;
    req.session.createdAt = Date.now();
    res.json({ success: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ---------------------------------------------------------------------------
// Connections store — format kept identical to the original on disk
// ---------------------------------------------------------------------------
let connections = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(parsed)) connections = parsed;
  }
} catch (e) {
  console.error(`[store] failed to read ${DATA_FILE}: ${e.message}`);
}

function saveConnections() {
  // Write to a temp file then rename, so a crash mid-write cannot truncate the
  // credential store.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(connections, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

// Strip secrets for anything sent to a browser.
function publicView(c) {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    authMethod: c.authMethod,
    keyFingerprint: c.keyFingerprint,
    color: c.color,
    icon: c.icon,
    hasPassword: !!c.password,
    group: c.group
  };
}

app.get('/api/connections', (req, res) => res.json(connections.map(publicView)));

app.post('/api/connections', (req, res) => {
  const { name, host, port = 22, username, password, privateKey, authMethod = 'password', color, icon, group } = req.body || {};
  if (!name || !host || !username) return res.status(400).json({ error: 'Missing required fields' });

  const entry = {
    id: uuidv4(),
    name,
    host,
    port: Number(port) || 22,
    username,
    authMethod,
    color: color || '#7c5cff',
    icon: icon || 'none',
    group: group || 'Ungrouped'
  };
  if (authMethod === 'password' && password) entry.password = password;
  if (authMethod === 'key' && privateKey) {
    entry.privateKey = privateKey;
    entry.keyFingerprint =
      privateKey.split('\n').slice(-2, -1)[0]?.trim()?.substring(0, 40) || 'fingerprint';
  }
  connections.push(entry);
  saveConnections();
  res.json(publicView(entry));
});

app.put('/api/connections/:id', (req, res) => {
  const c = connections.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const { name, host, port, username, password, privateKey, authMethod, color, icon, group } = req.body || {};
  if (name) c.name = name;
  if (host) c.host = host;
  if (port) c.port = Number(port) || c.port;
  if (username) c.username = username;
  if (authMethod) c.authMethod = authMethod;
  if (color) c.color = color;
  if (icon !== undefined) c.icon = icon || 'none';
  if (group !== undefined) c.group = group || 'Ungrouped';
  // An empty string clears the credential; omitting the field leaves it intact.
  if (password !== undefined) c.password = password || undefined;
  if (privateKey !== undefined) {
    c.privateKey = privateKey || undefined;
    c.keyFingerprint = privateKey
      ? privateKey.split('\n').slice(-2, -1)[0]?.trim()?.substring(0, 40) || 'fingerprint'
      : undefined;
  }
  saveConnections();
  res.json({ success: true });
});

app.delete('/api/connections/:id', (req, res) => {
  const before = connections.length;
  connections = connections.filter(c => c.id !== req.params.id);
  if (connections.length === before) return res.status(404).json({ error: 'Not found' });
  saveConnections();
  res.json({ success: true });
});

app.post('/api/connections/:id/test', async (req, res) => {
  const conn = connections.find(c => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  try {
    await testConnection(conn);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

function sshConfigFor(conn, extra = {}) {
  const cfg = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    readyTimeout: 15000,
    tryKeyboard: true,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    ...extra
  };
  if (conn.authMethod === 'password') cfg.password = conn.password;
  else if (conn.privateKey) cfg.privateKey = conn.privateKey;
  if (conn.authMethod === 'key' && conn.passphrase) cfg.passphrase = conn.passphrase;
  return cfg;
}

function testConnection(conn) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const t = setTimeout(() => {
      client.end();
      reject(new Error('Timed out'));
    }, 20000);
    client.on('ready', () => {
      clearTimeout(t);
      client.end();
      resolve();
    });
    client.on('error', err => {
      clearTimeout(t);
      reject(err);
    });
    client.on('keyboard-interactive', (name, instr, lang, prompts, finish) =>
      finish(prompts.map(() => conn.password || ''))
    );
    client.connect(sshConfigFor(conn, { readyTimeout: 15000 }));
  });
}

// ---------------------------------------------------------------------------
// SSH sessions over socket.io
// ---------------------------------------------------------------------------
const activeSessions = new Map();

io.engine.use((req, res, next) => sessionMiddleware(req, req.res || res, next));

// Output batching: a `cat` of a large file emits thousands of chunks. Coalesce
// them into ~16 ms flushes so the socket is not flooded frame by frame.
function createBatcher(emit, interval = 16, maxBytes = 64 * 1024) {
  let queue = [];
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    const buf = Buffer.concat(queue);
    queue = [];
    emit(buf.toString('base64'));
  };
  return {
    push(chunk) {
      queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (queue.reduce((n, b) => n + b.length, 0) >= maxBytes) return flush();
      if (!timer) timer = setTimeout(flush, interval);
    },
    flush,
    stop() {
      flush();
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

io.on('connection', socket => {
  const sess = socket.request.session;
  if (!sess || !sess.authenticated) {
    socket.disconnect(true);
    return;
  }

  const socketSessions = new Map();
  const monitors = new Map();

  const closeSession = id => {
    const s = socketSessions.get(id);
    if (!s) return;
    if (s.batcher) s.batcher.stop();
    if (s.client) { try { s.client.end(); } catch (e) {} }
    socketSessions.delete(id);
    activeSessions.delete(id);
  };

  const closeMonitor = id => {
    const m = monitors.get(id);
    if (!m) return;
    if (m.iv) clearInterval(m.iv);
    if (m.client) { try { m.client.end(); } catch (e) {} }
    monitors.delete(id);
  };

  socket.on('connect-ssh', ({ connectionId, terminalId } = {}) => {
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return socket.emit('terminal-error', { terminalId, error: 'Connection not found' });

    const sessionId = terminalId || uuidv4();

    // Reconnecting with an id we already hold: tear the old one down first,
    // otherwise a double-click leaks an SSH client per click.
    if (socketSessions.has(sessionId)) closeSession(sessionId);

    const client = new Client();
    const batcher = createBatcher(data =>
      socket.emit('terminal-data', { terminalId: sessionId, data })
    );

    socketSessions.set(sessionId, { client, connectionId: conn.id, batcher, conn });
    activeSessions.set(sessionId, socketSessions.get(sessionId));

    console.log(`[ssh] ${conn.username}@${conn.host}:${conn.port} (${conn.authMethod}) term=${sessionId}`);

    client.on('keyboard-interactive', (name, instr, lang, prompts, finish) =>
      finish(prompts.map(() => conn.password || ''))
    );

    client.on('ready', () => {
      client.shell({ term: SHELL, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }, (err, stream) => {
        if (err) {
          return socket.emit('terminal-error', { terminalId: sessionId, error: err.message });
        }
        const rec = socketSessions.get(sessionId);
        if (rec) rec.stream = stream;

        socket.emit('terminal-ready', { terminalId: sessionId });

        stream.on('data', d => batcher.push(d));
        stream.stderr.on('data', d => batcher.push(d));
        stream.on('close', () => {
          batcher.stop();
          socket.emit('terminal-close', { terminalId: sessionId });
          closeSession(sessionId);
        });
      });
    });

    client.on('error', err => {
      socket.emit('terminal-error', { terminalId: sessionId, error: err.message });
      closeSession(sessionId);
    });

    client.on('close', () => closeSession(sessionId));

    client.connect(sshConfigFor(conn));
  });

  socket.on('terminal-input', ({ terminalId, data } = {}) => {
    const s = socketSessions.get(terminalId);
    if (s && s.stream) s.stream.write(data);
  });

  socket.on('terminal-resize', ({ terminalId, cols, rows } = {}) => {
    const s = socketSessions.get(terminalId);
    if (s && s.stream) s.stream.setWindow(rows, cols, 0, 0);
  });

  socket.on('terminal-close', ({ terminalId } = {}) => closeSession(terminalId));

  // -- Monitor ---------------------------------------------------------------
  socket.on('start-monitor', ({ connectionId, monitorId } = {}) => {
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return socket.emit('monitor-error', { monitorId, error: 'Connection not found' });

    // Replaces any monitor already running under this id.
    closeMonitor(monitorId);

    const client = new Client();
    const state = { client, iv: null };
    monitors.set(monitorId, state);

    const runCheck = () => {
      if (monitors.get(monitorId) !== state) return;
      client.exec(
        "LC_ALL=C awk '/^cpu /{t=$2+$3+$4+$5+$6+$7+$8;printf \"CPU:%.1f\\n\",(t-$5)*100/t}' /proc/stat; " +
        "LC_ALL=C free -m | awk 'NR==2{printf \"MEM:%s:%s\\n\",$3,$2}'; " +
        "LC_ALL=C df -h / | awk 'NR==2{printf \"DSK:%s:%s:%s\\n\",$3,$2,$5}'; " +
        "LC_ALL=C cat /proc/loadavg | awk '{printf \"LOAD:%s\\n\",$1}'; " +
        "LC_ALL=C uptime -p 2>/dev/null | awk '{printf \"UPTIME:%s\\n\",$0}'; " +
        "LC_ALL=C uname -sr | awk '{printf \"KERNEL:%s\\n\",$0}'",
        (err, stream) => {
          if (err) return socket.emit('monitor-error', { monitorId, error: err.message });
          let output = '';
          stream.on('data', d => {
            output += d.toString('utf8');
            if (output.length > 8192) stream.close();
          });
          stream.on('close', () => {
            const cpu = output.match(/CPU:([\d.]+)/);
            const mem = output.match(/MEM:(\d+):(\d+)/);
            const dsk = output.match(/DSK:([\d.]+[A-Z]?):([\d.]+[A-Z]?):(\d+)%/);
            const load = output.match(/LOAD:([\d.]+)/);
            const up = output.match(/UPTIME:(.+)/);
            const kern = output.match(/KERNEL:(.+)/);
            if (!cpu && !mem && !dsk) return;
            socket.emit('monitor-data', {
              monitorId,
              cpu: cpu ? parseFloat(cpu[1]) : 0,
              load: load ? parseFloat(load[1]) : 0,
              memUsed: mem ? parseInt(mem[1]) : 0,
              memTotal: mem ? parseInt(mem[2]) : 1,
              dskUsed: dsk ? dsk[1] : '0',
              dskTotal: dsk ? dsk[2] : '0',
              dskPct: dsk ? parseInt(dsk[3]) : 0,
              uptime: up ? up[1].trim() : '',
              kernel: kern ? kern[1].trim() : ''
            });
          });
        }
      );
    };

    client.on('ready', () => {
      runCheck();
      state.iv = setInterval(() => {
        if (monitors.get(monitorId) !== state) {
          if (state.iv) clearInterval(state.iv);
          return;
        }
        runCheck();
      }, 10000);
    });

    client.on('close', () => {
      socket.emit('monitor-error', { monitorId, error: 'Connection closed' });
      closeMonitor(monitorId);
    });

    client.on('error', err => {
      socket.emit('monitor-error', { monitorId, error: err.message });
      closeMonitor(monitorId);
    });

    client.connect(sshConfigFor(conn));
  });

  socket.on('stop-monitor', ({ monitorId } = {}) => closeMonitor(monitorId));

  socket.on('disconnect', () => {
    Array.from(socketSessions.keys()).forEach(closeSession);
    Array.from(monitors.keys()).forEach(closeMonitor);
  });
});

app.get('/api/status', (req, res) => {
  const activeList = Array.from(activeSessions.values())
    .map(s => {
      const conn = connections.find(c => c.id === s.connectionId);
      return conn ? { id: s.id, name: conn.name, host: conn.host, username: conn.username } : null;
    })
    .filter(Boolean);
  res.json({ activeSessions: activeList, totalConnections: connections.length });
});

// Fail loudly if the credential file is not actually private.
try {
  fs.chmodSync(DATA_FILE, 0o600);
} catch (e) {
  /* file may not exist yet on a fresh install */
}

server.listen(PORT, BIND_ADDR, () => {
  console.log(`[boot] Terminal Hub listening on ${BIND_ADDR}:${PORT}`);
  console.log(`[boot] ${connections.length} connection(s) loaded`);
});

// Drop any SSH client still open when the process is asked to stop.
function shutdown() {
  for (const id of activeSessions.keys()) {
    const s = activeSessions.get(id);
    if (s && s.client) { try { s.client.end(); } catch (e) {} }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);