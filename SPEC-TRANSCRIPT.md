# SPEC-TRANSCRIPT.md — Whisper tooling + transcript intelligence

Wave 1 of the v2 upgrade: per-asset transcription (faster-whisper, local, keyless) and an
LLM insight module that interprets transcripts — hook detection, highlight scoring, impact
assessment — feeding the agent loop through new tools. Read SPEC.md and SPEC-AGENT.md first.
Server + packages/shared only. Do NOT touch apps/mobile. Do NOT git commit.

## A. Transcription service

### A1. `server/scripts/transcribe.py`
CLI: `python3 transcribe.py <mediaPath> [modelSize]`. Uses `faster_whisper` (already
installed on this machine — do not pip install). `WhisperModel(modelSize, device='cpu',
compute_type='int8')`, `transcribe(path, word_timestamps=True)`. Prints ONE JSON object to
stdout: `{"language": str, "durationProcessedSeconds": float, "words": [{"w": str, "s": float, "e": float}],
"segments": [{"text": str, "s": float, "e": float}]}` (times rounded to 2dp, words trimmed).
Warnings/logs go to stderr only — stdout must be pure JSON. Non-zero exit + stderr message on failure.

### A2. Server integration — `server/src/services/transcript-service.ts`
- Spawn `PYTHON_BIN` (env, default `python3`) with `WHISPER_MODEL` (env, default `base`).
  10-minute timeout. Parse/validate stdout with a zod schema.
- Storage: new SQLite table `transcripts` (assetId TEXT PK, language TEXT, words TEXT JSON,
  segments TEXT JSON, createdAt TEXT). Follow existing store patterns (`server/src/db/`).
- Auto-transcribe on asset import AND upload when the asset `hasAudio` — run it inline
  (imports already take seconds; acceptable), but a transcription failure must NOT fail the
  import: log a warning, asset simply has no transcript.
- Endpoints:
  - `GET /assets/:id/transcript` → stored transcript or 404 `{error: 'No transcript'}`.
  - `POST /assets/:id/transcribe` → idempotent: returns existing unless `{force: true}`;
    404 unknown asset; 422 if asset has no audio.

## B. Insight module — LLM transcript interpretation

### B1. Shared schema (packages/shared)
```ts
export const assetInsightsSchema = z.object({
  assetId: z.string(),
  hook: z.object({ start: z.number(), end: z.number(), text: z.string(),
    reason: z.string() }).nullable(),   // the 1–3s moment most likely to stop the scroll
  highlights: z.array(z.object({
    start: z.number(), end: z.number(), text: z.string(),
    score: z.number().min(0).max(1),    // impact score
    label: z.string(),                  // e.g. 'punchline', 'emotional peak', 'key claim'
  })),
  summary: z.string(),                  // one-line description of the clip's content
  generatedAt: z.string(),
});
```

### B2. `server/src/services/insight-service.ts`
Input: asset transcript (+ duration). Calls the provider. Add a `completeText(system, user)`
method to the ToolProvider interface (a single no-tools turn; trivial for all three
providers — mock implements heuristics below). Prompt the LLM with the segments + word
timings and instruct it to return JSON matching the schema (hook = the strongest scroll-stopping
moment with timestamps snapped to word boundaries; highlights = ranked impactful spans;
labels from: punchline, setup, emotional peak, key claim, question, callback). Validate with
zod; one retry with the validation error appended; on second failure store
`{hook: null, highlights: [], summary: 'Analysis unavailable'}`.
- **Mock heuristic** (deterministic, honest): hook = earliest segment that contains a
  question mark, direct second-person address ("you", "your"), or an exclamation — else the
  first segment; each segment scored by (exclamations + question marks + emotive/profane
  word count + words-per-second above the clip median), normalized to 0–1; top 3 become
  highlights labeled 'question' / 'punchline' (trailing segment with profanity/exclamation)
  / 'key claim'. Summary = first 8 words of the transcript + '…'.
- Storage: table `insights` (assetId PK, json TEXT, createdAt). Endpoints:
  `GET /assets/:id/insights` (compute-on-first-read if transcript exists, else 404),
  `POST /assets/:id/insights` with `{force?: boolean}`.

## C. Agent tools (extend `server/src/agent/tools.ts`)

- `get_transcript` `{assetId}` → `{language, segments, wordCount, words}` — words included
  but compact (`[w,s,e]` tuples are fine if described in the tool description). Error
  `{ok:false}` if none.
- `get_insights` `{assetId}` → the insights object (computing lazily like the endpoint).
- `caption_clip_from_transcript` `{clipId, wordsPerChunk?: 1|2|3|4 (default 3), style?: captionStyle}` —
  THE caption wiring. Server-side: find the video clip, require its asset's transcript,
  take words within `[clip.in, clip.out)` source range, group into chunks of wordsPerChunk
  (never split across a gap > 0.6s — start a new chunk), map each chunk to timeline time:
  `start_tl = clip.start + (chunk.s - clip.in)/(clip.speed ?? 1)`, duration = chunk span /
  speed, clamped to ≥ 0.25s and not past the clip's timeline end; emit one `add_caption`
  per chunk through the existing operation path (ids `cap-<clipId>-<n>`, replacing any
  existing captions with that prefix first via remove_caption). Default style: Montserrat,
  size 64, #FFFFFF, bottom, bold, UPPERCASE text. Returns `{ok, captionsAdded, version}`.
  Pure chunking/mapping logic must live in an exported function for unit testing.
- Update the system prompt in loop.ts: mention that transcripts and insights exist and that
  good edits trim to highlight spans and lead with the hook.
- MockToolProvider director v2 (keep deterministic): when building a cut, call
  `get_insights` per asset; prefer each asset's hook/top-highlight span (±0.3s padding,
  max 6s) instead of blind first-4-seconds; SKIP assets whose originalName starts with
  `seed-` or that have no transcript when at least 3 assets do have one; after adding
  clips, call `caption_clip_from_transcript` on each instead of placeholder captions.
  Keep the punch/speed and format behaviors.

## D. Render: ASS subtitles (replace drawtext captions)
Generate an `.ass` file from caption clips at render time (`server/src/media/ass.ts`):
Style with Montserrat Bold (locate the font file: check `~/Library/Fonts` and
`/Library/Fonts` for Montserrat*, fall back to Arial Bold — set `fontsdir` accordingly),
white text, black outline (\bord3), shadow, MarginV computed from position (bottom = 12% of
height, honoring a `safeAreaBottomPct` env default 12), centered, uppercase preserved as
given. One Dialogue line per caption clip. Replace the drawtext chain with a single
`subtitles=<file>:fontsdir=<dir>` filter (escape the path). Delete the drawtext code path.

## E. Tests (fast — never invoke real whisper or ffmpeg in tests)
- Chunking/mapping: words→chunks (gap rule, wordsPerChunk), source→timeline mapping with
  speed, clamping. Edge: clip.in mid-word, empty range.
- Mock insight heuristics: question hook detection, scoring monotonicity, empty transcript.
- ASS generation: snapshot a small doc → valid ASS with correct times (h:mm:ss.cc), margins.
- Tools: caption_clip_from_transcript happy path + no-transcript error via a seeded fake
  transcript row; get_transcript/get_insights error paths.
- Keep all existing tests green; `npm run typecheck` clean.
