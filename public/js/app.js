/* Terminal Access — client
 *
 * ⚠️  The one line that matters most in this file:
 *
 *      term.write(decodeB64(payload))
 *
 *     NOT `term.write(atob(payload))`.
 *
 *     atob() returns a *binary string* — one JS character per BYTE. UTF-8
 *     encodes '─' (U+2500) as three bytes (E2 94 80), so the old code rendered
 *     it as three junk glyphs. Every box-drawing character, accent and emoji
 *     came out as mojibake. decodeB64() below goes through TextDecoder, which
 *     reassembles the bytes into a real UTF-8 string.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const PALETTE = ['#7c5cff', '#3fb950', '#d29922', '#f85149', '#2f81f7', '#db61a2', '#39c5cf', '#a371f7'];
  const ICONS = ['none', '🖧', '🚀', '☁️', '🗄️', '🐧', '📦', '🔒', '🌐', '⚡'];

  const state = {
    connections: [],
    filter: '',
    tabs: new Map(),      // terminalId -> { conn, term, fit, host, status }
    order: [],
    active: null,
    monitorFor: null,
    socket: null,
    reconnecting: false
  };

  // ── UTF-8 safe base64 decode ────────────────────────────────────────────
  const utf8Decoder = new TextDecoder('utf-8');
  function decodeB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return utf8Decoder.decode(bytes);
  }

  // ── Theme ───────────────────────────────────────────────────────────────
  function applyTheme(mode) {
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem('ta-theme', mode); } catch (e) {}
    refreshTerminalThemes();
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('ta-theme'); } catch (e) {}
    if (saved === 'dark' || saved === 'light') return applyTheme(saved);
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(prefersLight ? 'light' : 'dark');
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }

  function xtermTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    return light
      ? { background: '#fbfbfd', foreground: '#1a2029', cursor: '#6d4aff', selectionBackground: 'rgba(109,74,255,.25)' }
      : { background: '#05070c', foreground: '#d8dee9', cursor: '#7c5cff', selectionBackground: 'rgba(124,92,255,.3)' };
  }

  function refreshTerminalThemes() {
    state.tabs.forEach((t) => {
      if (t.term) {
        try { t.term.options.theme = xtermTheme(); } catch (e) {}
      }
      if (t.host) t.host.classList.toggle('light', document.documentElement.dataset.theme === 'light');
    });
  }

  // ── Toasts ──────────────────────────────────────────────────────────────
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  // ── API ─────────────────────────────────────────────────────────────────
  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ── Connection list ─────────────────────────────────────────────────────
  function renderConnections() {
    const list = $('connList');
    list.innerHTML = '';
    const q = state.filter.trim().toLowerCase();

    const matches = state.connections.filter((c) =>
      !q || (c.name + ' ' + c.host + ' ' + c.username).toLowerCase().includes(q)
    );

    if (!matches.length) {
      const d = document.createElement('div');
      d.style.cssText = 'padding:22px 12px;text-align:center;color:var(--text-dim);font-size:13px';
      d.textContent = state.connections.length ? '🔍 No matches' : '📭 No servers yet';
      list.appendChild(d);
      return;
    }

    // Group by folder, mirroring the Nexterm/Termius layout.
    const groups = new Map();
    matches.forEach((c) => {
      const g = c.group || 'Ungrouped';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    });

    groups.forEach((items, gname) => {
      if (groups.size > 1 || gname !== 'Ungrouped') {
        const lbl = document.createElement('div');
        lbl.className = 'group-label';
        lbl.textContent = gname;
        list.appendChild(lbl);
      }
      items.forEach((c) => list.appendChild(connRow(c)));
    });
  }

  function connRow(c) {
    const row = document.createElement('div');
    row.className = 'conn';
    if (state.active && state.tabs.has(state.active) && state.tabs.get(state.active).conn.id === c.id) {
      row.classList.add('active');
    }

    const dot = document.createElement('div');
    dot.className = 'conn-dot';
    dot.style.setProperty('--c', c.color || '#7c5cff');

    const emo = document.createElement('div');
    emo.className = 'conn-emoji';
    emo.textContent = c.icon && c.icon !== 'none' ? c.icon : '🖧';

    const meta = document.createElement('div');
    meta.className = 'conn-meta';
    const n = document.createElement('div');
    n.className = 'conn-name';
    n.textContent = c.name;
    const h = document.createElement('div');
    h.className = 'conn-host';
    h.textContent = `${c.username}@${c.host}:${c.port}`;
    meta.append(n, h);

    const acts = document.createElement('div');
    acts.className = 'conn-actions';
    acts.append(
      iconBtn('✅', 'Test connection', async (e) => {
        e.stopPropagation();
        toast(`🔌 Testing ${c.name}…`);
        try {
          const r = await api(`/api/connections/${c.id}/test`, { method: 'POST' });
          toast(r.success ? `✅ ${c.name} is reachable` : `❌ ${c.name}: ${r.error}`, r.success ? 'ok' : 'err');
        } catch (err) {
          toast(`❌ ${err.message}`, 'err');
        }
      }),
      iconBtn('✏️', 'Edit', (e) => { e.stopPropagation(); openModal(c); }),
      iconBtn('🗑️', 'Delete', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${c.name}"? This removes its saved credentials.`)) return;
        api(`/api/connections/${c.id}`, { method: 'DELETE' })
          .then(() => { toast('🗑️ Deleted', 'ok'); load(); })
          .catch((err) => toast(`❌ ${err.message}`, 'err'));
      }, 'danger')
    );

    row.append(dot, emo, meta, acts);
    row.onclick = () => openTerminal(c.id);
    return row;
  }

  function iconBtn(glyph, title, handler, extra) {
    const b = document.createElement('button');
    b.className = 'mini' + (extra ? ' ' + extra : '');
    b.textContent = glyph;
    b.title = title;
    b.onclick = handler;
    return b;
  }

  // ── Modal ───────────────────────────────────────────────────────────────
  function openModal(conn) {
    const editing = !!conn;
    const c = conn || { name: '', host: '', port: 22, username: 'root', authMethod: 'password', color: PALETTE[0], icon: 'none', group: '' };

    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>${editing ? '✏️ Edit Server' : '➕ Add Server'}</h2>
        <div class="error-msg" id="mErr" hidden></div>
        <form id="mForm">
          <div class="seg" id="authSeg">
            <button type="button" data-v="password" class="${c.authMethod === 'password' ? 'on' : ''}">🔑 Password</button>
            <button type="button" data-v="key" class="${c.authMethod === 'key' ? 'on' : ''}">🗝️ Private Key</button>
          </div>
          <div class="field"><label>🏷️ Name</label><input name="name" required value="${esc(c.name)}"></div>
          <div class="field"><label>🌐 Host / IP</label><input name="host" required value="${esc(c.host)}" spellcheck="false"></div>
          <div class="field"><label>🔌 Port</label><input name="port" type="number" value="${esc(String(c.port || 22))}"></div>
          <div class="field"><label>👤 Username</label><input name="username" required value="${esc(c.username)}" spellcheck="false"></div>
          <div class="field" id="pwWrap"><label>🔑 Password</label><input name="password" type="password" placeholder="${editing ? 'Leave blank to keep current' : ''}" autocomplete="new-password"></div>
          <div class="field" id="keyWrap" hidden><label>🗝️ Private Key</label><textarea class="key" name="privateKey" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></div>
          <div class="field"><label>📂 Group / Folder</label><input name="group" value="${esc(c.group === 'Ungrouped' ? '' : (c.group || ''))}" placeholder="Ungrouped"></div>
          <div class="field"><label>🎨 Colour</label><div class="swatches" id="sw"></div></div>
          <div class="field"><label>😀 Icon</label><div class="swatches" id="ic"></div></div>
          <div class="modal-actions">
            <button type="button" class="btn-ghost" id="mCancel">Cancel</button>
            <button type="submit" class="btn" id="mSave">${editing ? 'Save Changes' : 'Create'}</button>
          </div>
        </form>
      </div>`;

    $('modalHost').appendChild(bg);
    let color = c.color || PALETTE[0];
    let icon = c.icon || 'none';

    const sw = bg.querySelector('#sw');
    PALETTE.forEach((col) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (col === color ? ' on' : '');
      b.style.background = col;
      b.onclick = () => {
        color = col;
        sw.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
      sw.appendChild(b);
    });

    const ic = bg.querySelector('#ic');
    ICONS.forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = g === 'none' ? '—' : g;
      b.style.cssText = 'width:32px;height:32px;font-size:15px;border-radius:8px;cursor:pointer;background:var(--bg-input);border:1px solid var(--border)';
      if (g === icon) b.style.borderColor = 'var(--accent)';
      b.onclick = () => {
        icon = g;
        ic.querySelectorAll('button').forEach((x) => (x.style.borderColor = 'var(--border)'));
        b.style.borderColor = 'var(--accent)';
      };
      ic.appendChild(b);
    });

    const seg = bg.querySelector('#authSeg');
    const pwWrap = bg.querySelector('#pwWrap');
    const keyWrap = bg.querySelector('#keyWrap');
    const syncAuth = (v) => {
      pwWrap.hidden = v !== 'password';
      keyWrap.hidden = v !== 'key';
    };
    syncAuth(c.authMethod);
    seg.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        syncAuth(b.dataset.v);
      };
    });

    const close = () => bg.remove();
    bg.querySelector('#mCancel').onclick = close;
    bg.onclick = (e) => { if (e.target === bg) close(); };

    bg.querySelector('#mForm').onsubmit = async (e) => {
      e.preventDefault();
      const mErr = bg.querySelector('#mErr');
      const f = e.target;
      const authMethod = seg.querySelector('.on').dataset.v;
      const body = {
        name: f.name.value.trim(),
        host: f.host.value.trim(),
        port: Number(f.port.value) || 22,
        username: f.username.value.trim(),
        authMethod,
        color,
        icon,
        group: f.group.value.trim() || 'Ungrouped'
      };
      // Only send the secret when the user actually typed one, so editing
      // other fields never wipes a stored credential.
      if (authMethod === 'password' && f.password.value) body.password = f.password.value;
      if (authMethod === 'key' && f.privateKey.value.trim()) body.privateKey = f.privateKey.value.trim();

      const btn = bg.querySelector('#mSave');
      btn.disabled = true;
      try {
        if (editing) await api(`/api/connections/${c.id}`, { method: 'PUT', body: JSON.stringify(body) });
        else await api('/api/connections', { method: 'POST', body: JSON.stringify(body) });
        close();
        toast(editing ? '✅ Updated' : '🎉 Server added', 'ok');
        load();
      } catch (err) {
        mErr.textContent = err.message;
        mErr.hidden = false;
        btn.disabled = false;
      }
    };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Terminals ───────────────────────────────────────────────────────────
  function openTerminal(connectionId, terminalId) {
    const conn = state.connections.find((c) => c.id === connectionId);
    if (!conn) return;

    // Reuse the existing tab for this server.
    let existing = null;
    state.tabs.forEach((t, id) => { if (t.conn.id === connectionId) existing = id; });
    const id = existing || terminalId || 't_' + Math.random().toString(36).slice(2, 10);

    if (!existing) {
      const host = document.createElement('div');
      host.className = 'term-host' + (document.documentElement.dataset.theme === 'light' ? ' light' : '');
      $('pane').appendChild(host);

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Cascadia Code','Fira Code','JetBrains Mono',Consolas,monospace",
        scrollback: 10000,
        theme: xtermTheme(),
        allowProposedApi: true
      });
      // These addon files export a MODULE OBJECT, not the class itself:
      //   e.FitAddon = t()  where  t() -> { FitAddon: class {...} }
      // so the constructor is one level deeper. Using `new FitAddon()`
      // against xterm-addon-fit 0.8 / web-links 0.9 matches the original
      // working app. Getting this wrong throws here, before any socket
      // event is emitted, and the connect button appears to do nothing.
      const FitCtor = (typeof FitAddon === 'function') ? FitAddon : (window.FitAddon && window.FitAddon.FitAddon);
      const LinkCtor = (typeof WebLinksAddon === 'function') ? WebLinksAddon : (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon);
      if (!FitCtor) {
        toast('❌ FitAddon failed to load', 'err');
        return;
      }
      const fit = new FitCtor();
      term.loadAddon(fit);
      if (LinkCtor) term.loadAddon(new LinkCtor());

      // Hide the empty-state placeholder BEFORE opening the terminal.
      // `.empty` is flex:1, so while it is visible it collapses
      // `.term-pane` to zero height. Opening there makes fit() compute
      // 0 rows x 0 cols and the terminal renders blank. Data still
      // arrives over the socket, which is why stats worked while the
      // terminal looked dead.
      const placeholder = $('empty');
      if (placeholder) placeholder.hidden = true;

      term.open(host);

      const tab = { conn, term, fit, host, status: 'connecting', ro: null };
      state.tabs.set(id, tab);
      state.order.push(id);

      // Refit once the browser has actually laid the pane out. Fitting
      // synchronously right after open() still measures the old geometry.
      const refit = () => { try { fit.fit(); } catch (e) {} };
      requestAnimationFrame(() => requestAnimationFrame(refit));

      // Keep this terminal sized to its pane. Without this, a background
      // tab keeps stale dimensions, and switching to it shows wrapped or
      // clipped text until a window resize happens to fix it.
      if (typeof ResizeObserver === 'function') {
        tab.ro = new ResizeObserver(() => { if (state.active === id) refit(); });
        tab.ro.observe(host);
      }

      renderTabs();
      setActive(id);
      connectSocket(id, conn);
    } else {
      setActive(id);
    }
  }

  function connectSocket(id, conn) {
    const tab = state.tabs.get(id);
    if (!tab) return;
    if (!ensureSocket()) return;
    state.socket.emit('connect-ssh', { connectionId: conn.id, terminalId: id });
  }

  function setActive(id) {
    state.active = id;
    state.tabs.forEach((t, tid) => { t.host.hidden = tid !== id; });
    const tab = state.tabs.get(id);
    $('empty').hidden = !!tab;
    if (tab) {
      // Fit after the pane has been unhidden and laid out, otherwise the
      // measurement comes back zero-sized.
      requestAnimationFrame(() => {
        try { tab.fit.fit(); tab.term.focus(); } catch (e) {}
      });
    }
    renderTabs();
    renderConnections();
    startMonitor(tab ? tab.conn : null);
    updateStatus();
  }

  function closeTab(id) {
    const tab = state.tabs.get(id);
    if (!tab) return;
    if (state.socket) state.socket.emit('terminal-close', { terminalId: id });
    try { tab.term.dispose(); } catch (e) {}
    if (tab.ro) { try { tab.ro.disconnect(); } catch (e) {} }
    tab.host.remove();
    state.tabs.delete(id);
    state.order = state.order.filter((x) => x !== id);
    if (state.active === id) {
      const next = state.order[state.order.length - 1];
      if (next) setActive(next);
      else { state.active = null; $('empty').hidden = false; startMonitor(null); }
    }
    renderTabs();
    renderConnections();
    updateStatus();
  }

  function renderTabs() {
    const bar = $('tabbar');
    bar.innerHTML = '';
    const menu = document.createElement('button');
    menu.className = 'icon-btn';
    menu.style.marginLeft = '0';
    menu.textContent = '☰';
    menu.title = 'Menu';
    menu.onclick = () => $('sidebar').classList.toggle('open');
    bar.appendChild(menu);

    state.order.forEach((id) => {
      const t = state.tabs.get(id);
      if (!t) return;
      const el = document.createElement('div');
      el.className = 'tab' + (id === state.active ? ' active' : '');

      const d = document.createElement('div');
      d.className = 'tab-dot' + (t.status === 'open' ? ' live' : t.status === 'error' ? ' err' : '');

      const n = document.createElement('span');
      n.className = 'tab-name';
      n.textContent = (t.conn.icon && t.conn.icon !== 'none' ? t.conn.icon + ' ' : '') + t.conn.name;

      const x = document.createElement('button');
      x.className = 'tab-x';
      x.textContent = '×';
      x.title = 'Close';
      x.onclick = (e) => { e.stopPropagation(); closeTab(id); };

      el.append(d, n, x);
      el.onclick = () => setActive(id);
      bar.appendChild(el);
    });
  }

  // ── Socket ──────────────────────────────────────────────────────────────
  function ensureSocket() {
    if (state.socket) return;
    if (typeof io !== 'function') {
      toast('❌ socket.io client failed to load', 'err');
      return null;
    }
    const socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
    state.socket = socket;

    socket.on('terminal-ready', ({ terminalId }) => {
      const t = state.tabs.get(terminalId);
      if (t) { t.status = 'open'; renderTabs(); updateStatus(); }
    });

    socket.on('terminal-data', ({ terminalId, data }) => {
      const t = state.tabs.get(terminalId);
      // ✅ The UTF-8 fix: decodeB64, never raw atob.
      if (t) t.term.write(decodeB64(data));
    });

    socket.on('terminal-error', ({ terminalId, error }) => {
      const t = state.tabs.get(terminalId);
      if (t) {
        t.status = 'error';
        t.term.write(`\r\n\x1b[31m❌ ${error}\x1b[0m\r\n`);
        renderTabs();
        toast(`❌ ${error}`, 'err');
      }
    });

    socket.on('terminal-close', ({ terminalId }) => {
      const t = state.tabs.get(terminalId);
      if (t) {
        t.status = 'closed';
        t.term.write('\r\n\x1b[33m⚠️  Session closed\x1b[0m\r\n');
        renderTabs();
      }
    });

    socket.on('monitor-data', (d) => {
      if (state.monitorFor && d.monitorId === state.monitorFor) paintMetrics(d);
    });

    socket.on('monitor-error', () => {
      const el = $('metrics');
      if (el) el.hidden = true;
    });

    socket.on('disconnect', () => {
      setStateDot(false, 'Reconnecting…');
      if (!state.reconnecting) {
        state.reconnecting = true;
        setTimeout(() => {
          state.socket = null;
          state.reconnecting = false;
          // Re-open every session that was live before the drop.
          state.tabs.forEach((t, id) => {
            if (t.status === 'open') { t.status = 'connecting'; connectSocket(id, t.conn); }
          });
        }, 1500);
      }
    });

    socket.on('connect', () => setStateDot(true, 'Connected'));
    socket.on('connect_error', () => setStateDot(false, 'Offline'));

    // A throw inside a socket callback is otherwise invisible: the UI just
    // stops responding. Surface it instead.
    socket.on('error', (err) => {
      toast(`❌ Socket error: ${(err && err.message) || err}`, 'err');
    });

    // Global backstop so any uncaught error becomes visible feedback rather
    // than a silently dead button.
    window.addEventListener('error', (ev) => {
      if (ev && ev.message) toast(`⚠️ ${ev.message}`, 'err');
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev && ev.reason;
      toast(`⚠️ ${(r && r.message) || r || 'Unexpected error'}`, 'err');
    });
  }

  // ── Metrics ─────────────────────────────────────────────────────────────
  function startMonitor(conn) {
    if (state.socket && state.monitorFor) state.socket.emit('stop-monitor', { monitorId: state.monitorFor });
    state.monitorFor = null;
    $('metrics').hidden = !conn;
    if (!conn) return;
    ensureSocket();
    state.monitorFor = 'm_' + conn.id;
    state.socket.emit('start-monitor', { connectionId: conn.id, monitorId: state.monitorFor });
  }

  function paintMetrics(d) {
    const pct = d.memTotal ? Math.round((d.memUsed / d.memTotal) * 100) : 0;
    $('mCpu').textContent = (d.cpu || 0).toFixed(0) + '%';
    $('mMem').textContent = pct + '%';
    $('mDsk').textContent = d.dskPct + '%';
    $('mLoad').textContent = (d.load || 0).toFixed(2);

    bar('bCpu', Math.round(d.cpu || 0));
    bar('bMem', pct);
    bar('bDsk', d.dskPct || 0);
    bar('bLoad', Math.min(100, Math.round((d.load || 0) * 25)));

    $('mUp').textContent = d.uptime ? `⏱️ ${d.uptime}` : '';
  }

  function bar(id, pct) {
    const el = $(id);
    if (!el) return;
    el.style.width = Math.max(0, Math.min(100, pct)) + '%';
    el.className = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : '';
  }

  function setStateDot(ok, text) {
    const dot = $('sDot');
    if (dot) dot.style.background = ok ? 'var(--success)' : 'var(--danger)';
    const st = $('sState');
    if (st) st.textContent = text;
  }

  function updateStatus() {
    $('sSrv').textContent = state.connections.length;
    $('sSes').textContent = state.tabs.size;
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  async function load() {
    try {
      state.connections = await api('/api/connections');
      renderConnections();
      updateStatus();
      if (state.connections.length && !state.tabs.size) $('empty').hidden = false;
    } catch (e) { /* api() already redirected on 401 */ }
  }

  function init() {
    initTheme();

    $('themeBtn').onclick = toggleTheme;
    $('addBtn').onclick = () => openModal(null);
    $('menuBtn') && ($('menuBtn').onclick = () => $('sidebar').classList.toggle('open'));

    $('logoutBtn').onclick = async () => {
      try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
      location.href = '/login';
    };

    $('search').oninput = (e) => { state.filter = e.target.value; renderConnections(); };

    window.addEventListener('resize', () => {
      const t = state.tabs.get(state.active);
      if (t) { try { t.fit.fit(); } catch (e) {} }
    });

    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();