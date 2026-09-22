#!/bin/sh
set -eu
render_port="${PORT:?Render must provide PORT}"
npm run migrate
PORT=4000 npm run start:server &
chat_pid=$!
(
  cd /app/apps/web
  PORT=3000 npm run start -- -H 127.0.0.1
) &
web_pid=$!
trap 'kill "$chat_pid" "$web_pid" 2>/dev/null || true' INT TERM EXIT
PORT="$render_port" exec caddy run --config /app/Caddyfile --adapter caddyfile
