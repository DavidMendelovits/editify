# Editify — AI-first video editor

Mobile (and web) thin client for a **virtualized video editor that lives on the backend**.
Architecture modeled after palmier-io/palmier-pro: a real timeline editor whose entire
operation surface is exposed as a tool API, so the AI agent and the human UI drive the
exact same editor. The timeline document is the product.

## Monorepo layout (npm workspaces)

```
editify/
  apps/mobile/        # Expo app (iOS + Android + Expo web), expo-router, TypeScript
  server/             # Node 20+ TypeScript backend (Fastify), SQLite, ffmpeg
  packages/shared/    # zod schemas + TS types for the timeline doc and operations
```

## Core concept: the timeline document

A versioned JSON project document is the single source of truth. Everything —
the mobile UI, the chat agent, and the renderer — mutates it only through named
operations. Schema (zod, in packages/shared):

```ts
Project {
  id: string
  title: string
  format: '9:16' | '1:1' | '16:9'
  fps: number            // default 30
  duration: number       // derived, seconds
  tracks: Track[]        // video, audio, caption tracks
  version: number        // incremented on every op
}
Track { id, kind: 'video' | 'audio' | 'caption', clips: Clip[] }
Clip {
  id, assetId?: string       // reference to uploaded media (video/audio)
  start: number              // position on timeline, seconds
  in: number, out: number    // trim range within the source asset
  volume?: number            // 0..1
  speed?: number             // default 1
  text?: string              // caption clips
  style?: CaptionStyle       // caption clips: font, size, color, position, emphasis
  transform?: { scale, x, y } // crop/zoom
}
```

## Operations (the tool API — Palmier-style)

Every mutation is a named operation with zod-validated params. Applying an op
bumps `version` and appends to an op log (enables undo + agent auditability +
"what did we change" chat memory).

Required ops: `add_clip`, `remove_clip`, `split_clip`, `trim_clip`, `move_clip`,
`reorder_clips`, `set_volume`, `set_speed`, `set_transform`, `add_caption`,
`update_caption`, `remove_caption`, `set_format`, `undo`.

Server endpoints:
- `POST /projects` / `GET /projects` / `GET /projects/:id`
- `POST /projects/:id/ops`  — body: `{ ops: Operation[] , baseVersion: number }`;
  reject with 409 on version mismatch (client refetches). Returns updated doc.
- `GET /projects/:id/oplog`
- `POST /assets` — multipart upload (video/audio). On upload: probe with ffprobe
  (duration, dimensions, fps), generate a low-res H.264 proxy (max 540p) + a thumbnail
  with ffmpeg. Store on local disk under `server/data/assets/`. Serve statically.
- `GET /assets/:id` metadata, `GET /assets/:id/proxy.mp4`, `GET /assets/:id/thumb.jpg`
- `POST /projects/:id/render` — enqueue export; ffmpeg assembles the timeline
  (cuts, concat, speed, volume, captions via drawtext, scale/crop to format)
  at full resolution. `GET /renders/:id` for status + output file URL.
- `POST /projects/:id/chat` — the agent (see below). Body `{ message }`.
  Returns `{ reply, opsApplied, doc }`. Conversation history persisted per project.
- `GET /projects/:id/chat` — history.

## Style profiles

- `POST /style-profile/analyze` — accepts up to N uploaded past videos. Extract
  cheap measurable metrics per video with ffmpeg/ffprobe ONLY (no LLM watching
  video): duration, cut density via scene-change detection
  (`select='gt(scene,0.3)'`), average shot length, audio loudness (ebur128),
  dimensions/format. Persist a StyleProfile row; then one LLM text call distills
  metrics into a short natural-language style doc ("fast-punch, ~1.8s average
  shot, loud music, bold captions"). No video tokens ever sent to an LLM.
- The style doc is injected into the agent's system prompt for that user.

## The agent

- Model-agnostic provider layer in `server/src/agent/`:
  - `ANTHROPIC_API_KEY` set → Anthropic Messages API (model `claude-sonnet-5`).
  - else `OPENAI_API_KEY` set → OpenAI chat completions.
  - else → deterministic MockProvider so the whole app works offline/demo:
    parses simple commands ("add captions", "make it choppier", "trim silence",
    "speed up") into real ops with plausible parameters.
- The agent receives: system prompt (role + style doc + project doc JSON +
  the op catalog with schemas), user message, and must return JSON:
  `{ reply: string, ops: Operation[] }`. Ops are validated with zod and applied
  through the same `/ops` path (never direct doc mutation). Invalid ops → retry
  once with the validation error, then apply the valid subset.

## Expo app (apps/mobile)

Expo SDK 52+, expo-router, TypeScript, npm. Must run on iOS, Android, AND
`npx expo start --web` (react-native-web). No native custom modules — use
expo-av/expo-video for playback, expo-image-picker / DocumentPicker for upload
(file input on web).

Design language (from the Editify brand): near-black background `#0B0B0F`,
white text, accent gradient blue→purple→pink (`#2563EB → #8B5CF6 → #EC4899`),
bold geometric sans (Montserrat via @expo-google-fonts), rounded cards, purple
gradient card fills. Clean, dark, creator-focused. Lowercase wordmark "editify"
with gradient text.

Screens (expo-router):
1. `/` Home — "What are you creating today?" three format cards
   (Instagram Reel 9:16, TikTok 9:16, YouTube 16:9) → creates a project with
   that format. Below: recent projects list (thumbnail, title, duration).
2. `/style` Style profile — upload past videos, show extracted metrics +
   the distilled style doc. Progress states.
3. `/project/[id]` Editor — the main screen, three stacked zones:
   - Preview: video player playing the current timeline (play the active clip
     proxies in sequence; simple client-side sequencing is fine, no server
     round-trip per edit).
   - Timeline strip: horizontal scrollable clip blocks (thumbnail, duration),
     tap to select; selected clip gets action bar (split at playhead, trim,
     delete, volume, speed). Caption track shown under video track.
   - Chat panel: messages + input ("Describe an edit…"), shows ops the agent
     applied as chips. Optimistic UI; refetch doc after ops.
4. `/project/[id]/export` — pick resolution, trigger render, poll status,
   show download/share link when done.

State: TanStack Query for server state; keep it simple otherwise. API base URL
configurable via `EXPO_PUBLIC_API_URL` (default http://localhost:3001).

## Server tech

Fastify + TypeScript + better-sqlite3 (schema migrations run at boot), zod
validation everywhere, ffmpeg/ffprobe invoked via child_process (assume present
on PATH; check at boot and log a clear warning). Render queue: simple in-process
queue with statuses (queued/processing/done/error). Static file serving for
assets and renders. Port 3001. CORS enabled for Expo web.

## Quality bar

- `npm run typecheck` passes at root (all workspaces).
- Server: vitest tests for op application (split/trim/move math, version
  conflicts, undo) and the mock agent (message → valid ops). These are the
  money paths.
- Mobile: builds for web (`npx expo export --platform web` must succeed).
- Seed script (`server/src/seed.ts`): creates a demo project with sample
  color-bar clips generated via ffmpeg `testsrc`/`sine` so the app demos with
  zero user uploads.
- Root README: quickstart (install ffmpeg, npm install, run server, run app),
  architecture overview, op catalog table.
- .gitignore: node_modules, server/data, .expo, dist.

## Non-goals (v1)

No auth, no cloud storage, no video generation, no predictive analytics, no
payments. Single-user local deployment. Keep dependencies lean.
