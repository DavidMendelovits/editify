# Editify

Editify is an AI-first video editor with a thin Expo client and a virtualized backend timeline. The mobile UI and the chat agent use the same validated operation API; SQLite stores the versioned document, operation audit log, chat history, media records, style profiles, and render state.

## Quickstart

Requirements: Node.js 20+, npm, and `ffmpeg`/`ffprobe` on `PATH`.

```bash
# macOS
brew install ffmpeg

npm install
npm run seed
npm run dev:server
```

In another terminal:

```bash
npm run dev:mobile
# press i, a, or w for iOS, Android, or web
```

The API defaults to `http://localhost:3001`. Set `EXPO_PUBLIC_API_URL` before starting Expo when the server is on another host (for example, your computer's LAN address when using a physical phone). Uploaded originals, generated proxies/thumbnails, the SQLite database, and rendered masters live under `server/data/` and are intentionally gitignored.

No model key is required. The deterministic mock agent supports prompts such as “add captions,” “make it choppier,” “trim silence,” and “speed this up.” Set `ANTHROPIC_API_KEY` to use Anthropic Messages or `OPENAI_API_KEY` to use OpenAI Chat Completions. Anthropic takes precedence when both are present.

### Choosing the model in the app

The provider chip at the top of the chat dock switches which model runs the
agent. The server probes what is actually usable, checking whether `claude` and
`codex` are on `PATH` and whether the API keys are set. Unavailable options stay
listed but disabled with the reason. The choice is stored in the `settings`
table and applies to the next message; no restart.

```
GET /agent/provider   → { active, requested?, options: [{ id, label, available, detail }] }
PUT /agent/provider   { "provider": "claude-cli" }
```

`requested` appears when a saved choice has stopped being usable (key removed,
CLI uninstalled) and something else is running in its place. `EDITIFY_AGENT_CLI=claude`
(or `codex`) still sets the boot default for a server nobody has configured
through the UI.

### Driving the agent with a local CLI

`claude-cli` and `codex-cli` run the agent on the
[Claude Code](https://claude.com/claude-code) or Codex CLI already installed and
signed in on your machine: the subscription pays for it, not a key.

Each loop turn spawns one CLI process with the conversation replayed and the
tool catalog attached, and the reply is parsed back into tool calls. Both CLIs
are launched isolated, with no MCP servers, no user settings, and none of their
own tools, in a throwaway working directory. Expect roughly 20–60 seconds and a
few cents per chat message; `EDITIFY_AGENT_CLI_MODEL` and
`EDITIFY_AGENT_CLI_TIMEOUT_MS` (default 240000) tune it. Anything in
`server/.env` is loaded at boot, so these can live there.

## Deploying

The `Dockerfile` builds the Expo web client and serves it from Fastify's own
origin, so one container is the whole product: API, media, and browser client on
a single URL. It needs ffmpeg (in the image) and a persistent disk: SQLite,
uploaded originals, proxies, and rendered masters all live under
`EDITIFY_DATA_DIR`, and losing it loses every project.

`fly.toml` is set up for that: a 4GB `shared-cpu-4x` machine with a volume on
`/data`. Use `fly scale vm performance-2x` when ffmpeg renders start dragging.
Change `app`, `primary_region`, and
`PUBLIC_BASE_URL` to match your deployment, then:

```bash
fly launch --no-deploy --copy-config
fly volumes create editify_data --size 20
fly secrets set EDITIFY_TOKEN="$(openssl rand -hex 24)"
fly deploy
```

Machines do not auto-stop: renders keep running after the HTTP request that
started them returns, and a suspended machine would abandon them mid-encode.

### Auth

`EDITIFY_TOKEN` is one shared password guarding every route except `/health`.
When it is unset, which is the default and what local development wants, the
server is open;
**set it anywhere the server is reachable from the internet**, or strangers can
upload video and run renders on your machine. It is accepted three ways, because
three kinds of client ask differently: `Authorization: Bearer` from the app's
own fetches, HTTP Basic so a browser prompts once and then carries the header
itself on `<video>`/`<img>` loads, and `?k=` for the native media players that
cannot set headers at all.

### Account deletion

`DELETE /account` erases the caller's projects, media, reports and Supabase
login, which is App Store guideline 5.1.1(v), reached from "delete account" on
the home screen. It needs the project's service-role key, which is read per request, so
a server without one still boots and simply answers 503:

```bash
fly secrets set SUPABASE_SERVICE_ROLE_KEY=...
```

The key is in the Supabase dashboard under Project Settings → API. It bypasses
every row-level policy, so it belongs in `fly secrets` and nowhere else: never
in the client, `fly.toml`, or this repository.

`EDITIFY_NO_AUTH=1` disables auth entirely, for local agent testing, so
scripted clients need no token even when `SUPABASE_URL` is set. It is ignored
whenever `NODE_ENV=production` or `FLY_APP_NAME` is present, so it cannot open
a deployed server.

The browser client needs no configuration: it is same-origin, so the Basic prompt
covers it. A phone running Expo Go against the deployed server needs both:

```bash
EXPO_PUBLIC_API_URL=https://editify-dm.fly.dev EXPO_PUBLIC_API_TOKEN=<token> npm run dev:mobile
```

Providers: `claude-cli` and `codex-cli` are not in the image, so a deployed
server needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (`fly secrets set`) or it
quietly falls back to the offline mock agent.

## Useful commands

```bash
npm run typecheck                  # all workspaces
npm test -w @editify/server        # server Vitest suite
npm run seed                       # local color-bar demo project
npm run dev:server                 # Fastify on port 3001
npm run dev:mobile                 # Expo development server
cd apps/mobile && npx expo export --platform web
```

## Architecture

```text
Expo Router client ──┐
                     ├── validated Operation[] ──> ProjectStore ──> SQLite doc + op log
Chat model provider ─┘                                  │
                                                       ├── proxy playback assets
Upload ─> ffprobe ─> ffmpeg proxy + thumbnail           └── ffmpeg full-resolution render queue
                           │
Past-video selection ──────┴──> ffmpeg metrics ─> video analyzer (pluggable) ─> template ─> style brief
```

- `packages/shared` owns the Zod project document, clip/track schemas, operation union, request contracts, and duration helpers.
- `server` validates all incoming data, persists SQLite rows through boot-time migrations, performs media work through argument-safe child processes, and exposes Fastify routes with CORS for Expo web.
- `apps/mobile` contains four responsive Expo Router screens, TanStack Query server state, `expo-video` proxy playback, document upload, timeline tools, chat, and render polling.
- Undo restores the saved pre-operation snapshot, increments the current version, records an `undo` entry, and marks the original entry undone. Version-mismatched batches return HTTP 409 without partial changes.
- Style analysis is a four-step pipeline (`server/src/style/pipeline.ts`): ffmpeg measures every video, a pluggable analyzer watches each one and returns a structured observation, the observations fold into one template, and the chat provider distills that into the brief. See [Learn my style](#learn-my-style).

## Learn my style

"Learn my style" turns a handful of a creator's videos into a reusable editing
template plus a one-paragraph brief that every edit conversation is given. The
workflow follows the pattern-recognition prototype: measure, watch, aggregate,
distill. Sourcing videos (an upload today, a scraper later) and storing the
result sit outside the pipeline, so it runs the same from a route, a test, or a
script.

```
videos ─> measure (ffmpeg: cuts, shot length, loudness, format)
       ─> watch   (VideoAnalyzer: one structured observation per video)   <- pluggable
       ─> aggregate (medians, modes, tag counts -> StyleTemplate)
       ─> distill (chat provider writes the brief; local fallback if none)
```

The watch step is a black box behind one interface, `VideoAnalyzer` in
`server/src/style/analyzer.ts`: given a video path and its ffmpeg metrics,
return whatever sections of the observation you can fill (pacing, hook,
captions, transitions, audio, visuals, text, tags). Everything else in the
pipeline is indifferent to what is behind it. Built-in analyzers:

| id | What it does | Enabled by |
|---|---|---|
| `gemini` | Uploads each video to the Gemini Files API, waits for processing, asks for structured JSON, deletes the upload | `GEMINI_API_KEY` (model via `GEMINI_MODEL`, default `gemini-3.6-flash`) |
| `webhook` | Posts each video as multipart (`video` file + `input` JSON with the metrics) to your own service and reads the observation from its JSON reply | `EDITIFY_STYLE_ANALYZER_URL` (optional bearer `EDITIFY_STYLE_ANALYZER_TOKEN`) |
| `ffmpeg` | No model at all; the metrics become the observation and the brief says nothing was watched | always |

The active analyzer is the stored UI choice when usable, else
`EDITIFY_STYLE_ANALYZER`, else the first available one in the order above.

```
GET /style/analyzer   → { active, requested?, options: [{ id, label, available, detail, watches }] }
PUT /style/analyzer   { "analyzer": "webhook" }
POST /style-profile/analyze   { assetIds, name?, analyzer?, refresh? }
```

`analyzer` overrides the choice for one run; `refresh` ignores the cache.
Observations are cached per asset and analyzer version in
`video_observations`, so building a second profile from the same clips, or
retrying after a crash, does not watch them again. Bump an analyzer's `version`
whenever its prompt or model changes and the cache misses on purpose.

To build your own analyzer out of local functions instead of a model, chain
steps with `composeAnalyzer` and register it; each step sees the input and what
the earlier steps produced, and its result is merged in:

```ts
import { composeAnalyzer, StyleAnalyzerRegistry } from './style/index.js';

const local = composeAnalyzer({
  id: 'local-chain', label: 'Local shot + caption pass', watches: true,
  steps: [
    async ({ path, metrics }) => ({ pacing: { rhythm: metrics.averageShotLength < 2 ? 'fast-punch' : 'balanced' } }),
    async ({ path }) => ({ captions: { present: await hasBurnedInText(path), position: 'bottom' }, tags: ['ocr'] }),
  ],
});
registry.register(local);
```

Before trusting a new analyzer or key in production, run the pipeline against a
real clip from your machine; it prints every stage, the observations, the
template, and the brief:

```bash
GEMINI_API_KEY=... npm run style:smoke -- path/to/clip.mp4
npm run style:smoke -- --analyzer webhook --no-distill clip.mp4
```

Any object with the same shape works too, so a second model vendor is one class
implementing `analyzeVideo`. The Gemini and webhook classes take an injectable
`fetchImpl`, and `server/test/style-pipeline.test.ts` shows both exercised
offline.

## Audio sync

A second recording of the same moment (a voice memo from a phone in the
performer's pocket, a lav, another camera) lines up under a video by matching
it against the video's own sound. `server/src/media/sync.ts` does it in two
stages: a 10ms onset-envelope cross-correlation over every possible offset, then
GCC-PHAT on raw samples within 50ms of that answer, which stays sharp through
room reverb. The fine match runs early and late in the overlap; when the two
recorders' clocks drift more than a frame apart, the memo gets a tiny speed
correction (for example 1.00006x). A match that does not clearly stand above the
noise floor is refused rather than guessed.

```
GET /projects/:id/sync?audioClipId=…[&videoClipId=…]
  → { ok: true, ops, offsetSec, speed, driftMs?, confidence, pieces, notes }
  | { ok: false, error }
```

The route only measures; the editor applies `ops` through its own op chain, so
one undo takes the sync back. The agent's `sync_audio` tool does both in one
step ("sync the memo to the video" works on the offline mock too). Every clip
cut from the same footage gets its own matching memo piece, trimmed to the shot.
Levels are left alone: the camera's own audio keeps playing until you turn it
down. Measuring reads the originals because that is what the render cuts from.

In the app, an audio file imported into a project that has footage lands on the
audio track and syncs on arrival; the Inspector's SYNC control re-runs it for a
selected audio clip.

### Share sheet

The iOS share extension and Android intent filters come from
[`expo-share-intent`](https://github.com/achorein/expo-share-intent), configured
in `app.json` to accept video and audio. Its stock iOS extension has no audio
branch, and a Voice Memos recording can arrive typed only as audio, so
`plugins/with-share-audio.js` patches one in at prebuild. Shared media goes into
the project whose editor is open, or a new project when none is.

This is native code, so it needs a new build (`eas build`), not an OTA update,
and it does not run in Expo Go. EAS provisions a second target,
`com.editify.app.share-extension`, and both targets need the
`group.com.editify.app` App Group; EAS syncs that capability when it manages the
credentials.

## Operation catalog

All mutations are posted to `POST /projects/:id/ops` as `{ "ops": Operation[], "baseVersion": number }`. A batch is transactional.

| Operation | Parameters | Effect |
|---|---|---|
| `add_clip` | `trackId`, `clip` | Adds a validated video/audio clip to an existing track. |
| `remove_clip` | `clipId` | Removes a non-caption clip. |
| `split_clip` | `clipId`, absolute timeline `at`, optional `newClipId` | Splits source in/out math correctly at the timeline playhead. |
| `trim_clip` | `clipId`, optional `in`/`out` | Changes source trim points while preserving timeline position. |
| `move_clip` | `clipId`, `start`, optional `trackId` | Moves a clip in time and optionally between same-kind tracks. |
| `reorder_clips` | `trackId`, complete ordered `clipIds` | Reorders and packs the track sequentially. |
| `set_volume` | `clipId`, `volume` (0–1) | Sets clip gain. |
| `set_speed` | `clipId`, `speed` (0.1–8) | Sets playback rate and recalculates timeline duration. |
| `set_transform` | `clipId`, `{ scale, x, y }` | Sets crop/zoom transform. |
| `add_caption` | `trackId`, text `clip` | Creates or appends to a caption track. |
| `update_caption` | `clipId` plus text/timing/style fields | Updates a caption. |
| `remove_caption` | `clipId` | Removes a caption clip. |
| `set_format` | `format` | Changes output canvas to 9:16, 1:1, or 16:9. |
| `undo` | `{}` | Reverts the latest non-undone mutation using its stored snapshot. |

## API summary

- Projects: `POST /projects`, `GET /projects`, `GET /projects/:id`, `POST /projects/:id/ops`, `GET /projects/:id/oplog`, `GET /projects/:id/sync`
- Assets: `POST /assets` (multipart), metadata/original/proxy/thumbnail under `GET /assets/:id/*`
- Agent: `POST /projects/:id/chat`, `GET /projects/:id/chat`
- Styles: `POST /style-profile/analyze`, `GET /style-profile`, `GET /style-profiles`, `GET`/`PUT /style/analyzer`
- Rendering: `POST /projects/:id/render`, `GET /renders/:id`, `GET /renders/:id/file.mp4`

The v1 server is intentionally single-user and local: no authentication, cloud storage, billing, or predictive analytics.
