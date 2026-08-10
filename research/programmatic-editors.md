# Programmatic & AI video editors — what Editify should steal

Part 1 is a source read of Palmier Pro (the architecture Editify is modeled after). Parts 2–4 are web
research. Part 5 is the prioritized adoption list. Part 6 covers keyless highlight heuristics.

---

## 1. Palmier Pro — source read

`/Users/davidmendelovits/space/palmier-pro` — Swift 6 / SwiftUI+AppKit / AVFoundation, 382 files.

### 1.1 Document model — `Sources/PalmierPro/Models/Timeline.swift`

```
Timeline { id, name, fps: Int, width, height, tracks: [Track] }
Track    { id, type: video|audio, muted, hidden, syncLocked = true, clips: [Clip] }
Clip     { id, mediaRef, mediaType, startFrame: Int, durationFrames: Int,
           trimStartFrame: Int, trimEndFrame: Int, speed, volume, fadeIn/OutFrames,
           opacity, transform, crop, edgeRounding, edgeSoftness,
           linkGroupId?, captionGroupId?, multicamGroupId?,
           textContent?, textStyle?, textAnimation?, wordTimings: [WordTiming]?,
           opacity/position/scale/rotation/crop/volumeTrack: KeyframeTrack<T>?,
           effects: [Effect]?, blendMode? }
```

Five differences from Editify's `Clip` that matter:

1. **Integer frames, not float seconds.** Timeline positions are `Int` frames, `[startFrame, endFrame)`
   half-open; source positions are seconds. Tools convert, and the system prompt says outright
   *"never multiply by fps yourself"* (`Agent/Tools/AgentInstructions.swift:9-11`). Editify uses float
   seconds everywhere, so "is this cut on a frame boundary" is unanswerable and split/trim math drifts.
2. **`trimStartFrame`/`trimEndFrame` + `durationFrames`** instead of `in`/`out`:
   `sourceFramesConsumed = round(durationFrames * speed)`;
   `sourceDurationFrames = sourceFramesConsumed + trimStart + trimEnd` (`Timeline.swift:196-199`).
   Speed changes don't rewrite in/out.
3. **Group ids are first class**: `linkGroupId` (A/V pairs cut together), `captionGroupId` (a whole
   caption run restyled by one id), `multicamGroupId`. Editify has none, so a 200-caption track is 200
   unrelated clips the agent must address one at a time.
4. **`wordTimings: [WordTiming]` on the clip** — `{text, startFrame, endFrame}`
   (`Models/TextAnimation.swift:3-7`), driving per-word caption animation
   (`TextAnimation{preset, perWordFrames: Int = 6, highlight}`).
5. **Per-property keyframe tracks.** Editify has a static `transform`.

A timeline can nest inside another as a clip with `mediaType 'sequence'`. A project holds many
timelines, one active; `create_timeline(from:)` is "the versioning primitive" — duplicate, then edit
the copy ("a tighter cut", "a 9:16 version").

### 1.2 Tool surface — `Agent/Tools/ToolDefinitions.swift` (125 KB, 43 tools)

`ToolDefinitions.mcpServer = all + [manageProject]`, `.inAppAgent = all + [readSkill]` (line 1115) —
the MCP server (`http://127.0.0.1:19789/mcp`) and the in-app agent share one registry.

| Group | Tools |
|---|---|
| Timeline | `get_timeline`, `inspect_timeline`, `create_timeline`, `set_active_timeline`, `set_project_settings`, `export_project`, `manage_exports` |
| Media | `get_media`, `inspect_media`, `search_media`, `import_media`, `capture_frame`, `organize_media` |
| Clips | `manage_tracks`, `add_clips`, `insert_clips`, `move_clips`, `remove_clips`, `split_clips`, `ripple_delete_ranges`, `set_clip_properties`, `set_keyframes`, `apply_layout`, `sync_clips`, `undo` |
| **Transcript** | **`get_transcript`, `remove_words`, `remove_silence`, `detect_beats`** |
| Text / Color | `add_texts`, `update_text`, `add_captions`; `apply_color`, `apply_effect`, `inspect_color`, `denoise_audio` |
| Multicam / Gen / Meta | `manage_multicam`, `change_cam`, `get_multicam`; `list_models`, `generate_*`, `upscale_media`; `send_feedback`, `read_skill` |

**Every mutator is plural.** `add_clips(entries[])`, `split_clips`, `ripple_delete_ranges(ranges[])`.
One call = one user intent = one undo step. Their `AGENTS.md` rule: *"A tool should perform one
coherent filmmaker action… Do not force the Agent to reproduce application orchestration by chaining
low-level tools"* and *"Design tools from user intent, not from internal APIs."* Editify's tool list
is literally its `OPERATION_CATALOG` — designed from the internal op enum, the thing they warn against.

### 1.3 Mutation deltas — the token trick worth stealing

`Agent/Tools/ToolExecutor+MutationDelta.swift`. Every mutating tool returns a **diff in `get_timeline`
vocabulary**, not a fresh doc:

```json
{ "clips": [...changed, capped at 30...],
  "shifted": [{"track":1,"fromFrame":240,"by":-96,"count":14}],
  "removedClipIds": [...], "createdTracks": [...], "captionGroups": [...],
  "notes": ["Track indices shifted — re-read get_timeline"] }
```

