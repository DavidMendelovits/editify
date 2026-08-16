# Deploy plan: getting Editify in co-founders' hands

Goal: co-founders on their own devices, using the product, this week. Not production. Not the final architecture.

## The reversal

The last two documents argued for **local-first**: originals stay on device, desktop bundles the server, nothing big touches the cloud. That is the right *product* architecture and the wrong *first deploy*.

For three trusted people testing a prototype, hosted-first is dramatically cheaper to build:

| | Hosted-first | Local-sidecar-first |
|---|---|---|
| ffmpeg binary packaging | none — `apt-get install ffmpeg` | per-platform, GPL compliance |
| Whisper packaging | none — hosted API | bundle Python or whisper.cpp + 150MB model |
| macOS code signing / notarization | none | Apple Developer account, notarytool, stapling |
| Auto-update | redeploy | Squirrel/electron-updater |
| "Try the new build" | refresh | re-download, re-install |
| Time to first co-founder session | ~2 days | ~2 weeks |

The upload cost problem that drove the local-first analysis **does not exist at this scale**. Three people shooting 30–60 second test clips is ~100–200MB each over wifi. The 4GB-4K-upload nightmare is a problem for user 1,000, not user 3.

**Build local-sidecar desktop after the product is proven, not before.** It's a swap of where the server runs, and the client already talks to it over HTTP either way — so nothing you build now gets thrown away.

## Shape of this phase

```
  iPhone (Expo Go)  ─┐
                     ├─→  Fly.io: Fastify + ffmpeg + SQLite + volume
  Browser / Electron ─┘         ├─→ Groq (Whisper)
                                └─→ Anthropic (agent loop)
```

One server, one shared bearer token, everyone's projects in one SQLite file. No users table, no multi-tenancy — co-founders share a workspace, which is arguably what you want for a demo anyway.

---

## Work items

### A. Make the server deployable (~1 day)

**A1. Auth — do this first, it is the only non-negotiable.** `~20 lines.`
Right now `POST /projects/:id/chat` runs a 24-iteration agent loop on your Anthropic key, and `app.ts:45` sets `cors: { origin: true }`. The moment this has a public IP, anyone who finds it can spend your money.

One Fastify `onRequest` hook checking `Authorization: Bearer ${process.env.EDITIFY_TOKEN}`, with `/health` exempted. Mobile and web send it from `EXPO_PUBLIC_API_TOKEN`. This is a shared password, not real auth — correct for three people, replaced before anyone else.

**A2. Whisper without Python.** `~40 lines.`
`transcript-service.ts:18` already defines `TranscriptionRunner` as an injectable function type, and `buildApp` constructs `TranscriptService` with the default. Write `runGroqTranscription` alongside `runWhisperTranscription`, select on `process.env.GROQ_API_KEY`. Keeps local dev on faster-whisper, takes Python out of the container entirely.

Groq `whisper-large-v3-turbo` is ~$0.04/hour of audio and returns word-level timestamps, which is what `transcriptResultSchema` needs. Verify the response shape maps cleanly before committing.

**A3. Force the API agent provider.** `~10 lines.`
`providers.ts` defaults to `claude-cli`/`codex-cli`, which shell out to CLIs that won't exist in a container. Set `EDITIFY_AGENT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` in the deploy env, and make the registry not offer CLI providers when they're absent.

**A4. Add prompt caching while you're in there.** `~15 lines.`
`cache_control` appears zero times in `providers.ts`. The loop resends the full conversation and 744 lines of tool definitions every one of up to 24 iterations. Marking the system prompt and tool block as cacheable cuts resent-context cost ~90%. This is the single highest-leverage cost change in the codebase and it is an afternoon.

**A5. Dockerfile.** `~15 lines.`
`node:22-slim`, `apt-get install -y ffmpeg`, `npm ci`, `npm start`. `better-sqlite3` compiles natively — either install build tools or use a non-slim base.

**A6. Environment.** `PUBLIC_BASE_URL` must be the deployed URL or every asset URL built in `asset-store.ts:71-74` points at `localhost:3001` and the mobile app silently loads nothing. `EDITIFY_DATA_DIR` to the mounted volume.

**A7. Tighten limits.** The 2 GiB multipart cap (`routes/assets.ts:99`) is larger than the disk you're renting. Drop it to ~500MB for now and show a real error in the client.

### B. Deploy (~half a day)

**Fly.io.** Dockerfile deploy, persistent volume, TLS included, no ops.

