#!/bin/bash
# Terminal Access - start script
# Loads .env (chmod 600) then starts the server. Secrets never appear in argv.
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

if [ ! -f .env ]; then
  echo "FATAL: .env not found. Copy .env.example and fill in AUTH_PASS and SESSION_SECRET." >&2
  exit 1
fi
chmod 600 .env
set -a
. ./.env
set +a

[ -d node_modules ] || npm install --omit=dev
exec node server.js
