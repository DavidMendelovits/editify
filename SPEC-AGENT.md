# SPEC-AGENT.md — Agentic tool-loop upgrade

Upgrade Editify's chat from one-shot JSON (`{reply, ops}`) to a real **tool-use agent loop**:
every editor operation is exposed as a first-class tool the model calls against the live
project, with results (including errors) fed back so it can observe → act → correct.
This is the Palmier pattern completed: the editor's operation surface IS the agent's tool API.

Monorepo: `packages/shared` (zod schemas), `server` (Fastify+SQLite+ffmpeg), `apps/mobile` (Expo).
Read `SPEC.md` for the existing contract. Do NOT git commit.

## A. Server — tool registry + agent loop (Codex scope)

### A1. Tool registry — `server/src/agent/tools.ts`
A `ToolDef` = `{ name, description, schema: ZodSchema, execute(ctx, input) => Promise<unknown> }`.
`ctx` carries `{ projectId, stores... }` and tracks the project's current version internally —
**the model never sees or supplies baseVersion**; the loop always applies against the latest version.

Read tools:
- `get_project` → the current project document (compact: omit nothing, it's small).
- `list_assets` → `[{id, originalName, duration, width, height, hasAudio}]`.
- `get_style_profile` → latest style doc string or `null`.

Operation tools — **one tool per operation** in `OPERATION_CATALOG` (except `undo`, still exposed:
route it through ProjectStore history like the REST path does): `add_clip`, `remove_clip`,
`split_clip`, `trim_clip`, `move_clip`, `reorder_clips`, `set_volume`, `set_speed`,
`set_transform`, `add_caption`, `update_caption`, `remove_caption`, `set_format`, `undo`.
Input schema for each = that operation's `params` schema from `@editify/shared` (reuse the zod,
convert with `zod-to-json-schema` — you may add that dependency to server). Execute =
`projects.applyOperations(projectId, [op], currentVersion)`; on success return a compact
summary `{ok: true, version, duration, tracks: [{id, kind, clipCount}]}`; on `OperationError`
or zod error return `{ok: false, error: message}` as the tool result (do NOT throw — the agent
must see the error and self-correct).

Write tool descriptions carefully — they are the agent's manual. Include units (absolute
timeline seconds for `split_clip.at` / `move_clip.start`; source-time seconds for `in`/`out`;
`speed` multiplier affects timeline duration = `(out-in)/speed`), and note that `add_clip`
requires an `assetId` from `list_assets` and a unique clip `id` (suggest the model generate
readable ids like `clip-hook-1`).

### A2. Agent loop — `server/src/agent/loop.ts`
Provider interface gains tool support:
```ts
interface ToolCallRequest { id: string; name: string; input: unknown }
interface LoopTurn { text?: string; toolCalls: ToolCallRequest[] }
interface ToolProvider { runTurn(system, messages, toolDefs): Promise<LoopTurn> }
```
Loop: build system prompt (role, style doc if present, project summary), push user message,
call provider; for each returned tool call, validate input with the tool's zod schema and
execute; append tool results; repeat until the provider returns no tool calls (final text =
reply) or **24 iterations** (then reply with a truthful "stopped early" message). Collect a
trace: `[{tool, input, ok, summary}]` in call order.

Result type (add to `packages/shared`):
```ts
export const agentTraceStepSchema = z.object({
  tool: z.string(), input: z.unknown(), ok: z.boolean(), summary: z.string(),
});
export const chatResponseSchema = z.object({
  reply: z.string(), trace: z.array(agentTraceStepSchema),
  opsApplied: z.array(operationSchema), doc: projectSchema,
});
```
`opsApplied` = the operation-tool calls that succeeded, in order (read tools excluded).

### A3. Providers — `server/src/agent/providers.ts`
- **AnthropicToolProvider**: Messages API native tool use, model `claude-sonnet-5`,
  `max_tokens 4096`, pass tools as `[{name, description, input_schema}]`, map
  `tool_use`/`tool_result` blocks. Keep conversation as proper content blocks.