```
fly launch --no-deploy
fly volumes create editify_data --size 40
fly secrets set ANTHROPIC_API_KEY=… GROQ_API_KEY=… EDITIFY_TOKEN=…
fly deploy
```

Mount the volume at `/data`, set `EDITIFY_DATA_DIR=/data`. Size the machine for render CPU — `shared-cpu-4x` or a `performance-2x`; rendering is the only CPU-heavy thing and it's serial.

*Alternative:* a Hetzner VPS with docker-compose + Caddy is cheaper per core and more work. Fly is the right trade while the product is unproven — but note Hetzner repriced dedicated vCPU up 2–2.7× in June 2026, so the gap narrowed.

### C. Mobile — Expo Go, no build required (~2 hours)

The useful discovery: **every dependency in `apps/mobile/package.json` is a first-party Expo module** — `expo-video`, `expo-image-picker`, `expo-document-picker`, `expo-router`, `expo-font`, `expo-linear-gradient`. No custom native code. So Expo Go runs it as-is.

```
eas update --branch preview
```

Co-founders install Expo Go, scan a QR, and they're in. No EAS Build, no TestFlight review, no provisioning profiles, no Apple Developer account. Updates are `eas update` and they relaunch.

Set `EXPO_PUBLIC_API_URL` to the Fly URL — `api.ts:5` already reads it.

**Move to TestFlight when** you need it to feel like a real app (own icon, no Expo Go shell), or when you add a native module. That's the point at which `app.json` needs `ios.bundleIdentifier` and `android.package`, which it currently lacks.

### D. Desktop — the web build (~2 hours, plus an optional afternoon)

`app.json` already declares `"web": { "bundler": "metro", "output": "static" }`.

```
npx expo export -p web
```

Deploy `dist/` to Cloudflare Pages or Netlify. Co-founders get a URL.

**Expect friction here and budget for it** — this is the one item with real unknown risk:
- The timeline drag handlers (`useHorizontalDrag`, `Timeline`, `TimelineClip`) were written for touch. Verify they respond to mouse events under react-native-web.
- `expo-video` on web is less battle-tested than native. Smoke-test `PreviewPlayer` first — if it's broken, everything else is moot.

**Optional Electron wrapper:** `electron-builder` + a `BrowserWindow` loading the deployed URL. An afternoon, gives them a dock icon. Worth it only if "it's a real app" matters for the co-founder conversation — otherwise the URL is the product.

---

## Cost

| Line | Estimate |
|---|---|
| Fly machine + 40GB volume | ~$10–25/mo |
| Anthropic (agent loop, 3 users, **with** A4 caching) | ~$5–20/mo |
| Anthropic (**without** caching) | ~$50–150/mo |
| Groq Whisper | pennies |
| Storage/egress | negligible at this scale |

The caching item pays for the entire rest of the deploy.

---

## Deliberately not doing

- `asset_representations` schema — no cloud/device split yet, nothing to represent
- Resumable/multipart uploads — short clips over wifi are fine; revisit at the first lost upload
- Users, orgs, per-tenant authz — three people sharing a workspace
- Native AVFoundation/Media3 conform — server ffmpeg renders everything
- Postgres — SQLite in WAL mode outlives this phase by a wide margin
- Cloud Masters, TTLs, eviction, quotas — all of it

## Sharp edges to warn co-founders about

1. **Uploads block.** `routes/assets.ts:117` awaits Whisper transcription *inside* the POST handler. Two people importing at once will stack multi-minute latencies and the app will look hung. A2 (Groq) makes this much faster but doesn't fix the serialization — moving it to a background job is the real fix, deferred.
2. **Renders are serial and lost on restart.** `render-queue.ts` is an in-memory array with a `working` boolean. A deploy mid-render orphans the row in `processing` forever.
3. **Shared workspace.** Everyone sees everyone's assets and projects. Feature, for now.
4. **Disk fills silently.** Assets and renders grow unbounded on a fixed volume. Set a Fly disk alert.

---

## Order of execution

1. A1 (auth) — before anything is public
2. A4 (prompt caching) — an afternoon that pays for the deployment
3. A2, A3, A5, A6, A7 — the rest of deployability
4. B — deploy
5. C — mobile via Expo Go
6. D — web build; **test `PreviewPlayer` and timeline dragging first**, before investing in Electron

Realistically 2–3 days of work, with D being the only item that could surprise you.
