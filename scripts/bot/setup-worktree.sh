#!/usr/bin/env bash
# Fresh-worktree bootstrap for bot runs: deps, shared build, seeded data from the main checkout.
# `npm run seed` is blocked in unattended runs, so we copy the main checkout's DB (its projects are
# user_id NULL = visible to every login) and symlink its media dirs.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
MAIN=${EDITIFY_MAIN_CHECKOUT:-$HOME/space/editify}

npm install --no-audit --no-fund >/dev/null
npm run build -w @editify/shared >/dev/null
git checkout -q package-lock.json 2>/dev/null || true   # npm install rewrites it; never commit that

mkdir -p server/data
if [[ ! -f server/data/editify.db && -f "$MAIN/server/data/editify.db" ]]; then
  cp "$MAIN"/server/data/editify.db* server/data/
  for d in assets renders sounds emoji callouts; do
    [[ -e "server/data/$d" ]] || ln -s "$MAIN/server/data/$d" "server/data/$d"
  done
fi
echo "worktree ready: $(pwd)"
