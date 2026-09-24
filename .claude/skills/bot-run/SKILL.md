---
name: bot-run
description: Playbook for the unattended issue bot on editify — pick work, implement in a worktree, verify on Expo web with agent-browser, record + upload a demo, open the PR. Load at the start of every scheduled "editify-tasks" run.
---

# Editify issue bot — run playbook

Every run is a fresh worktree and a fresh context. Everything deterministic is a script under
`scripts/bot/`; this file is the part that needs judgment. **Never ask the user anything** (no
AskUserQuestion): decide, note the assumption in the PR, move on. If truly blocked, open a draft
PR with what exists and say exactly what blocked you.

## 0. Pick (zero tokens)

```bash
scripts/bot/next-task.sh        # one JSON line
```

| action | do |
|---|---|
| `none` | stop the run immediately. Say "nothing to do" and end. |
| `conflict` | §4 — rebase that bot PR. |
| `feedback` | §5 — address the human comments on that bot PR. |
| `issue` | §1–3 — implement it. |

Never touch an open bot PR that is `CLEAN`/`MERGEABLE` with no new human comments. Those are
waiting on the user, not on you. One task per run.

## 1. Set up

```bash
git fetch -q origin && git checkout -q -b bot/issue-<N>-<slug> origin/main   # (issue action)
scripts/bot/setup-worktree.sh     # npm install, build shared, copy seeded DB + media
```

**Auth emails bounce and Supabase throttles the project for it.** Never click "create account",
password reset, or anything else that makes Supabase send mail, and never type a made-up address
(`@example.com`, `test@…`) into an auth form. The only sign-in is `qa-login.sh` (password, no mail).
If an issue is about sign-up itself, verify it with the API/unit tests, not a live sign-up.

Blocked in unattended runs, don't retry them: `npm run seed`, the Supabase MCP (even SELECTs),
the Browser-pane `preview_start`, auth-bypass env vars, reading the user's email, Codex CLI
(too old for its default model). Bash-started dev servers and the Browser-pane `navigate` are fine.

## 2. Implement (one Opus subagent)

Orchestrator: read the issue with `gh issue view N --json title,body,comments`, write a
5-line brief (what changes, where, acceptance criteria), and hand it to **one** `Agent`
(`model: opus`) that does the code. Keep the orchestrator's own context for coordination.
Rules for the brief:

- Smallest diff that satisfies the acceptance criteria. No drive-by refactors.
- `npm run typecheck` must pass across workspaces. Run the relevant `server/test/*.test.ts`;
  add a test only where logic is non-trivial. (`better-sqlite3` NODE_MODULE_VERSION errors are
  a local artefact — `npm rebuild better-sqlite3`, not a real failure.)
- Do not commit `package-lock.json` churn from `npm install`, `.bot/`, or any video.
- Report back: files touched, root cause in two sentences, what to look at in the demo.

## 3. Verify + record (this is the proof — do it yourself, don't trust the subagent)

```bash
scripts/bot/serve.sh                       # API :3901, web :8090 (never the user's 3001/8081), waits for both
AB=~/.nvm/versions/node/v24.8.0/bin/agent-browser   # always this path, not the homebrew one
$AB close --all; $AB open http://localhost:8090
$AB record start .bot/take-1.webm          # relaunches the context (clears localStorage) — log in AFTER this
scripts/bot/qa-login.sh                    # sign-in lands on camera; the secret stays in the vault
# ... drive the feature: snapshot -i → click @eN (refs print as [ref=eN]) → screenshot; one long take, dead time is fine
$AB record stop
scripts/bot/finish-demo.sh .bot/take-1.webm issue-<N>-<slug>   # mp4 + contact sheet + upload → prints LINK
```

A recording may span several Bash calls. If `finish-demo` rejects the take as dead (<5 s), the
daemon was stale: `close --all`, use a **new** file name (`take-2.webm`), record again.

Then **look at the contact sheet** (Read the png) before you cite the video. If the take doesn't
show the fix, re-record; never link a video you haven't checked.

**The video illustrates; assertions prove.** For every acceptance criterion in the issue, get a
programmatic read (`eval` on DOM state, `network requests` for the API call, a `curl` against
:3901 with the same data) and put the actual value in the PR's verification table. A row that
says "looked right in the video" is not a verification. `qa-login.sh` exits non-zero if the
signed-in state is not reached; if it fails, stop, the run cannot claim a signed-in demo.

This browser is agent-browser's own headless Chromium on :8090/:3901. Nothing the bot does is
visible in the user's Chrome or touches their :8081/:3001 servers. The demo link is the only
place a human sees the run.

agent-browser on this app (React Native Web + expo-router):
- `read` returns the *index* route's text, not the current page — use
  `eval '(()=>document.body.innerText)()'`. Wrap every `eval` in `(()=>{…})()` (persistent context).
- Click by `@ref` from `snapshot -i`; `find text` picks headings over buttons (`"export ↗"` vs `EXPORT`).
- `mouse wheel` delivers nothing. Real wheel input: CDP `Input.dispatchMouseEvent {type:'mouseWheel'}`
  over `agent-browser get cdp-url` (Node 24 has global WebSocket).
- File pickers: expo-document-picker appends `input[type=file]` to the DOM →
  `agent-browser upload 'input[type=file]' <path>`.
- Don't `set -e` a recording script — one stale ref would skip `record stop`. The `.webm` is
  0 bytes until `record stop`; that's normal.
- A small fixed-position HUD (`location.pathname` + the value under test) injected via `eval`
  makes the video legible; re-inject after navigation.
- Foreground `sleep N; cmd` is blocked; use `until <cond>; do sleep 5; done`.

## 4. Conflict on a bot PR

```bash
git fetch -q origin && git checkout -q -B <branch> origin/<branch> && git merge origin/main
```
Resolve, `npm run typecheck`, run touched tests, push. Re-record (§3) only if the conflict
touched UI files; otherwise add a PR comment listing what was resolved. Comment must carry
the bot signature (below) so the picker knows it's yours.

## 5. Feedback on a bot PR

Read every comment/review newer than the last commit. Address each one, push, reply in the
PR with what changed per point. Re-record if UI changed.

## 6. Open the PR

```bash
git push -u origin HEAD
gh pr create --title "<what changed> (closes #N)" --body-file .bot/pr.md
```

`.bot/pr.md` layout (this is what the user reads instead of the diff — make it count):

```
Closes #N.

## Root cause / what
two to five sentences

## Change
bullets: file → what and why

## Verification
| Check | Result |   ← every acceptance criterion from the issue, plus typecheck/tests

📹 Demo: <LINK from finish-demo>   (contact sheet: <SHEET-LINK>)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

The last line is mandatory on every PR body and every PR comment you post — the picker uses it
to tell your comments from the user's (same GitHub login).

## Videos never go to GitHub

Not committed (gitignored, and CI fails on any tracked `.mp4/.webm/.mov`), not a release asset,
not an issue/PR attachment. Google Drive via `finish-demo.sh` is the only destination. If the upload
fails, the PR goes up as a draft that says "demo could not be uploaded" and the take stays in `.bot/`.

## 7. Close out

Kill the servers (`pkill -f "tsx watch"; pkill -f "expo start"`), `rm -f ~/.cache/editify-bot/lock`.
Final message: PR link, demo link, one line on anything you assumed or skipped. Nothing else.

## Budget

Aim: under 60 minutes wall-clock per run. If implementation is past 90 minutes or the second
demo take still doesn't show the fix, open the PR as **draft** with an honest "not verified
because …" and stop. A draft with a clear note beats a run that never ends.
