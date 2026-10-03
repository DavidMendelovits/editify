#!/usr/bin/env bash
# Exposes the reviews folder to the tailnet (tailnet only, never the internet)
# and prints the URL. Idempotent:
#   1. keeps a loopback static server (serve-dir.mjs, Range-capable) running
#   2. adds one `tailscale serve` HTTP mapping to it if missing, touching no others
# The Mac App Store tailscaled cannot serve a folder directly (sandbox), hence 1.
#
#   serve-tailnet.sh [review-dir]     prints the home URL, or that review's URL
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${REVIEWS_DIR:-$HOME/editify-reviews}"
PORT="${REVIEWS_PORT:-8790}"          # tailnet port
LOCAL="${REVIEWS_LOCAL_PORT:-8791}"   # loopback port behind it
mkdir -p "$ROOT"
command -v tailscale >/dev/null || { echo "tailscale CLI not found" >&2; exit 1; }

if ! curl -s -o /dev/null -m 2 "http://127.0.0.1:$LOCAL/"; then
  nohup node "$HERE/serve-dir.mjs" "$ROOT" "$LOCAL" > "$ROOT/.server.log" 2>&1 &
  echo $! > "$ROOT/.server.pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null -m 1 "http://127.0.0.1:$LOCAL/" && break; sleep 0.3; done
fi
if ! tailscale serve status 2>/dev/null | grep -qE ":$PORT( |$)"; then
  tailscale serve --bg --http="$PORT" "http://127.0.0.1:$LOCAL" >/dev/null
fi
HOST="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
SUFFIX=""
if [ "${1:-}" != "" ]; then SUFFIX="$(basename "$1")/"; fi
echo "http://$HOST:$PORT/$SUFFIX"