Snapshot `{clipId → (trackId, index, start, duration)}` before, diff after. Clips whose track+duration
are unchanged and only moved are **pure shifts**; ≥3 shifts sharing `(track, delta)` compress into one
*rule* (`shiftGroupMinimum = 3`), fewer enumerate. ≥3 changed clips sharing a `captionGroupId` collapse
to one group summary. The prompt then says: *"Don't re-read between your own edits — every mutation
returns a delta… Patch your model from that."* Editify returns
`{ok, version, duration, tracks:[{id,kind,clipCount}]}` — the agent learns nothing and re-reads.

### 1.4 Compact reads

`get_timeline` **omits every field equal to its default** (speed 1, 0 dB, identity transform, zero
trims/fades); non-animating keyframe tracks are dropped, constant ones degrade to a static field.
Caption clips collapse to `captionGroups{captionGroupId, clipCount, frameRange, style, textPreview}`
unless `captionDetail:true`, then arrive as rows `[clipId, startFrame, endFrame, text]` capped at
200/group. Windowed by `startFrame`/`endFrame`. `inspect_timeline` renders **composited frames** with
the frame number burned in (`f157`) plus the visible clip ids top-down — that's visual verification.
`OverviewRenderer.swift` (`inspect_media(overview:true)`) builds **one storyboard JPEG**: sample ~120
candidates, compute a luma grid per frame, drop any whose mean grid-diff from the last kept tile is
≤ `promoteDiff = 12`, keep ≤36 tiles, 6 columns of 160×90 with timestamps burned in, q=0.7. *"Far more
coverage per token; few tiles means static footage."*

### 1.5 Transcript-first editing (the most relevant part)

**`get_transcript`** returns the transcript **of the current timeline in project frames**, not of a
source asset: it walks every clip, maps each word through that clip's trim/speed/position, and
concatenates in timeline order. *"Deleted ranges are gone by construction, so after cuts this always
reflects what's actually audible — no stale results, no per-clip frame math."*

- Words are rows `[index, text, startFrame]`; a word runs to the next word's start. `index` is a
  **stable global 0-based position in timeline order** — the handle for `remove_words` — and stays
  global even when scoped by `clipId` or paged. Speakers are run-length encoded
  `[[firstWordIndex, name], …]`. Cap 10 000 words, page via `nextStartFrame`.
- `granularity:'segments'` → sentence rows `[firstWordIndex, text, start, end]` "at a fraction of the
  tokens", each carrying `firstWordIndex` to drill back into words.

**`remove_words`** — `{words: [42, [12,18], …] | matches: ["um","uh"], cutAggressiveness}`, explicitly
"Descript-style". Refuses if indices span multiple *unlinked* tracks. Always returns *"Word indices
shifted — re-read get_transcript before another remove_words."*

**The cut math** — `Transcription/WordCutPlanner.swift`, 35 lines, copy it wholesale:

```swift
enum CutAggressiveness { case tight, balanced, loose
  var keptGapMs: Double { switch self { case .tight: 60; case .balanced: 150; case .loose: 320 } } }
static func cutRanges(words:[Word], clipStart:Int, clipEnd:Int, keepGapFrames:Int) -> [FrameRange]
```

It computes **keep ranges**, walking runs of `selected` words. For run `[k…l]`: `left` = previous
word's `endFrame` (or clipStart), `right` = next word's `startFrame` (or clipEnd), `half = keepGap/2`.
It keeps `min(runStart−left, half)` before and `min(right−runEnd, half)` after — so **the pause around
the deleted words goes too, but half the configured gap survives on each side**, the "survivors don't
end up double-spaced" behavior. Then `RippleEngine.mergeRanges`. Default `balanced` = 150 ms ≈ 2 frames
of air per side at 30 fps. `ToolExecutor+Words.swift:60` converts ms→frames then calls
`editor.rippleDeleteRangesOnTrack(...)` inside `editor.undo.perform("Remove Words (Agent)")` — **the
same domain mutation the UI uses**, one undo group.

**`ripple_delete_ranges`** is the non-word-aligned escape hatch: `{trackIndex|clipId, ranges:[[s,e]…],
units:'frames'|'seconds', ignoreSyncLockedTracks}`, framed as replacing "hand-cranked split_clips →
remove_clips → move_clips loops: pass every range at once." Overlaps merge; linked A/V partners cut on
the same span; **refuses atomically** if a sync-locked track can't absorb the shift, naming the
blocking track. `Editor/RippleEngine.swift` is ~80 portable lines.

### 1.6 Silence removal — a keyless dead-air heuristic worth copying

`Audio/Analysis/SilenceRemovalSettings.swift`: `minimumPauseSeconds` default **0.5** (range 0.25–3.0);
`speechPaddingSeconds` default **0.15** (range 0.0–0.5). `SilenceRemovalPlanner.removableMask` works on
32 ms cells: find runs of quiet-non-speech cells, drop runs shorter than `minimumPause`, then **shrink
each survivor by `speechPadding` on its interior edges** (media-boundary edges unpadded). Speech
detection is Silero VAD at 16 kHz / 512-sample chunks (`VoiceActivity.swift`, `chunkDuration = 32 ms`),
cached as a JSON sidecar keyed by `mediaRef + size/mtime`.

