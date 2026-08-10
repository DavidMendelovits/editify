# SPEC-WAVE2.md — Presets, batch tools, mutation deltas, transcript-space cutting

Wave 2. Read first: SPEC.md, SPEC-AGENT.md, SPEC-TRANSCRIPT.md, then
`research/social-editing-presets.md` (presets + caption rules R1–R11) and
`research/programmatic-editors.md` (Palmier findings §1, adoption list §5).
Server + packages/shared only unless a section says otherwise. Do NOT git commit.

## A. New operations (packages/shared)
Add to `operationSchema`:
- `ripple_delete_ranges` `{trackId, ranges: [{start, end}] (timeline seconds, 1–50)}` —
  atomically: merge overlapping ranges; for each range remove/split/trim intersecting clips
  on that track; shift every later clip on THAT track left by the removed length before it.
  Caption clips on caption tracks whose span falls entirely inside a removed range are
  removed too; partially overlapping captions are trimmed. Applied in `apply.ts` as ONE
  operation (one version bump, one undo step).
- `set_clip_properties` `{updates: [{clipId, volume?, speed?, transform?, start?}] (1–100)}` —
  batch patch, all-or-nothing validation.

## B. Batch tools + mutation deltas (server/src/agent)
- New tools `add_clips {trackId, clips: [clip...]}` (expands to sequential add_clip ops in
  one applyOperations call → one version bump per batch is fine via multiple ops in one
  call), `split_clips {cuts: [{clipId, at}...]}`, plus tools for the two new operations.
  Keep existing singular tools (cheap) but the system prompt must steer to batch forms.
- **Mutation deltas**: every mutating tool result becomes a structural diff instead of
  `{ok, version, tracks}`. Compute generically in the loop: snapshot doc before, diff after:
  `{ok, version, changedClips: [compact clip…] (cap 20), removedClipIds, shifted:
  [{trackId, fromSec, bySec, count}] (runs of clips moved by equal delta), notes[]}`.
  Compact clip = omit fields equal to defaults (speed 1, volume 1, no transform).
  Update system prompt: "You are told exactly what changed after every edit — do not
  re-read the project between your own edits; re-read only after an error."

## C. Transcript-space editing (server)
- `server/src/media/audio-analysis.ts`: `analyzeEnergy(path)` → one ffmpeg run
  (`astats=metadata=1:reset=1` with 0.05s window via `asetnsamples`) parsed to
  `{cellSeconds: 0.05, rmsDb: number[]}`. Store JSON on the transcripts table (new column)
  populated during transcription (and lazily for existing transcripts).
- New tool `get_timeline_transcript {}` — Palmier-style: walk video clips in timeline
  order, map each asset's words through clip in/out/speed to timeline seconds, return
  compact rows `[globalWordIndex, text, timelineStartSec]` plus sentence-level `segments`
  rows `[firstWordIndex, text, startSec, endSec]`. Global word index is the stable handle.
- New tool `remove_words {wordIndexes?: [int | [int,int]], matches?: [string], keptGapMs?:
  60|150|320 (default 150)}` (indexes from get_timeline_transcript; mutually exclusive with
  matches). Port Palmier's WordCutPlanner math (research §1.5): compute keep-ranges around
  selected word runs, keep half of keptGapMs each side, merge overlaps → emit ONE
  ripple_delete_ranges per affected track. Result note: "Word indices shifted — re-read
  get_timeline_transcript before another remove_words."
- New tool `remove_silence {minSilenceSeconds? (default 0.5), padSeconds? (default 0.15),
  protectLoudGaps? (default true)}` — gaps between consecutive timeline words ≥
  minSilenceSeconds, shrunk by padSeconds per interior edge. When protectLoudGaps: compute
  each gap's median rmsDb from the energy array (mapped through the clip); if it is within
  12 dB of the median rmsDb across word cells (speech level), the gap is a laugh/reaction —
  do NOT remove it; instead trim it to its energy peak + 0.4s if longer than 2s (research:
  standup preset). Emits ripple_delete_ranges. Returns counts {removedSec, gapsCut,
  gapsProtected}.

