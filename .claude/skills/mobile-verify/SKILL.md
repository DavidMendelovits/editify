---
name: mobile-verify
description: Record a mobile workflow (iOS simulator, device, or web) with agent-device, mark key moments while it runs, and publish a review page (video + timestamped moment list) on the tailnet. Use for "record a video of the flow", "verify this on the simulator", "make a review of X", "show me the workflow", or any change that needs visual proof on mobile.
---

# Mobile verify

Recording + key moments in, a review page on the tailnet out.

- Reviews live in `~/editify-reviews/<date>-<slug>/` (outside the repo: CI rejects tracked videos)
- Home page lists every review: `http://<this-mac>.<tailnet>.ts.net:8790/`
- Each review: video player, clickable moment list (thumbnails, step/check/issue), timeline ticks, `#t=12.5` deep links, j/k to jump

## Flow

```bash
S=.claude/skills/mobile-verify/scripts
OUT=$(mktemp -d)

agent-device record start "$OUT/flow.mp4" --platform ios --hide-touches   # or --platform web / a device
node $S/moments.mjs start "$OUT/moments.json" --title "Stand-up sync"

# ... drive the app with agent-device; after each meaningful step:
node $S/moments.mjs mark "$OUT/moments.json" "Memo synced (1.7s)" --kind check
node $S/moments.mjs mark "$OUT/moments.json" "Crop lands on his back" --kind issue --note "needs hold-or-wide fallback"

agent-device record stop --platform ios
REVIEW=$(node $S/build-review.mjs --video "$OUT/flow.mp4" --moments "$OUT/moments.json" \
  --meta "branch=$(git branch --show-current)" --meta "commit=$(git rev-parse --short HEAD)" \
  --meta "device=iPhone 17 Pro Max (sim)" --summary "What this run proves." --offset 0.5)
$S/serve-tailnet.sh "$(dirname "$REVIEW")"     # prints the URL to send
```

## Profiling

`--profile profile.json` adds a Profile section under the video: person time vs this replay (stacked bars), a timeline of person steps against server jobs and requests, each user wait with the server jobs that ran during it (run time, media-slot queue, idle), render speed (x realtime, seconds per output minute), the agent turn (tool calls, thoughts, ops) and per-route request stats (p50/p95, polling). Home cards show person time and render speed.

```bash
node $S/profile.mjs --timings timings.json --log server.ndjson [--chat chat.json] --out profile.json
```

- `timings.json`: the replay's steps (`human` with a person estimate, `wait` measured), `startedAtMs`, `render`
- `server.ndjson`: the server's pino stdout; `{"msg":"media job", job, ms, waitMs, ok}` lines give the per-job breakdown. Without them (older server) the page says so and falls back to request data
- `chat.json`: `GET /projects/:id/chat`, for the agent's trace
- `apps/mobile/e2e/standup-replay.mjs --record --review` does all of this (and exports 1080p at the end; `--skip-render` to skip)
- Tests: `node --test .claude/skills/mobile-verify/scripts/test/*.test.mjs`

## Moment kinds

- `step`: something the flow did ("Opened project", "Imported memo")
- `check`: a verified outcome ("Captions read the memo"); put the evidence in `--note`
- `issue`: something wrong; these are counted on the home page

Mark right after the UI shows the result, not when the command was sent. Assertions (`agent-device is ...`, `wait ...`) before a `check` mark keep the timestamps honest.

## Notes

- `--offset` subtracts recording start latency (usually 0.3-1s) from every mark
- `--hide-touches` is faster and more reliable for gesture-heavy simulator runs; drop it when taps should be visible
- Serving: `serve-dir.mjs` (loopback, Range so video seeks) behind one `tailscale serve --http=8790` mapping. The Mac App Store tailscaled can't serve folders directly. Other `tailscale serve` mappings are never touched; ports via `REVIEWS_PORT` / `REVIEWS_LOCAL_PORT`
- The loopback server is a background `node` process (pid in `~/editify-reviews/.server.pid`); `serve-tailnet.sh` restarts it if it's gone (e.g. after a reboot)
- Room to build on: `review.json` per review is the data model (it carries `profile` when given); add fields there and render them in `build-review.mjs`
