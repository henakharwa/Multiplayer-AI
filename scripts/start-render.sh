#!/bin/sh
set -eu
render_port="${PORT:?Render must provide PORT}"
npm run migrate
PORT=4000 npm run start:server &
chat_pid=$!
npm run start:web -- --hostname 127.0.0.1 --port 3000 &
web_pid=$!
trap 'kill "$chat_pid" "$web_pid" 2>/dev/null || true' INT TERM EXIT
PORT="$render_port" exec caddy run --config /app/Caddyfile --adapter caddyfile
