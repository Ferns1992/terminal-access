# 🖥️ Terminal Access

> Browser-based SSH terminal manager with session monitoring, credential management, and a polished dark/light UI.

Self-hosted web terminal that lets you keep a set of SSH targets in one place, open multiple
sessions in tabs, watch live CPU/memory/disk metrics, and manage credentials — all from a browser,
with no SSH client installed.

**Live at:** `https://terminal.sysitadmin.com/`

---

## ✨ Features

### 🔌 Connections

- 🖧 Saved SSH hosts with password **or** private-key auth
- 🎨 Per-connection accent colour and icon
- 📂 Group connections into folders (`group` field) for organisation
- ✅ One-click connection test with a clear pass/fail result
- ✏️ Full CRUD over `/api/connections`
- 🔒 Credentials are **never** returned to the browser — the API returns `hasPassword: true/false`
  and never the secret itself

### 🖥️ Terminal

- 📑 **Multi-session tabs** — run several hosts side by side
- 🎨 256-colour + truecolour rendering via xterm.js
- 🔤 **Correct UTF-8 handling** — box-drawing, accents and emoji render properly (see *Fixes*)
- 📜 Deep scrollback
- ↔️ Live resize propagation to the remote PTY
- ⚡ **Output batching** — coalesces high-volume output into ~16 ms flushes so
  `cat`-ing a big file does not flood the socket

### 📊 Monitoring

- 📈 Live CPU, load average, memory, and disk usage
- ⏱️ Uptime and kernel version
- 🔄 Auto-refresh every 10 s, self-cleaning when a connection drops

### 🎨 Interface

- 🌗 **Dark and light themes** with system-preference detection and manual override
- 💾 Theme choice persists to `localStorage`
- 📱 Responsive layout — sidebar collapses on narrow screens
- ✨ Emoji-labelled cards, status pills, and toasts
- 🔌 New terminal icon, generated and wired through the manifest + favicon

### 🔐 Security

- 🔑 Credentials in a mode-`600` file, never in source
- 🚫 **No hardcoded secrets** — server refuses to boot without `AUTH_PASS` + `SESSION_SECRET`
- 🛡️ Strict Content-Security-Policy, `nosniff`, `X-Frame-Options: DENY`, HSTS when proxied
- ⏱️ Login rate limiting — 8 attempts per IP per 15 min, then lockout
- 🕵️ Constant-time credential comparison to avoid timing leaks
- 🔒 `httpOnly` + `sameSite=strict` session cookies, `secure` when behind a proxy
- 🔄 Session ID regenerated on successful login
- ⛔ Socket connections require an authenticated session
- 🚦 CORS wildcard removed — the original `origin: '*'` let any site open authenticated sockets

---

## 🐛 Fixes in this rewrite

| Area | Problem | Fix |
|------|---------|-----|
| **Characters** | `term.write(atob(...))` produced a *binary string* (one char per byte), so every UTF-8 multibyte glyph — box-drawing, accents, emoji — rendered as mojibake | Decode with `TextDecoder` → real UTF-8 strings |
| **Credentials** | Admin password hardcoded in `server.js` | Moved to `.env`; server exits if unset |
| **CORS** | `origin: '*'` on socket.io | Replaced; origin checking enforced |
| **Rate limiting** | `/api/login` brute-forceable | Per-IP lockout |
| **Session secret** | `uuidv4()` regenerated every restart, logging users out | Stable `SESSION_SECRET` from `.env` |
| **Headers** | No CSP or security headers | Full header set added |
| **Monitor leaks** | Rapid `start-monitor` stacked SSH clients | Previous monitor closed before starting a new one |
| **Session leaks** | Double-clicking a terminal leaked an SSH client | Reconnect closes the existing session first |
| **Socket cleanup** | Weak disconnect handling | Every session and monitor torn down explicitly |
| **Data durability** | `writeFileSync` could truncate credentials on a crash | Write to `.tmp` then `rename` (atomic) |
| **Dead code** | `app.js`/`a.js`, `terminal.js`/`t.js`, `style.css`/`s.css` were byte-identical duplicates | Removed |
| **Shutdown** | Open SSH clients on SIGTERM | Graceful teardown with a hard-exit fallback |

---

## 🚀 Quick start

```bash
git clone https://github.com/Ferns1992/terminal-access.git
cd terminal-access
npm install

# Create your environment file
cat > .env <<'EOF'
PORT=3000
BIND_ADDR=127.0.0.1
AUTH_USER=admin
AUTH_PASS=change-me-to-something-strong
SESSION_SECRET=change-me-to-a-long-random-string
TRUST_PROXY=false
EOF

chmod 600 .env
npm start
```

