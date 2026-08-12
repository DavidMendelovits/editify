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
agent. The server probes what is actually usable — whether `claude` and `codex`
are on `PATH`, whether the API keys are set — and unavailable options stay
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
signed in on your machine — the subscription pays for it, not a key.

Each loop turn spawns one CLI process with the conversation replayed and the
tool catalog attached, and the reply is parsed back into tool calls. Both CLIs
are launched isolated — no MCP servers, no user settings, none of their own
tools, in a throwaway working directory. Expect roughly 20–60 seconds and a few
cents per chat message; `EDITIFY_AGENT_CLI_MODEL` and
`EDITIFY_AGENT_CLI_TIMEOUT_MS` (default 240000) tune it. Anything in
`server/.env` is loaded at boot, so these can live there.

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
Past-video selection ──────┴──> scene/loudness metrics ─> one text-only style distillation
```

- `packages/shared` owns the Zod project document, clip/track schemas, operation union, request contracts, and duration helpers.
- `server` validates all incoming data, persists SQLite rows through boot-time migrations, performs media work through argument-safe child processes, and exposes Fastify routes with CORS for Expo web.
- `apps/mobile` contains four responsive Expo Router screens, TanStack Query server state, `expo-video` proxy playback, document upload, timeline tools, chat, and render polling.
- Undo restores the saved pre-operation snapshot, increments the current version, records an `undo` entry, and marks the original entry undone. Version-mismatched batches return HTTP 409 without partial changes.
- Style analysis sends no video to a model. ffmpeg/ffprobe extract duration, scene changes, average shot length, integrated loudness, dimensions, and orientation; only that JSON is distilled into the style brief.

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

- Projects: `POST /projects`, `GET /projects`, `GET /projects/:id`, `POST /projects/:id/ops`, `GET /projects/:id/oplog`
- Assets: `POST /assets` (multipart), metadata/original/proxy/thumbnail under `GET /assets/:id/*`
- Agent: `POST /projects/:id/chat`, `GET /projects/:id/chat`
- Styles: `POST /style-profile/analyze`, `GET /style-profile`
- Rendering: `POST /projects/:id/render`, `GET /renders/:id`, `GET /renders/:id/file.mp4`

The v1 server is intentionally single-user and local: no authentication, cloud storage, billing, or predictive analytics.
