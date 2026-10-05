#!/bin/zsh
# Release gate: local servers only. Never points at production auth or API.
#
#   servers.sh auth                          fake Supabase auth (fake-auth.mjs) on :3164
#   servers.sh v10 [KEY=VAL ...]             the 1.0 server from $V10_WT on :3161, data in $GATE_DIR/data-10
#   servers.sh v11 [KEY=VAL ...]             the 1.1 server from $V11_WT on :3163, data in $GATE_DIR/data-11
#                                            (LINE=1.1 TEST_SERVER=1 RENDER_PLAN=1, like editify-v11)
#   servers.sh stop                          stops all three
#
# Env: GATE_DIR (scratch dir for data, logs, the fake-auth key), V10_WT (a checkout of the 1.0
# line, e.g. origin/main), V11_WT (a checkout of release/1.1; defaults to this repo).
# Extra KEY=VAL pairs go to the server, e.g. `servers.sh v10 MIN_APP_VERSION=1.1.0` (flow d).
# Logs: $GATE_DIR/server-v10.log, server-v11.log, fake-auth.log.
set -u
here=${0:A:h}
: ${GATE_DIR:?set GATE_DIR to a scratch directory}
V11_WT=${V11_WT:-$(git -C $here rev-parse --show-toplevel)}
mkdir -p $GATE_DIR

stop_port() { for p in $(lsof -tiTCP:$1 -sTCP:LISTEN); do kill $p; done; sleep 1; }

which=$1; shift
case $which in
  stop) for port in 3161 3163 3164; do stop_port $port; done; exit 0;;
  auth)
    stop_port 3164
    cd $here && GATE_DIR=$GATE_DIR PORT=3164 nohup node fake-auth.mjs >> $GATE_DIR/fake-auth.log 2>&1 &
    for i in {1..40}; do curl -sf localhost:3164/auth/v1/.well-known/jwks.json >/dev/null && break; sleep 0.25; done
    curl -sf localhost:3164/auth/v1/.well-known/jwks.json >/dev/null && echo "auth up on :3164" || { echo "fake auth did not start"; exit 1; }
    exit 0;;
  v10) port=3161; wt=${V10_WT:?set V10_WT to a 1.0 checkout}; data=$GATE_DIR/data-10; extra=();;
  v11) port=3163; wt=$V11_WT; data=$GATE_DIR/data-11; extra=(LINE=1.1 TEST_SERVER=1 RENDER_PLAN=1);;
  *) echo "usage: servers.sh auth|v10|v11|stop [KEY=VAL ...]"; exit 2;;
esac

stop_port $port
mkdir -p $data $GATE_DIR/empty-import
cd $wt/server
# Unset everything that could reach a real backend; fake auth stands in for Supabase.
env -u ANTHROPIC_API_KEY -u GEMINI_API_KEY -u EDITIFY_TOKEN -u FLY_APP_NAME -u DATABASE_URL -u DATABASE_LOCK_URL \
  -u SUPABASE_SERVICE_ROLE_KEY -u POSTHOG_API_KEY \
  PORT=$port EDITIFY_DATA_DIR=$data PUBLIC_BASE_URL=http://localhost:$port SUPABASE_URL=http://localhost:3164 \
  MEDIA_IMPORT_DIR=$GATE_DIR/empty-import $extra "$@" \
  nohup node --import tsx src/index.ts >> $GATE_DIR/server-$which.log 2>&1 &
for i in {1..80}; do curl -sf localhost:$port/health >/dev/null && break; sleep 0.5; done
curl -s localhost:$port/health; echo; curl -s localhost:$port/client-config; echo