Generate a good session secret with:

```bash
openssl rand -hex 32
```

### Configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | Listen port |
| `BIND_ADDR` | `0.0.0.0` | Use `127.0.0.1` when behind a reverse proxy |
| `AUTH_USER` | `admin` | Login username |
| `AUTH_PASS` | — | **Required.** Login password |
| `SESSION_SECRET` | — | **Required.** `openssl rand -hex 32` |
| `TRUST_PROXY` | `false` | Set `true` behind nginx/Cloudflare — enables `secure` cookies + HSTS |
| `SHELL_TYPE` | `xterm-256color` | `TERM` advertised to the remote PTY |

> ⚠️ **Never commit `.env` or `connections.json`.** Both are in `.gitignore`.

---

## 🔌 Connecting through a tunnel

The service binds a plain HTTP port. Expose it with a `cloudflared` tunnel rather than opening
the port to the internet.

**Nginx reverse proxy:**

```nginx
server {
    listen 443 ssl http2;
    server_name terminal.example.com;

    ssl_certificate     /etc/letsencrypt/live/terminal.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/terminal.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Required for the websocket transport
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Set `TRUST_PROXY=true` so the app knows it is behind a proxy — that enables `secure` cookies and HSTS.

---

## 🗂️ Data format

Credentials live in `connections.json` next to `server.js`, mode `600`. The on-disk schema is
stable and intentionally unchanged from the original app:

```json
[
  {
    "id": "uuid",
    "name": "Oracle VPS 2.1",
    "host": "139.185.55.130",
    "port": 22,
    "username": "root",
    "authMethod": "password",
    "password": "…",
    "color": "#7c5cff",
    "icon": "none",
    "group": "Ungrouped"
  }
]
```

`privateKey` and `keyFingerprint` are also preserved for key-based entries.

---

## 🔌 API

All routes require an authenticated session.

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/me` | Current user |
| `POST` | `/api/login` | Sign in (rate limited) |
| `POST` | `/api/logout` | Sign out |
| `GET` | `/api/connections` | List connections (no secrets) |
| `POST` | `/api/connections` | Create |
| `PUT` | `/api/connections/:id` | Update |
| `DELETE` | `/api/connections/:id` | Delete |
| `POST` | `/api/connections/:id/test` | Test reachability + auth |
| `GET` | `/api/status` | Active sessions and totals |

**Socket.IO events**

| Direction | Event | Payload |
|-----------|-------|---------|
| ⬆ client | `connect-ssh` | `{ connectionId, terminalId }` |
| ⬆ client | `terminal-input` | `{ terminalId, data }` |
| ⬆ client | `terminal-resize` | `{ terminalId, cols, rows }` |
| ⬆ client | `terminal-close` | `{ terminalId }` |
| ⬆ client | `start-monitor` | `{ connectionId, monitorId }` |
| ⬆ client | `stop-monitor` | `{ monitorId }` |
| ⬇ server | `terminal-ready` / `terminal-data` / `terminal-error` / `terminal-close` | |
| ⬇ server | `monitor-data` / `monitor-error` | |

`terminal-data` carries a **base64** payload. Decode it as UTF-8 — see
`public/js/app.js` for the reference `TextDecoder` implementation.

---

## 🖥️ systemd

```ini
[Unit]
Description=Terminal Access
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/terminal-hub
EnvironmentFile=/opt/terminal-hub/.env
ExecStart=/usr/bin/node /opt/terminal-hub/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Using `EnvironmentFile` keeps secrets out of the unit file and out of `ps` output.

---

## 🗄️ Backups

`deploy/terminal-hub-backup.sh` snapshots `connections.json` and the app source, verifies the
JSON parses, keeps 14 local copies, then mirrors to Cloudflare R2 with `rclone copy`
(copy, never sync — sync could delete remote objects).

Run it nightly from a systemd timer.

> 🛡️ **Always open the backup to verify it.** A first version of this script once uploaded
> three empty snapshots because a SQLite-style `connect()` silently created a new file instead
> of opening the existing one. Verification printed success against the *original* file, so the
> log looked healthy while the backup was worthless.

---

## 📝 Notes

- 🧠 Inspired by [Nexterm](https://nexterm.dev/) and Termius for the tabbed multi-session layout,
  connection grouping, and live metrics.
- 🎨 The tabbed layout, monitoring cards, and connection grouping follow those conventions;
  the implementation here is independent.
- 🔒 Credentials are stored in plaintext by design to preserve the original on-disk format.
  Treat `connections.json` as a secret: mode `600`, never in version control.

---

## 📄 License

MIT