## D. Presets (packages/shared + server)
- `packages/shared/src/presets.ts`: encode the five presets from
  `research/social-editing-presets.md` §2 as typed constants (zod schema `presetSchema` —
  model only the fields the engine can act on today: targetDurationSec, maxShotSeconds,
  hook strategy id, silenceTrim params incl. protectRegions policies, captions (wordsPerChunk,
  chunkDurationSec, maxCharsPerSecond, verticalAnchorPct, safe areas, fontSizePct, uppercase,
  fill/stroke, emphasisColor+mode), punchIn, ending type). Keep the `// why` provenance as
  a `rationale` string per preset.
- New tools: `list_presets {}` → `[{name, description, targetContent}]`;
  `get_preset {name}` → full preset. System prompt: when the user names a style or content
  type, fetch the matching preset and follow its parameters; presets are guidance, not law.
- `caption_clip_from_transcript` gains `preset?: name` — when set, chunking/duration/casing
  and styling come from the preset's caption block (store verticalAnchorPct + fontSizePct
  into the caption style: extend captionStyleSchema with optional `anchorPct` and `sizePct`,
  keep old fields working).
- **Caption render upgrade** (`server/src/media/ass.ts`): honor anchorPct/sizePct
  (Alignment 5 middle-center with \pos, or MarginV from anchor), fontSizePct → PlayResY
  fraction; wordsPerChunk-level **active-word highlight**: when the caption chunk's words
  have known timings (pass them through from caption_clip_from_transcript via a new
  optional `words: [{w,s,e}]` field on caption style or a parallel store — pick the
  smallest schema change), emit ASS karaoke `\k` tags with SecondaryColour = preset
  emphasisColor so the spoken word highlights. Fallback (no word data): plain chunk.
- **Font**: download Montserrat Bold TTF once into `server/fonts/` (network is available:
  fetch from https://github.com/JulietaUla/Montserrat raw or Google Fonts github mirror)
  and point ASS fontsdir there; commit-friendly (font file stays untracked is fine — add
  a postinstall-safe lazy download in code: if file missing at render, download; on
  failure fall back to Helvetica). No italic fallback ever.
- Mock director v3: if the prompt names a preset or matches its targetContent
  (standup/talking head/vlog/podcast), fetch it and drive the build with its parameters:
  trim to hook, remove_silence with preset params, split to maxShotSeconds, captions via
  preset. Stays deterministic.

## D2. Gap hygiene (IMPORTANT — fixes a real observed bug)
Speed/trim changes alter a clip's timeline duration but not later clips' starts, so naive
split→set_speed sequences leave black gaps between cuts. Rules:
- New tool `close_gaps {trackId}` → repacks that track's clips sequentially from the first
  clip's start preserving order (reuse reorder_clips repack logic), returns the delta.
- System prompt: "set_speed and trim_clip change a clip's duration but never move its
  neighbors — after duration-changing edits, call close_gaps (or place clips deliberately).
  Gaps render as black frames and must always be intentional."
- Mock director: after any pace/speed pass, call close_gaps on the video track. Caption
  timing must be generated AFTER gap closing (captions map from final clip positions).
- Test: split + set_speed then close_gaps → zero inter-clip gaps, captions aligned.

## E. Tests
- ripple_delete_ranges: multi-clip removal + shift math, caption trimming, merge of
  overlapping ranges, atomic failure.
- WordCutPlanner port: half-gap retention both sides, run merging (property: total removed
  = sum of merged ranges), boundary clamps.
- remove_silence gap logic incl. a protected loud gap (synthetic energy array).
- Timeline transcript mapping through in/out/speed with multiple clips.
- Preset schema parses all five presets; caption chunking honors preset word/duration caps.
- ASS: karaoke tag generation snapshot; anchor/size math. All existing tests stay green.