The part that makes it robust — `SpeechMaskStore.buildQuietNonSpeechMask:122-150`. Not an absolute gate:

```swift
private static let speechGap: Float = 0.24      // 12 dB
private static let noSpeechFloor: Float = 0.56  // absolute fallback ≈ -28 dB
quietFloor = speechPeaks.isEmpty ? noSpeechFloor
           : min(0.8, max(0.44, median(speechPeaks) + speechGap))
```

**The threshold is derived from the file's own speech level**: a non-speech run is dead air only if its
*median* level sits ~12 dB below the median of the speech cells, clamped to a band. Hence *"music beds
and loud ambience are never cut."* The most valuable keyless heuristic in the repo.

### 1.7 Other affordances

`add_captions` needs no targeting — "it finds the spoken content itself"; params include `maxWords`,
normalized `transform{centerX,centerY}`, `animation`, `highlightColor`; it returns a group summary
restyled later via `update_text(captionGroupId)`. `detect_beats` gives on-device beats/downbeats in
source seconds plus bpm and hands the agent the conversion outright:
`timelineFrame = startFrame + (B*fps − trimStartFrame)/speed` (cut on downbeats). `search_media` does
on-device semantic visual + spoken search, groups ranked independently, scores labelled *"uncalibrated
— use them for ordering only"*, hits pasted into `add_clips` as `source:[startS,endS]`. `apply_layout`
owns PIP/split/grid and the prompt bans building layouts from raw transforms. **Skills**
(`Agent/Skills/*`) are markdown playbooks fetched from `palmier-io/palmier-skills` (`catalog.json` of
`{id,name,description,sha,path}`, sha = version anchor), loaded on demand by `read_skill(id)` —
progressive disclosure for editing recipes. Export covers mp4/ProRes, Premiere `xml`, `fcpxml`,
`palmier`. The 140-line system prompt's most portable pieces: a *preference order* for cutting
(`remove_silence` → `remove_words` → `ripple_delete_ranges`; `split_clips` only inserts boundaries),
*"Edits are undoable and effectively free — don't ask permission"*, and *"One or two sentences; lead
with the outcome… never narrate steps."*

### 1.8 Palmier op surface vs Editify's

| | Palmier Pro | Editify (`packages/shared/src/index.ts`, SPEC-AGENT.md) |
|---|---|---|
| Time domain | Int frames on timeline, seconds at source | float seconds everywhere |
| Clip range | `startFrame + durationFrames + trimStart/End` | `start + in/out` |
| Batching | every mutator plural, 1 call = 1 undo | 1 op per tool call |
| Tool result | structural delta + notes | `{ok, version, duration, tracks[…]}` |
| Read shaping | defaults omitted, groups collapsed, windowed | whole doc JSON |
| Grouping | link / caption / multicam group ids | none |
| Transcript | `get_transcript` + `remove_words` + `remove_silence` | none |
| Audio analysis | Silero VAD, beats, loudness | ebur128 in style profiling only |
| Visual read-back | composited frames + storyboard sheet | none |
| Interchange | FCPXML + Premiere XML | mp4 only |
| Concurrency | in-process undo stack | optimistic `baseVersion`, 409 |

Editify's `baseVersion`/409 model is actually *better* for a multi-client server, and SPEC-AGENT A1
already hides it from the model. The gaps are batching, deltas, and the transcript/audio layer.

---

## 2. Opus Clip and the AI-clipping category

