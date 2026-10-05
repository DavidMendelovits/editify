#!/bin/zsh
# Release gate (flow c, C10): the single-user cutover import between the local 1.0 and 1.1 data
# dirs, the RUNBOOK's section 2 adapted to local paths (a LocalSource instead of the 6PN agent).
#
#   cutover-local.sh [email]          default gate@editify.test (the fake-auth user)
#
# Runs snapshot, import --user, dry-run --user from $V11_WT/server; exits non-zero unless the
# dry run reports 0 diffs. --user resolves through fake auth's admin user list on :3164.
# Stored paths in data-10 are absolute local paths, so --source-root is data-10 itself.
set -eu
here=${0:A:h}
: ${GATE_DIR:?set GATE_DIR to a scratch directory}
V11_WT=${V11_WT:-$(git -C $here rev-parse --show-toplevel)}
user=${1:-gate@editify.test}
src=$GATE_DIR/data-10 dest=$GATE_DIR/data-11
paths=(--source-dir $src --source-root $src --dest-root $dest)
cd $V11_WT/server
run() {
  env -u DATABASE_URL -u DATABASE_LOCK_URL -u CUTOVER_SOURCE -u CUTOVER_TOKEN \
    SUPABASE_URL=http://localhost:3164 SUPABASE_SERVICE_ROLE_KEY=local-fake-service \
    npx tsx scripts/cutover/cutover.ts "$@" $paths
}
run snapshot
run import --user $user
run dry-run --user $user
