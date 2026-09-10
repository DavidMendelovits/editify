#!/usr/bin/env bash
# Start the API (3901) and Expo web (8090) in the background, wait until both answer, print URLs.
# Deliberately NOT 3001/8081: those are the user's own dev servers in the main checkout, and a bot run
# must never touch them. Logs go to .bot/*.out (never *.log — a hook rejects those).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
API_PORT=${API_PORT:-3901}; WEB_PORT=${WEB_PORT:-8090}
mkdir -p .bot
# Only ever kill whatever is on OUR ports — never by process name, that would hit the user's servers.
for port in "$API_PORT" "$WEB_PORT"; do lsof -ti ":$port" | xargs kill 2>/dev/null || true; done

# Detach into a new session (macOS has no setsid) so the servers outlive the shell/tool call that started them.
detach() { python3 -c 'import os,subprocess,sys; subprocess.Popen(sys.argv[2:], cwd=sys.argv[1], stdout=open(os.environ["OUT"],"ab"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)' "$@"; }
OUT=.bot/server.out PORT=$API_PORT detach . npm run dev -w @editify/server
OUT=.bot/web.out EXPO_PUBLIC_API_URL="http://localhost:$API_PORT" CI=1 detach apps/mobile npx expo start --web --port "$WEB_PORT"

for i in $(seq 1 60); do curl -fsS "http://localhost:$API_PORT/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "http://localhost:$API_PORT/health" || { echo "API never came up — see .bot/server.out" >&2; exit 1; }
for i in $(seq 1 90); do curl -fsS "http://localhost:$WEB_PORT" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -o /dev/null "http://localhost:$WEB_PORT" || { echo "Expo web never came up — see .bot/web.out" >&2; exit 1; }
echo; echo "API  http://localhost:$API_PORT"; echo "WEB  http://localhost:$WEB_PORT"
