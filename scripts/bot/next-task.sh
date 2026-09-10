#!/usr/bin/env bash
# Decide what the issue bot should do this run. Prints ONE json line and exits.
#   {"action":"none"}                                  nothing to do — stop the run
#   {"action":"conflict","pr":N,"issue":M,"branch":..} a bot PR is DIRTY — rebase it
#   {"action":"feedback","pr":N,"issue":M,"branch":..} a human commented/reviewed after the bot's last push
#   {"action":"issue","issue":M}                       earliest open issue with no PR — implement it
# Zero model tokens: run this first and stop early when it says none.
set -euo pipefail
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# ponytail: one-run lock so overlapping schedules don't double-book an issue; stale after 4h
LOCK="$HOME/.cache/editify-bot/lock"; mkdir -p "$(dirname "$LOCK")"
if [[ -f "$LOCK" ]] && (( $(date +%s) - $(stat -f %m "$LOCK") < 14400 )); then
  echo '{"action":"none","reason":"another run holds the lock"}'; exit 0
fi
touch "$LOCK"

all_prs=$(gh pr list --state open --limit 100 --json number,headRefName,mergeStateStatus,reviewDecision,body)
prs=$(jq -c '[.[] | select(.headRefName|startswith("bot/"))]' <<<"$all_prs")

# Issue number a PR is for: branch .../issue-<N>-... (fallback: "closes #N" in body).
# The parens matter: without them the `//` fallback runs inside the `.headRefName |` pipe
# and indexes .body on a string.
issue_of='((.headRefName | capture("issue-(?<n>[0-9]+)").n) // (.body | capture("[Cc]loses #(?<n>[0-9]+)").n) // "0") | tonumber'

# 1. conflicts first — cheapest, and they block the user
conflict=$(jq -c "[.[] | select(.mergeStateStatus==\"DIRTY\")] | sort_by(.number) | first // empty
  | {action:\"conflict\",pr:.number,issue:($issue_of),branch:.headRefName}" <<<"$prs")
[[ -n "$conflict" ]] && { echo "$conflict"; exit 0; }

# 2. human feedback newer than the bot's last commit on a bot PR.
# The bot pushes as the user's own gh login, so "human" = a comment/review WITHOUT the bot's signature.
for n in $(jq -r 'sort_by(.number) | .[].number' <<<"$prs"); do
  hit=$(gh pr view "$n" --json number,headRefName,body,reviewDecision,comments,reviews,commits --jq "
    (.commits | map(.committedDate) | max) as \$pushed
    | ([.comments[], .reviews[]] | map(select((.body|length) > 0 and (.body|contains(\"Generated with [Claude Code]\")|not) and .createdAt > \$pushed)) | length) as \$new
    | select(\$new > 0 or .reviewDecision==\"CHANGES_REQUESTED\")
    | {action:\"feedback\",pr:.number,issue:($issue_of),branch:.headRefName}")
  [[ -n "$hit" ]] && { echo "$hit"; exit 0; }
done

# 3. earliest open issue with no open PR, no bot/ branch, not labeled blocked
# Any open PR claims its issue, not just bot/ ones — otherwise a human PR for issue N
# leaves N looking unclaimed and every run re-implements it.
taken=$(jq -r ".[] | $issue_of" <<<"$all_prs"; git ls-remote --heads origin '*issue-*' | sed -E 's#.*issue-([0-9]+).*#\1#')
issue=$(gh issue list --state open --limit 200 --json number,labels \
  --jq '[.[] | select(all(.labels[]?.name; . != "blocked" and . != "wontfix"))] | sort_by(.number) | .[].number' \
  | grep -vxF -f <(printf '%s\n' $taken) | head -1 || true)
if [[ -n "$issue" ]]; then echo "{\"action\":\"issue\",\"issue\":$issue}"; exit 0; fi

rm -f "$LOCK"
echo '{"action":"none","reason":"no conflicts, no feedback, no unclaimed issues"}'
