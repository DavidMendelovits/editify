#!/usr/bin/env bash
# Self-check for next-task.sh's issue_of expression. Run: scripts/bot/next-task-test.sh
set -euo pipefail
cd "$(dirname "$0")"
issue_of=$(sed -n "s/^issue_of='\(.*\)'$/\1/p" next-task.sh)
[[ -n "$issue_of" ]] || { echo "FAIL: issue_of not found in next-task.sh"; exit 1; }

check() { # <json> <expected>
  got=$(jq -r "$issue_of" <<<"$1" 2>&1) || true
  [[ "$got" == "$2" ]] || { echo "FAIL: $1 -> '$got', want '$2'"; exit 1; }
}
check '{"headRefName":"bot/issue-14-transcript-trim","body":""}'        14
check '{"headRefName":"DM/issue-23-nle-aesthetic","body":""}'           23   # human branch, not just bot/
check '{"headRefName":"bot/ignore-demo-media","body":"Closes #7."}'      7   # body fallback, no jq error
check '{"headRefName":"bot/ignore-demo-media","body":"closes #7"}'       7
check '{"headRefName":"bot/ignore-demo-media","body":"no ref here"}'     0
echo "ok"
