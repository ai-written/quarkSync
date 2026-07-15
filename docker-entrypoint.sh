#!/bin/sh
set -e

mkdir -p /app/logs

# config.json mapping: create from template on first run
if [ ! -f /app/config/config.json ]; then
  cp /app/config.example.json /app/config/config.json
  echo "=============================================="
  echo " First run: created /app/config/config.json from template"
  echo " Edit config/config.json and restart the container"
  echo "=============================================="
fi
ln -sf /app/config/config.json /app/config.json

# sync.log mapping: persist log to /app/logs/
touch /app/logs/sync.log
ln -sf /app/logs/sync.log /app/sync.log

# Run initial sync on every startup
echo "[Entrypoint] Running initial sync..."
node index.js || true

# Run initial alist download
echo "[Entrypoint] Running initial alist download..."
node index.js alist || true

echo "[Entrypoint] Initial tasks done, starting main process..."

exec "$@"