- **MockToolProvider**: deterministic multi-step director so the demo works with zero keys.
  Behavior: first call `list_assets` + `get_project` + `get_style_profile`; if the prompt asks
  to build/style/make a cut and video track has no clips, `add_clip` each asset (in listed
  order, trim each to at most 4s of source, sequential `start` values, readable ids); if the
  prompt says punchy/choppy/fast, `split_clip` clips longer than 2.5s and `set_speed 1.25`;
  if captions/bold mentioned (or style doc mentions captions), `add_caption` one per video
  clip, bottom/bold/Montserrat; always end with `set_format` to `9:16` if prompt says
  vertical/9:16. Then finish with an honest reply describing what it did. It must go through
  the SAME loop/tool execution path as real providers (it emits tool calls, it does not
  shortcut the registry).
- `createProvider()`: ANTHROPIC_API_KEY → Anthropic, else mock (no key only).
  Load `server/.env` if present (dotenv or manual parse — trivial).

### A4. Chat route + persistence
`POST /projects/:id/chat` now runs the loop. Response = `chatResponseSchema`. Persist the
trace with the assistant chat message (serialize into the existing ops JSON column or add a
`trace` column — pick the smallest migration; SQLite `ALTER TABLE ADD COLUMN` is fine).
`GET .../chat` returns traces too. Keep old clients working: `opsApplied` stays.

### A5. Local media import
- `GET /assets/importable` → files in `MEDIA_IMPORT_DIR` (env, default `<repo>/test-clips`),
  `[{name, size, alreadyImported: boolean}]` (match by originalName), video files only.
- `POST /assets/import` `{name}` → validate the resolved path stays inside MEDIA_IMPORT_DIR
  (reject traversal), then run the existing ffprobe/proxy/thumbnail pipeline
  (`server/src/media/process.ts`) on that file without re-uploading. Returns AssetMetadata.
  Import is idempotent by name (re-import returns existing asset).

### A6. Tests (vitest, extend `server/test/`)
- Tool registry: every op tool validates + applies + bumps version; error path returns
  `{ok:false}` and does NOT bump version.
- Mock loop end-to-end: seed project + 2 fake assets → prompt "build a punchy vertical cut
  with bold captions" → assert trace non-empty, video clips added, captions added, format 9:16,
  doc version advanced, reply is a string.
- Import: path traversal `{name: "../secret"}` rejected 400.
Keep existing tests green. `npm run typecheck` clean at root.

## B. Mobile — agent activity UI (separate agent's scope; do not touch `server/` or `packages/`)
Contract: the chat endpoint returns `chatResponseSchema` above (`reply`, `trace[]`,
`opsApplied`, `doc`). New endpoints: `GET /assets/importable`, `POST /assets/import {name}`.

- **Editor chat panel** (`apps/mobile/app/project/[id].tsx` and components): while the request
  is in flight show an animated "agent is editing…" indicator; on response render the trace as
  a vertical step feed — one row per step: icon by tool kind (read=eye, cut=scissors,
  caption=text, speed=gauge, error=warning), tool name humanized ("Split clip at 4.2s"),
  ok/error tint (error rows red-tinted with the error text). Collapse >8 steps behind
  "show all N steps". Then the reply bubble. Keep existing suggestion chips.
- **Media sheet**: "Import test clip" — list from `GET /assets/importable` with size, tap to
  import (shows spinner; large files can take a while — do them sequentially), imported ones
  badge as "in library".
- Match the existing design system (near-black `#0B0B0F`, gradient #2563EB→#8B5CF6→#EC4899,
  Montserrat, components in `apps/mobile/src/components`). Works on web + native. Typecheck clean.

## Non-goals
No auth, no streaming/SSE (single request/response is fine), no queue, no new screens,
no renaming existing endpoints.