**Opus Clip's published model.** The Virality Score is **0–99** over four rubric questions: **Hook**
("does the introduction grab attention and directly relate to the main topic"), **Flow** ("does it flow
logically… with a satisfying conclusion"), **Value** ("offers value, resonates emotionally"), **Trend**
("aligned with current trends"), plus a prompt-alignment check under ClipAnything. Weightings are not
published ([help.opus.pro](https://help.opus.pro/docs/article/virality-score)); the 3.0 launch post
renames "Value" → "Engagement" ([opus.pro/blog](https://www.opus.pro/blog/opusclip-clip-different)).
Their four stages are **Analyze → Curate (ClipGenius™) → Edit → Share**, where Curate is explicitly
modeled on a human editor: *understand the whole video → segment into chapters → select the interesting
parts* ([how-does-opus-clip-work](https://www.opus.pro/how-does-opus-clip-work)). Two architecturally
interesting claims: the output short is **assembled non-contiguously** ("combines gold nuggets from
different parts" with smoothed transitions), and 3.0 added a **genre-specific curation model** (Q&A /
vlog / listicle / webinar) — a classifier upstream of the selection prompt. Boundary signals named in
[video-clipping-techniques](https://www.opus.pro/blog/video-clipping-techniques): emotional peaks in
speech, visual composition changes, topic transitions, historical performance. No thresholds, no model
names, no engineering blog. (Widely-quoted ClipAnything accuracy figures — 97/98/91/94 % — appear only
on third-party sites; do not treat them as vendor claims.)

**Competitor APIs are more informative than Opus's docs**, because they publish defaults:

| | Published parameters |
|---|---|
| [Klap](https://docs.klap.app/) | `target_clip_count` 10, `min_duration` 1, `max_duration` 180, **`target_duration` 60**, `editing_options{captions:true, reframe:true, emojis:true, intro_title:true, remove_silences:false}`, `transcription_context` ≤1000 chars. Returns **`virality_score` 0–1 plus `virality_score_explanation` (free text)** |
| [Vizard](https://docs.vizard.ai/reference/submit) | `preferLength` enum 0=auto, 1=<30 s, 2=30–60, 3=60–90, 4=90 s–3 min; `clipModel` `clip_v1`\|`clip_v2` (**v2 billed 1.25×**); `removeSilenceSwitch` 0 |
| [Submagic](https://docs.submagic.co/api-reference/magic-clips) | `minClipLength`/`maxClipLength` **15/60** s (range 15–300), `faceTracking` true. Uniquely returns **`viralityScores{shareability, hook_strength, story_quality, emotional_impact, total}`** |
| [Spikes](https://docs.spikes.studio/auto-edit) | `clip_length_request` 5–180 s; caption animation enum incl. `karaoke`, `wordLevel` true |

That **score + free-text rationale** pairing (Klap, Submagic, SendShort) is the tell: virality scoring
in this category is an LLM rubric prompt, not a trained engagement predictor.

**Open source.** [ClipsAI](https://github.com/ClipsAI/clipsai) (526★, MIT) is the only one with a
non-LLM selection path: WhisperX word timestamps → `SentenceTransformer("all-roberta-large-v1")`
sentence embeddings → **TextTiling** ([Hearst 1997](https://aclanthology.org/J97-1003.pdf), BERT
variant [arXiv:2106.12978](https://arxiv.org/abs/2106.12978)) over embeddings: cosine similarity
between pooled k-sentence windows at each gap → moving-average smoothing (`smoothing_width=3`) → depth
score `(left_peak − gap) + (right_peak − gap)` → a gap is a boundary iff depth > cutoff and ≥ both
neighbours, `cutoff_policy="high"` = `mean + stdev`. It re-runs TextTiling on *pooled segment
embeddings* to build super-clips, sweeping `k=[5,7]`→min 15 s, `[11,17]`→180 s, `[37,53,73,97]`→600 s.
Defaults `min_clip_duration=15`, `max_clip_duration=900`; dedupe drops candidates within
`|Δstart|+|Δend| < 15 s`. **No virality score at all** — coherence is the objective, far cheaper and
more honest. Its reframer uses Pyannote + PySceneDetect + MTCNN + KMeans over face boxes, then picks
the active speaker by **summed mouth-aspect-ratio change** from MediaPipe FaceMesh.

[AI-Youtube-Shorts-Generator](https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator) (4.5k★) is
the LLM-scoring archetype and publishes its prompt: a content-type classifier, then eight ranked
signals — *hook moments, emotional peaks, opinion bombs, revelation moments, conflict, quotable
one-liners, story peaks, practical value* — with hard rules ("hook lands in the first 3 seconds",
"**duration sweet spot 45–90 s**", "never cut mid-sentence"), emitting
`{title, start_time, end_time, score, hook_sentence, virality_reason}`. Constants worth copying: chunk
anything >1800 s into **1200 s windows with 60 s overlap**; over-generate `max(2n, 5)` then prune;
**dedupe candidates overlapping >50 % of their own duration, keeping the higher score**.

[artbyjazi/autoclip](https://github.com/artbyjazi/autoclip) has the best boundary logic in the
category, and directly answers §3's craft question. Two things to steal outright:

1. **Word-index addressing instead of timestamps.** Words are tagged `[index]word` in the prompt and
   the model returns `start_word_index`/`end_word_index` — *"they are the only timing signal you
   provide — do not estimate seconds."* This eliminates LLM timestamp hallucination, the most common
   failure mode in the timestamp-based clones. (Palmier's global word index is the same idea.)
2. **Three-pass boundary refinement** (`pipeline/boundaries.py`): *sentence snap* (search ±12 words for
   a sentence edge) → *duration clamp* (pull the end into `[20 s, 90 s]`, still on a sentence edge;
   drop the candidate if it can't fit) → *silence alignment* (`SILENCE_SEARCH_RADIUS_S = 0.75`,
   `SILENCE_LEAD_S = 0.12`, `SILENCE_TAIL_S = 0.28`, `SILENCE_MARGIN_S = 0.04`; fallback pads
   `0.25`/`0.35`). Their rationale: a constant pad *"clips breaths and plosives, because the gap before
   a word varies with how the speaker breathes."* Its reframer uses a **1€ filter**
   (`min_cutoff 0.6`, `beta 0.02`) with `dead_zone_px 12`, `max_velocity_px_s 260`.

For contrast, [AI-Shorts-Creator](https://github.com/NisaarAgharia/AI-Shorts-Creator) (769★) is the
ur-clone: one prompt line, no dedupe, no boundary refinement. The delta between it and autoclip *is*
the engineering. [ShortGPT](https://github.com/RayVentura/ShortGPT) (7.7k★) is not a clipper at all.

---

## 3. Transcript-first editing and silence cutting

**Descript.** Filler-word removal offers per-instance **Delete / Delete and replace with gap (a gap
equal to the spoken word's length) / Ignore (removed from audio, struck through in the transcript) /
Remove from transcript only**. The interesting one is **"Avoid harsh cuts"**: Descript *analyzes the
surrounding audio and skips any filler word that can't be removed without clipping into nearby words or
leaving an awkward cut* — an audio-domain veto on a text-domain edit
([help.descript.com](https://help.descript.com/hc/en-us/articles/10164806394509-Filler-words)).
**Shorten word gaps** is a rule, not a button: *"more than / between"* a threshold → retarget to a new
length, e.g. 200 ms
([docs](https://help.descript.com/hc/en-us/articles/10164807277453-Shorten-word-gaps)). Palmier's
`keptGapMs` ∈ {60, 150, 320} lands in the same band.

**auto-editor** ([github](https://github.com/WyattBlue/auto-editor)) is the reference silence-cutter.
Defaults: `--edit audio:threshold=0.04,stream=all` (cut below **4 % of peak loudness**, ≈ −28 dB) and
`--margin 0.2s` re-added around every kept section, with asymmetric syntax `--margin 0.3s,1.5sec`
(lead-in, tail-out). Thresholds also accept dB (`-19dB`). Also `--silent-speed`, `--video-speed`,
`--min-clip-length`, `--min-cut-length`, `--when-active`/`--when-inactive`. `--edit` is a small
**expression language** over labelled streams — `audio:`, `motion:`, `none:`, `all:`, combinable as
`(or audio:0.03 motion:0.06)`, labels 0–255 (0 = cut). It exports Premiere XML, FCP, Resolve, ShotCut,
Kdenlive — i.e. **an EDL generator that happens to ship a renderer**, exactly Editify's shape.

**ffmpeg, no models.** `silencedetect=noise=-30dB:d=0.5` (defaults `noise=-60dB`, `d=2`) prints
`silence_start`/`silence_end` to stderr; parse, invert to keep-ranges, render. `silenceremove` does it
in one pass but yields no EDL, so it's wrong for a document editor
([silencedetect](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Audio/silencedetect.html),
[silenceremove](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Audio/silenceremove.html)).
Caveat: a fixed dB gate is fragile across recordings — Palmier's speech-relative threshold (§1.6) is
strictly better and free.

**Word timestamps → frame-accurate cuts.** Raw Whisper word times come from DTW over decoder
cross-attention and land around **±500 ms**; WhisperX re-aligns with a wav2vec2 phoneme model to about
**±50 ms** (93.2 % vs 85.4 % precision at a 200 ms collar on telephone speech)
([whisperX](https://github.com/m-bain/whisperX),
[paper](https://ora.ox.ac.uk/objects/uuid:fece4192-95b7-4db8-a018-3cf728040194),
[CrisperWhisper arXiv:2408.16589](https://arxiv.org/pdf/2408.16589)). ±500 ms is 15 frames at 30 fps —
unusable for cutting, fine for search. Remotion's whisper.cpp bridge passes `--dtw` for better token
timestamps and treats `t_dtw == -1` as "no timestamp"
([to-captions.ts](https://github.com/remotion-dev/remotion/blob/main/packages/install-whisper-cpp/src/to-captions.ts)).
The craft rules that follow: pad the kept range (Palmier: half of 60/150/320 ms per side; auto-editor:
200 ms symmetric; autoclip: asymmetric 0.12 lead / 0.28 tail), **snap into the silence valley** rather
than the word boundary, snap outer edges to *sentence* boundaries, round to frames (IN down, OUT up),
crossfade audio at seams, and re-encode — stream-copy cuts snap to the nearest keyframe.

---

## 4. Programmatic composition and render architectures

**Remotion** — frame is a pure function of props and `useCurrentFrame()`; render = headless Chromium per
frame → ffmpeg. Because frames render on N independent workers (on Lambda, N machines), **determinism
is a hard requirement**: they ship a seeded `random(seed)` because `Math.random()` tears the video
([using-randomness](https://www.remotion.dev/docs/using-randomness)). `<Sequence from durationInFrames>`
maps 1:1 onto an EDL clip. Lambda chunks the frame range, renders each chunk to video **plus PCM
audio**, then concatenates — audio is carried as PCM and encoded once, because AAC priming makes
per-segment AAC concat click ([how-lambda-works](https://www.remotion.dev/docs/lambda/how-lambda-works)).
The captions primitive is worth copying verbatim:

```ts
type Caption = { text: string; startMs: number; endMs: number;
                 timestampMs: number | null; confidence: number | null };
```

— **one Caption per word**, with line grouping as a downstream, re-runnable transform:
`createTikTokStyleCaptions({captions, combineTokensWithinMilliseconds})` emits *pages* whose tokens keep
their own `fromMs`/`toMs` (page = layout, token = active-word highlight)
([Caption](https://www.remotion.dev/docs/captions/caption),
[createTikTokStyleCaptions](https://www.remotion.dev/docs/captions/create-tiktok-style-captions)).

**Motion Canvas** is the contrast case: a scene is a generator, `yield` = "this frame is ready", so the
timeline *is* a coroutine's execution trace and seeking means replaying — hostile to chunked rendering
and to a serializable JSON doc. Remotion's random-access model is the right one for Editify.

**OpenTimelineIO** — `Timeline → Stack → Track → {Clip | Gap | Transition}`, every object tagged
`"OTIO_SCHEMA": "Clip.1"` (per-type versioning). Time is rational: `RationalTime{value, rate}`,
`TimeRange{start_time, duration}` — 1/24, 1/30 and especially 1/29.97 aren't representable in binary
floating point, so float seconds drift a frame across a long timeline
([spec](https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-file-format-specification.html),
[time ranges](https://opentimelineio.readthedocs.io/en/latest/tutorials/time-ranges.html)). Three ideas
beyond rational time: **transitions are siblings** in the track's child list, not clip properties, with
`in_offset`/`out_offset` for how much media each neighbour contributes; `available_range` vs
`source_range` vs `visible_range` (trim extended by adjacent transitions — the handles the renderer must
decode); and **Media Linkers**, late-binding that resolves opaque media ids to proxy/full-res/CDN URLs
at render time
([linkers](https://opentimelineio.readthedocs.io/en/latest/tutorials/write-a-media-linker.html)).

**Shotstack** is the closest commercial analogue to Editify's doc: `{timeline:{tracks:[{clips:[{asset,
start, length, fit, scale, position, transition, effect, filter, opacity, transform}]}]},
output:{format, resolution, aspectRatio, size, fps}, merge:[{find,replace}]}`
([API ref](https://shotstack.io/docs/api/),
[core concepts](https://shotstack.io/docs/guide/getting-started/core-concepts/)). Two deltas from
Editify: the **output spec lives inside the document**, and `merge:[{find,replace}]` is dead-simple
templating that turns one edit doc into a data-driven template. Also
[editly](https://github.com/mifi/editly) and
[ffmpeg-concat](https://github.com/transitive-bullshit/ffmpeg-concat), which rejects filter graphs for
transitions — *"just too complicated and error-prone"* — doing GLSL transitions at pixel level.

**ffmpeg EDL rendering.** Editify's `server/src/media/render.ts` already does the right thing: one
`filter_complex` with `trim`/`setpts=PTS-STARTPTS`/`atrim`/`asetpts`/`adelay`/`overlay`/`amix`
(`setpts=PTS-STARTPTS` is mandatory — `trim` preserves original timestamps). Limits: (a) graph size
grows with clip count and every input holds a live demuxer+decoder, so past a few dozen clips the
standard move is **segment-then-concat** — render each clip with identical encoder settings and
`-force_key_frames` at boundaries, then `ffmpeg -f concat -safe 0 -i list.txt -c copy`; (b) the concat
**demuxer** stream-copies and supports `inpoint`/`outpoint`/`duration` — a primitive EDL in its own
right — while the concat **filter** re-encodes ([wiki](https://trac.ffmpeg.org/wiki/Concatenate),
[mpegflow](https://www.mpegflow.com/recipes/concatenate-video-files)); (c) transitions straddle
boundaries, so render each `xfade` as its own segment. `xfade` takes absolute `offset` (chaining N clips
needs `offset_k = Σd₀…d_{k-1} − k·T`) while `acrossfade` has *no* offset, so audio and video transition
chains are built differently ([xfade](https://ffmpeg.org/ffmpeg-filters.html#xfade)).

For captions, `drawtext` — what Editify uses — needs **one filter instance per styled span** (~180 for
60 s of word-by-word captions), with no wrapping, no per-word styling, brutal escaping. libass renders a
whole track in one instance and supports karaoke tags: `{\k<cs>}` per word in **centiseconds**, `\kf`
sweep fill, `\kt` for absolute starts (inter-word gaps stay exact instead of accumulating rounding
error), `\t()` for scale pops ([ASS guide](https://github.com/libass/libass/wiki/ASS-File-Format-Guide),
[Aegisub tags](https://aegisub.org/docs/latest/ass_tags/)). Remotion token timings map straight on: a
page = one Dialogue event, each token = `{\k<round((toMs−fromMs)/10)>}text`. Gotchas: ASS colours are
`&HAABBGGRR`, and `subtitles=…:original_size=` matters when you scale.

**Auto-reframe to 9:16.** Google's AutoFlip is the reference algorithm
([blog](https://opensource.googleblog.com/2020/02/autoflip-open-source-framework-for-intelligent-video-reframing.html)):
shot-detect first → per-frame face/object detection with importance weights → **camera path
optimization** picking the least-motion mode that still covers salient content (stationary / panning /
tracking) → letterbox fallback. Adobe's Auto Reframe makes the same choice as OTIO — it emits **editable
Motion keyframes** rather than baking the crop
([docs](https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/add-auto-reframe-effect-to-a-sequence.html)).
OSS recipe ([auto-vertical-reframe](https://github.com/KazKozDev/auto-vertical-reframe),
[Autocrop-vertical](https://github.com/kamilstanuch/Autocrop-vertical),
[smartcrop.js](https://github.com/jwagner/smartcrop.js)): scene-detect, sample every 3–10 frames, score
face > person > salient blob, smooth the crop-center trajectory (EMA α ≈ 0.05–0.2, better a 1€/Kalman
filter), add a **dead zone** plus a max px/frame slew limit, **reset state at every shot boundary**,
then emit a per-shot static `crop=` or keyframes via `sendcmd` on a named instance
(`sendcmd=f=crop.cmd,crop@cam=w=608:h=1080:x=512:y=0`) since crop's x/y/w/h are commandable.
`cropdetect` finds *black bars*, not subjects — a pre-pass, not auto-reframe, and often miscited.

---

## 5. What Editify should adopt — prioritized (8 items)

**⚡ = high leverage, low effort.**

**1. ⚡ Return mutation deltas, not `{ok, version}`.** *Why:* the agent re-reads `get_project` after
edits, burning the context the 24-iteration loop needs. *Sketch:* in `server/src/agent/tools.ts`,
snapshot `Map<clipId,{trackId,start,dur}>` before `projects.applyOperations`, diff after, return
`{version, clips:[changed], shifted:[{trackId,fromSec,by,count}], removedClipIds, notes}`. Compress ≥3
equal shifts into one rule, cap changed clips at 30. Port `MutationDelta.swift` almost literally, and
add to the system prompt: "patch your model from the delta; re-read only after a failure." ~80 lines,
no schema change.

**2. ⚡ Batch every operation tool.** *Why:* a 20-clip assembly is 20 round trips and 20 undo entries;
Palmier's rule is one call = one filmmaker action. *Sketch:* `operationBatchSchema` already exists. Add
plural tools — `add_clips({entries:[…]})`, `split_clips({cuts:[{clipId,at}]})`, `remove_clips({clipIds})`,
`set_clip_properties` collapsing `set_volume`/`set_speed`/`set_transform` — each executing
`applyOperations(projectId, ops[], version)` as **one** version bump and one oplog entry. Validate the
whole batch up front ("one bad entry rejects the whole call with no partial state"). Keep the singular
ops as internal vocabulary; just stop exposing them 1:1.

**3. Transcript-derived cut list: ASR once per asset + a timeline-space `get_transcript`.** *Why:* it
unlocks filler removal, quote-finding, highlight selection and captions from one artifact, and it is
what every tool in §2/§3 is built on. *Sketch:* on ingest (`server/src/media/process.ts`, beside the
proxy/thumbnail) extract 16 kHz mono wav and run whisper.cpp/faster-whisper **with word timestamps**
(`--dtw` if available); store `words:[{text,start,end}]` in an `asset_transcripts` table keyed by
assetId. Add `get_transcript()` that walks `project.tracks` in timeline order, maps each word
(`t_timeline = clip.start + (w.start − clip.in)/speed`), filters to `[clip.in, clip.out]`, and returns
rows `[index, text, start]` with a **stable global index**, plus `granularity:'segments'` for cheap
reading. Derive it from the *timeline*, not the asset, so it's never stale after a cut. Pair with
`remove_words({words:[i|[i,j]], cutAggressiveness})` implementing `WordCutPlanner.cutRanges` verbatim
(keptGapMs 60/150/320), emitting a batch of trim/split/move ops in one version bump.

**4. ⚡ `remove_silence` with a speech-relative threshold — no ASR needed.** *Why:* highest
value-per-line here, and pure ffmpeg. *Sketch:* `ffmpeg -i asset -af
"astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level" -f null -` at ~30 ms
granularity gives a per-cell RMS array; cache it per asset. Compute
`speechFloor = median(RMS of cells above a coarse gate) − 12 dB`, clamp to [−45, −28] dB (Palmier's
`speechGap` / `noSpeechFloor`). Mark runs below it, drop runs shorter than `minimumPause` (0.5 s),
shrink each survivor by `speechPadding` (0.15 s) on interior edges, ripple-delete. Expose both
parameters as overridable. Silero VAD via onnxruntime later slots in behind the same planner.

**5. Frame-domain timeline (integer frames or rational time).** *Why:* float seconds make frame-accurate
cutting and idempotent split/trim impossible to reason about; Palmier and OTIO independently arrived at
the same fix, and OTIO's 1/29.97 argument is the rigorous version. *Sketch:* least invasive — keep
seconds on the wire but **quantize on write**: in `server/src/operations/apply.ts`, round every
`start`/`in`/`out` to `Math.round(x*fps)/fps` and document that tools accept seconds and snap. The
fuller `startFrame/durationFrames/trimStartFrame` migration means touching `render.ts` and the mobile
timeline strip together. This is the one non-cheap item, which is why it sits below the transcript work.

**6. Highlight selection as a two-stage tool pair — addressed by word index, not seconds.** *Why:* this
is the Opus Clip product, and §2 shows exactly how to make it not hallucinate. *Sketch:*
`find_highlights({assetId, count, targetDuration})` returns candidates **without mutating**. Feed the
model the transcript with `[i]word` index tags and require `start_word_index`/`end_word_index` back
(autoclip's trick) — never seconds. Chunk >1800 s into 1200 s windows with 60 s overlap; over-generate
`max(2n,5)` then prune; dedupe candidates overlapping >50 % of their own duration, keeping the higher
score; target 45–90 s. Refine boundaries in three passes: sentence snap (±12 words) → duration clamp →
silence alignment against item 4's RMS map (lead 0.12 s / tail 0.28 s, fallback 0.25/0.35). The agent
then calls `add_clips` with the chosen ranges. Label the score "model's guess, ordering only", as
Palmier labels its search scores *"uncalibrated"*. A no-key fallback is §6's energy heuristic.

**7. ⚡ Caption groups + word timings on caption clips.** *Why:* restyling 200 captions is 200 ops today,
and per-word highlighting is impossible. *Sketch:* add `captionGroupId?: string` and
`wordTimings?: {text,start,end}[]` to `clipSchema` — one entry per **word**, Remotion's `Caption` shape,
with paging into caption clips as a derived transform (`maxWords`, or Remotion's
`combineTokensWithinMilliseconds`). `add_captions()` transcribes the timeline and returns **one group
summary** `{captionGroupId, clipCount, range, style, textPreview}`; `update_caption` accepts a
`captionGroupId` to restyle the run in one call; `get_project` collapses ≥3 same-group caption clips into
that summary. On render, emit an ASS file with `\k`/`\kt` karaoke tags and burn it with one `subtitles`
filter instead of stacking N `drawtext` filters — that also fixes the O(N) filter chain in `render.ts`.

**8. Cheap visual read-back: `get_storyboard` + `render_preview_frame`.** *Why:* the agent edits blind;
Palmier gives it both a source storyboard and composited timeline frames. *Sketch:*
`ffmpeg -i proxy.mp4 -vf "select='gt(scene,0.15)',scale=160:90,tile=6x6,drawtext=…" -frames:v 1`
produces the contact sheet in one command — Editify already uses scene detection for style profiling.
Return it as an image content block plus the timestamp list, and tell the agent "few tiles means static
footage". `render_preview_frame({at})` renders one composited frame through the existing `render.ts`
graph. Do this after 1–4; it's the difference between an agent that guesses and one that checks.

*Suggested order:* 1, 2, 4, 7 (all ⚡, roughly a week combined) → 3 → 6 → 8 → 5.

---

## 6. How these systems choose what to keep — and keyless heuristics for Editify

Three families of selection criterion, in increasing cost:

1. **Silence/energy** (auto-editor, Descript, Palmier `remove_silence`): keep what's loud. No model, no
   transcript. Typically removes 15–30 % of raw talking-head footage and is what users perceive as
   "tightened".
2. **Topical coherence** (ClipsAI): TextTiling over sentence embeddings finds topic boundaries; clips
   are coherent segments. No LLM at selection time, no virality model — embeddings and a cutoff.
3. **LLM virality rubric** (Opus Clip, Klap, Submagic, the clones): hook / flow / value / trend, or
   "hooks, emotional peaks, opinion bombs, quotable lines". Unfalsifiable, but it's what users ask for
   — and per §2 it is universally a *prompt*, not a trained predictor.

**Keyless heuristics Editify can run with ffmpeg alone**, all off one analysis pass at ingest, cached
beside the proxy:

```
ffmpeg -i a.mp4 -af "astats=metadata=1:reset=1,\
   ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-" -f null -   # RMS envelope
ffmpeg -i a.mp4 -af ebur128=peak=true -f null -                           # loudness, LRA
ffmpeg -i a.mp4 -vf "select='gt(scene,0.3)',metadata=print" -f null -     # scene cuts
```

- **RMS energy envelope** (~30 ms cells) → the dead-air mask of item 4, plus a per-window mean.
- **Speech-relative floor, not absolute dB** — `median(speech cells) − 12 dB`, clamped ≈ [−45, −28] dB.
  The one heuristic that survives contact with real uploads; a fixed `-30dB` gate does not.
- **Excitement score** = short-term (ebur128 momentary) loudness *above the file's own median*, smoothed
  over 3–5 s. Rank windows by 90th-percentile-minus-median within the window — that rewards *dynamics*,
  which is what "emotional peak" looks like in a waveform, not just loudness.
- **Laughter-ish bursts** — ffmpeg has no spectral-flux filter, but `highpass=f=1000` + RMS is a usable
  brightness proxy. Detector: 1–4 s runs where high-passed (>1 kHz) RMS rises >6 dB above its local
  median *while the word track says nobody is speaking*. Precision is mediocre — use it to **boost**
  candidate windows, never as the sole selector.
- **Speech density** = words/second over a sliding window. Very low is rambling or dead air; very high
  is a rushed read. Mid-high density + high loudness dynamics is the classic good-clip signature.
- **Hook lexical markers** — sentences opening a segment that contain "why", "how", "the thing nobody
  tells you", "here's what", or end in "?". A keyless approximation of Opus's Hook signal, costing
  nothing. (autoclip's rubric names the same surface forms: "The secret is…", "Nobody talks about…".)
- **Scene-cut density** (already computed for style profiles) → average shot length, usable both to match
  a user's style profile and to avoid landing a clip boundary mid-shot.

A defensible keyless composite: `score = 0.4·loudness_dynamics + 0.3·speech_density + 0.2·hook_lexical
+ 0.1·(1 − dead_air_fraction)`, over candidate windows aligned to sentence boundaries and snapped to
silence valleys. Present it as an ordering, not a prediction — following Palmier's honesty rule that
scores are *"uncalibrated — use them for ordering only."*
