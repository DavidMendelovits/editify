#!/usr/bin/env bash
# Carries main forward into the release line (plan C2). Run by
# .github/workflows/merge-forward.yml on every push to main:
#   1. reuse the open "Merge main into release/1.1" PR (head main), or open one
#   2. on a conflict: comment "conflict, needs a human" and fail
#   3. wait (up to WAIT_MINUTES) for the PR's own CI, the pull_request runs on
#      the merge result, then merge it with a merge commit
# A hand-made sync PR (same title, a merge branch as head, like #150) wins: this
# leaves it alone until it merges.
#
# Env: REPO (owner/name), SHA (the main commit), GH_TOKEN (GITHUB_TOKEN: reads
# and comments), MERGE_TOKEN (fine-grained PAT: opens and merges the PR, so the
# PR's CI and release/1.1's push deploy both fire; events made with GITHUB_TOKEN
# start no workflows). Optional: BASE, WAIT_MINUTES, POLL_SECONDS, DRY_RUN=1.
set -euo pipefail
: "${REPO:?}" "${SHA:?}" "${GH_TOKEN:?}"
BASE=${BASE:-release/1.1}
TITLE="Merge main into $BASE"
WAIT_MINUTES=${WAIT_MINUTES:-40}
POLL_SECONDS=${POLL_SECONDS:-30}
short=${SHA:0:7}

say() { echo "$*"; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }
act() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*" >&2; else "$@"; fi; }
as_merger() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN (merge token): $*" >&2; else GH_TOKEN=$MERGE_TOKEN "$@"; fi; }
comment() { act gh pr comment "$pr" --repo "$REPO" --body "$1" >/dev/null; }

if [ -z "${MERGE_TOKEN:-}" ]; then
  echo "::warning::MERGE_FORWARD_TOKEN is not set, so main is not merged forward into $BASE. Setup: the header of .github/workflows/merge-forward.yml."
  say "Skipped: no MERGE_FORWARD_TOKEN secret."
  exit 0
fi

if ! gh api "repos/$REPO/branches/${BASE//\//%2F}" --silent 2>/dev/null; then
  say "No $BASE branch; nothing to merge forward."; exit 0
fi
if [ "$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)" != "$SHA" ]; then
  say "main has moved past $short; the run for the newer commit carries it."; exit 0
fi
if [ "$(gh api "repos/$REPO/compare/${BASE//\//%2F}...$SHA" --jq .ahead_by)" = 0 ]; then
  say "$BASE already contains main at $short."; exit 0
fi

open=$(gh pr list --repo "$REPO" --base "$BASE" --state open --json number,headRefName,title)
manual=$(jq -r --arg t "$TITLE" '[.[] | select(.title == $t and .headRefName != "main")][0] // empty | "#\(.number) (head \(.headRefName))"' <<<"$open")
if [ -n "$manual" ]; then
  say "$manual carries main into $BASE by hand; leaving it to its author. The next push to main after it merges picks up from there."
  exit 0
fi
pr=$(jq -r '[.[] | select(.headRefName == "main")][0].number // empty' <<<"$open")
if [ -z "$pr" ]; then
  body="Opened by the merge-forward workflow (plan C2): every push to main merges forward into $BASE once this PR's CI is green. On a conflict it stays open for a human."
  url=$(as_merger gh pr create --repo "$REPO" --base "$BASE" --head main --title "$TITLE" --body "$body")
  [ -n "${DRY_RUN:-}" ] && { say "Would open the sync PR."; exit 0; }
  pr=${url##*/}
  say "Opened #$pr for main at $short."
else
  say "Reusing #$pr for main at $short."
fi

# GitHub computes mergeability in the background.
mergeable=UNKNOWN
for _ in $(seq 1 24); do
  state=$(gh pr view "$pr" --repo "$REPO" --json mergeable,headRefOid --jq '"\(.mergeable) \(.headRefOid)"')
  mergeable=${state% *}; head=${state#* }
  [ "$head" != "$SHA" ] && { say "#$pr moved to ${head:0:7}; the run for that commit carries it."; exit 0; }
  [ "$mergeable" != UNKNOWN ] && break
  sleep 5
done
if [ "$mergeable" = CONFLICTING ]; then
  already=$(gh pr view "$pr" --repo "$REPO" --json comments --jq "[.comments[].body | select(contains(\"conflict, needs a human\") and contains(\"$short\"))] | length")
  [ "$already" = 0 ] && comment "conflict, needs a human: main at $short does not merge cleanly into $BASE. Resolve it on a merge branch (merge origin/main into a branch off $BASE, open it with this title); this workflow leaves that PR alone and resumes once it merges."
  echo "::error::main at $short conflicts with $BASE (#$pr). Needs a human."
  say "Conflict: #$pr left open."
  exit 1
fi

# The PR's CI: pull_request runs for this head commit (main's own push runs and
# this workflow are push runs, so they are not counted).
deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
while :; do
  runs=$(gh api "repos/$REPO/actions/runs?head_sha=$SHA&event=pull_request&per_page=100" \
    --jq '[.workflow_runs | group_by(.workflow_id)[] | max_by(.run_number) | {name, status, conclusion, html_url}]')
  total=$(jq length <<<"$runs")
  pending=$(jq '[.[] | select(.status != "completed")] | length' <<<"$runs")
  failed=$(jq -r '[.[] | select(.status == "completed" and (.conclusion | IN("success", "skipped", "neutral") | not)) | "\(.name) (\(.conclusion)): \(.html_url)"] | join("\n")' <<<"$runs")
  if [ -n "$failed" ]; then
    comment "CI is red on main at $short merged into $BASE, so it is not merged forward. Needs a human:
$failed"
    echo "::error::#$pr CI failed: $failed"
    exit 1
  fi
  [ "$total" -gt 0 ] && [ "$pending" = 0 ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    why=$([ "$total" = 0 ] && echo "no CI run started" || echo "CI was still running")
    comment "Not merged forward: $why for main at $short after $WAIT_MINUTES minutes. Merge by hand once it's green, or re-run the merge-forward workflow."
    echo "::warning::#$pr not merged: $why after $WAIT_MINUTES minutes."
    say "Timed out: #$pr left open ($why)."
    exit 0
  fi
  sleep "$POLL_SECONDS"
done

as_merger gh pr merge "$pr" --repo "$REPO" --merge --match-head-commit "$SHA"
say "Merged #$pr: main at $short is in $BASE."
