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

# 启动时的首次同步/AList 下载改由 web 进程执行：
# 这样可以与 cron、网页手动触发共用同一把进程内互斥锁，避免并发重复转存；
# 同时也不会像以前那样把网页服务的启动阻塞到首次任务跑完。
echo "[Entrypoint] Starting main process (startup tasks are handled by the app)..."

exec "$@"
