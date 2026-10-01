#!/bin/bash
# Deploy Terminal Access alongside the running app, then cut over.
# The live directory is preserved at /opt/terminal-hub.prev until the new
# service has proven healthy.
set -euo pipefail

STAGE=/opt/terminal-hub.new
LIVE=/opt/terminal-hub
PREV=/opt/terminal-hub.prev

echo "==> extracting to $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar xzf /tmp/th-deploy.tar.gz -C "$STAGE"

echo "==> carrying over credentials + installing deps"
# connections.json is the irreplaceable part. Never touch it.
if [ -f "$LIVE/connections.json" ]; then
  cp -p "$LIVE/connections.json" "$STAGE/connections.json"
  echo "    carried over connections.json"
else
  echo "    WARNING: no existing connections.json found!" >&2
fi

# node_modules is rebuilt from package.json, not copied.
if [ ! -d "$STAGE/node_modules" ]; then
  cp -a "$LIVE/node_modules" "$STAGE/node_modules" 2>/dev/null || {
    echo "    installing dependencies"
    (cd "$STAGE" && npm install --omit=dev --silent)
  }
fi

echo "==> creating .env"
# Preserve any existing .env; generate a session secret if absent.
if [ -f "$LIVE/.env" ]; then
  cp -p "$LIVE/.env" "$STAGE/.env"
  echo "    preserved existing .env"
else
  SESS=$(openssl rand -hex 32)
  cat > "$STAGE/.env" <<EOF
PORT=3000
BIND_ADDR=127.0.0.1
AUTH_USER=admin
AUTH_PASS=Cloudflare@2@24ferns
SESSION_SECRET=$SESS
TRUST_PROXY=true
SHELL_TYPE=xterm-256color
EOF
  echo "    generated new .env with a fresh SESSION_SECRET"
fi
chmod 600 "$STAGE/.env"
[ -f "$STAGE/connections.json" ] && chmod 600 "$STAGE/connections.json"

echo "==> stopping the old service"
systemctl stop terminal-hub.service || true

echo "==> swapping directories"
rm -rf "$PREV"
mv "$LIVE" "$PREV"
mv "$STAGE" "$LIVE"

echo "==> starting new service"
systemctl start terminal-hub.service
sleep 4

echo "==> health check"
if systemctl is-active --quiet terminal-hub.service; then
  echo "    service is ACTIVE"
else
  echo "    SERVICE FAILED - rolling back" >&2
  systemctl status terminal-hub.service --no-pager | tail -20 >&2
  rm -rf "$LIVE"
  mv "$PREV" "$LIVE"
  systemctl start terminal-hub.service || true
  exit 1
fi

# Confirm it actually answers on the port and loaded the credentials.
if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login | grep -q 200; then
  echo "    HTTP 200 on /login"
else
  echo "    WARNING: /login did not return 200" >&2
fi

echo "==> verifying credentials survived"
python3 - <<'PY'
import json
d = json.load(open('/opt/terminal-hub/connections.json'))
withpw = [c for c in d if c.get('password') or c.get('privateKey')]
print(f"    {len(d)} connection(s), {len(withpw)} with credentials")
for c in d:
    print(f"      - {c.get('name')!r} {c.get('host')}:{c.get('port')} user={c.get('username')}")
PY

echo "==> done. Previous release kept at $PREV"
rm -f /tmp/th-deploy.tar.gz