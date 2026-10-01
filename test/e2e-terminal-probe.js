/* End-to-end probe of the real terminal path.
 * Logs in over HTTPS, opens a socket with the session cookie, asks the
 * server to open an SSH session, and prints what comes back. This exercises
 * exactly what the browser does, so it catches socket + server-side SSH
 * problems that the HTTP "Test" button cannot.
 */
const { io } = require('socket.io-client');

const BASE = 'https://terminal.sysitadmin.com';
const USER = 'admin';
const PASS = process.env.TH_PASS;
const TARGET = process.argv[2];   // connection id
const PROBE_CMD = process.argv[3] || 'echo PROBE_OK_$(hostname); id -un';

if (!PASS || !TARGET) {
  console.error('usage: TH_PASS=... node probe.js <connectionId> [cmd]');
  process.exit(2);
}

(async () => {
  // 1. login, capture cookie
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie() : [];
  const sid = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('th.sid='));
  if (!login.ok || !sid) {
    console.error('LOGIN FAILED', login.status, await login.text());
    process.exit(1);
  }
  console.log('login ok, cookie acquired');

  // 2. socket with that cookie
  const socket = io(BASE, { transports: ['websocket'], extraHeaders: { Cookie: sid }, timeout: 15000 });

  let got = '';
  let done = false;

  const finish = (code, note) => {
    if (done) return;
    done = true;
    console.log('\n--- output ---');
    console.log(got.trim() || '(empty)');
    console.log('----------------');
    console.log(note);
    try { socket.close(); } catch {}
    process.exit(code);
  };

  socket.on('connect', () => {
    console.log('socket connected');
    socket.emit('connect-ssh', { connectionId: TARGET, terminalId: 'probe-1' });
  });

  // Send the probe command through the real input path once the remote PTY
  // is ready, exactly like typing into the browser terminal.
  socket.on('terminal-ready', () => {
    console.log('terminal-ready, sending probe input');
    setTimeout(() => {
      socket.emit('terminal-input', { terminalId: 'probe-1', data: `${PROBE_CMD}\n` });
    }, 1200);
  });

  socket.on('connect_error', (e) => finish(1, `SOCKET CONNECT ERROR: ${e.message}`));

  socket.on('terminal-data', (d) => {
    // server sends base64 bytes; decode exactly like the browser does
    const buf = Buffer.from(d.data, 'base64');
    got += new TextDecoder().decode(buf);
    // The typed command is echoed back by the PTY, so the marker appears twice.
    // The real output is the LAST occurrence and is not inside quotes.
    const hits = [...got.matchAll(/(?:PROBE_OK_|MARKER_)\s*([^\n\r"'`]+)/g)];
    if (hits.length) {
      const val = hits[hits.length - 1][1].trim();
      setTimeout(() => finish(0, `REMOTE EXEC OK  host=${val}`), 300);
    }
  });

  socket.on('error', (e) => finish(1, `SOCKET ERROR: ${e && e.message ? e.message : JSON.stringify(e)}`));

  // Fallback: if terminal-ready never arrives, still type the command after
  // the banner has settled so the probe does not depend on that one event.
  setTimeout(() => {
    if (!got.includes('PROBE_OK_') && !got.includes('MARKER_')) {
      socket.emit('terminal-input', { terminalId: 'probe-1', data: `${PROBE_CMD}\n` });
    }
  }, 8000);

  setTimeout(() => {
    if (!got.trim()) finish(1, 'TIMEOUT: no terminal-data at all (server-side SSH never produced output)');
    else finish(0, 'got output but probe marker absent');
  }, 30000);
})();