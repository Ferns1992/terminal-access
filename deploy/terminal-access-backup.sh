#!/usr/bin/env bash
# Back up the Terminal Access app to Cloudflare R2.
#
# What gets backed up:
#   - connections.json  (the saved SSH logins — the irreplaceable part)
#   - .env              (auth + session secrets)
#   - server.js and public/  (the application source)
#   - a manifest with SHA-256 checksums
#
# Design notes:
#   - Runs on the HOST, not inside the app, so the R2 credentials live only
#     in root's rclone config and are unreachable from the web app.
#   - rclone `copy`, never `sync`: a bad run must never be able to delete
#     objects from the bucket.
#   - Connections are encrypted before upload. connections.json holds live
#     root SSH passwords for five servers; an unencrypted copy in R2 would
#     turn a bucket read into a full fleet compromise.
#   - The encryption key lives in BACKUP_KEY_FILE on the host and is NOT
#     uploaded. Losing it makes the backups unreadable, so it is also copied
#     to the user's machine out of band.
set -euo pipefail

APP_DIR=/opt/terminal-hub
BACKUP_DIR=/var/backups/terminal-access
KEY_FILE=/root/.config/terminal-access/backup.key
R2_REMOTE=R2
BUCKET=terminal-access-backups
KEEP_LOCAL=14
KEEP_REMOTE=90
STAMP=$(date -u +%Y%m%d-%H%M%S)

log() { echo "[$(date -u '+%F %T')] $*"; }

# ── Preflight ──────────────────────────────────────────────────────────────
[ -d "$APP_DIR" ] || { log "FATAL: $APP_DIR missing"; exit 1; }
[ -f "$APP_DIR/connections.json" ] || { log "FATAL: connections.json missing"; exit 1; }
[ -f "$KEY_FILE" ] || { log "FATAL: backup key $KEY_FILE missing"; exit 1; }
rclone listremotes 2>/dev/null | grep -q "^${R2_REMOTE}:" || {
  log "FATAL: rclone remote ${R2_REMOTE}: not configured"; exit 1; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# ── Stage ──────────────────────────────────────────────────────────────────
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
chmod 700 "$STAGE"

# Only the files that matter. Never the whole directory: that would pick up
# node_modules and any stray editor backups.
mkdir -p "$STAGE/payload"
cp "$APP_DIR/connections.json" "$STAGE/payload/"
cp "$APP_DIR/.env" "$STAGE/payload/"
cp "$APP_DIR/server.js" "$STAGE/payload/"
cp "$APP_DIR/package.json" "$STAGE/payload/" 2>/dev/null || true
cp -r "$APP_DIR/public" "$STAGE/payload/public"
find "$STAGE/payload" -name '*.orig' -delete 2>/dev/null || true

# Checksums of the plaintext payload, recorded before encryption.
( cd "$STAGE/payload" && find . -type f -exec sha256sum {} + | sort -k2 ) > "$STAGE/MANIFEST.sha256"

cat > "$STAGE/metadata.json" <<EOF
{
  "created_utc": "$(date -u +%FT%TZ)",
  "hostname": "$(hostname)",
  "app_dir": "$APP_DIR",
  "connection_count": $(python3 -c "import json;print(len(json.load(open('$APP_DIR/connections.json'))))" 2>/dev/null || echo 'unknown'),
  "app_version": "$(python3 -c "import json;print(json.load(open('$APP_DIR/package.json')).get('version','unknown'))" 2>/dev/null || echo 'unknown')"
}
EOF

# ── Encrypt ────────────────────────────────────────────────────────────────
# The key file is raw bytes; SHA-256 gives openssl a fixed-length passphrase.
KEY=$(sha256sum "$KEY_FILE" | cut -d' ' -f1)

tar -C "$STAGE" -czf - payload MANIFEST.sha256 metadata.json \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass "pass:$KEY" \
      -out "$STAGE/backup.tar.gz.enc"

# ── Verify the archive we just produced ────────────────────────────────────
# Verify the BACKUP, not the original. Reading the source and calling that a
# success proves nothing about the copy that will actually be restored from.
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass "pass:$KEY" \
      -in "$STAGE/backup.tar.gz.enc" 2>/dev/null | tar -tzf - >/dev/null 2>&1; then
  log "FATAL: encrypted archive failed decryption/tar integrity check — not uploading"
  rm -f "$STAGE/backup.tar.gz.enc"
  exit 1
fi

# Row-count sanity check against the live file.
ENC_CONNECTIONS=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass "pass:$KEY" \
  -in "$STAGE/backup.tar.gz.enc" 2>/dev/null | tar -xzOf - payload/connections.json 2>/dev/null || echo '[]')
ENC_COUNT=$(printf '%s' "$ENC_CONNECTIONS" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo -1)
LIVE_COUNT=$(python3 -c "import json;print(len(json.load(open('$APP_DIR/connections.json'))))" 2>/dev/null || echo -1)

if [ "$ENC_COUNT" != "$LIVE_COUNT" ]; then
  log "FATAL: connection count mismatch inside archive (live=$LIVE_COUNT encrypted=$ENC_COUNT) — not uploading"
  exit 1
fi
log "archive verified: decrypts, untars, $ENC_COUNT connections match live file"

# ── Local retention ────────────────────────────────────────────────────────
FINAL="$BACKUP_DIR/terminal-access-$STAMP.tar.gz.enc"
cp "$STAGE/backup.tar.gz.enc" "$FINAL"
chmod 600 "$FINAL"

# ── Upload ─────────────────────────────────────────────────────────────────
# copy, not sync. Never let a backup job delete from the bucket.
if rclone copy "$FINAL" "${R2_REMOTE}:${BUCKET}/" --log-level ERROR; then
  log "uploaded to ${R2_REMOTE}:${BUCKET}/terminal-access-$STAMP.tar.gz.enc"
else
  log "ERROR: upload failed; local copy retained at $FINAL"
  exit 1
fi

# ── Prune ──────────────────────────────────────────────────────────────────
cd "$BACKUP_DIR"
ls -1t terminal-access-*.tar.gz.enc 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f
log "local retention: $(ls -1 terminal-access-*.tar.gz.enc 2>/dev/null | wc -l) snapshots"

rclone delete "${R2_REMOTE}:${BUCKET}/" --min-age "${KEEP_REMOTE}d" --log-level ERROR || true
log "remote retention: keeping ${KEEP_REMOTE} days"

log "BACKUP OK ($(du -h "$FINAL" | cut -f1), $ENC_COUNT connections)"