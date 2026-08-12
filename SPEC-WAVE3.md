# SPEC-WAVE3.md — Caption overlap fix, filmstrips, and the real editor UI

Wave 3. Read first: SPEC.md, SPEC-AGENT.md, SPEC-WAVE2.md. Do NOT git commit.
Two independent workstreams: §A+§B are server-side; §C is the Expo app.

## A. Caption overlap fix (server + packages/shared) — REAL OBSERVED BUG
Users see captions rendered on top of each other. Three causes, fix all three:

1. **Chunk min-duration extension overlaps the next chunk.**
   `chunkTranscriptForClip` (server/src/agent/tools.ts) extends short chunks to
   `minDurationSec` (`end = max(mappedEnd, start + minDuration)`) without clamping
   against the NEXT chunk's start. Fix: after building all chunks, walk sorted
   chunks and clamp `end_i = min(end_i, start_{i+1} - 0.001)`; drop any chunk
   whose duration collapses below 0.15s. Postcondition (add as a property test):
   for sorted chunks, `start_{i+1} >= start_i + duration_i` always.
2. **Re-captioning stacks new chunks on old ones.**
   `caption_clip_from_transcript` must REPLACE: before inserting, remove every
   existing caption-track clip whose timeline span intersects the target video
   clip's timeline span. Mention the removal in the mutation delta notes.
3. **Render is not defensive.**
   `generateAss` (server/src/media/ass.ts): sort caption clips by start; when
   two consecutive Dialogue events would overlap in time AND share the same
   vertical anchor (same computed alignment + same anchorPct/marginV), clamp the
   earlier event's End to the later event's Start. Different anchors (top vs
   bottom) may legitimately coexist — leave those alone.

Tests: unit tests for all three (chunk clamp property, replace semantics,
ASS clamp incl. the "different anchors untouched" case). All existing tests
stay green (`npm test` in server/).

## B. Filmstrip endpoint (server)
Timeline clip blocks need a filmstrip, not a single thumbnail.
- `GET /assets/:id/filmstrip.jpg` — lazily generated, cached beside the proxy:
  20 frames sampled evenly across the asset duration, tiled 20x1, each frame
  160px tall (width per aspect). One ffmpeg invocation
  (`select` + `tile=20x1`). Regenerate only if the file is missing.
- Add `filmstripUrl` to the asset metadata JSON. Document geometry (20 tiles,
  ordered left→right over [0, duration]) in a comment — the client maps
  clip.in/clip.out to tile offsets.

## C. The editor UI (apps/mobile — Expo, web-first but RN-idiomatic)
Rebuild `app/project/[id].tsx` into a real editor. Reuse existing components
(AgentTrace, AgentActivity, PresetPicker, InsightsPanel, ImportSheet, Brand,
GradientButton) and `src/lib/api.ts`. Keep everything TypeScript-strict and
working on web (`npx expo start --web`, port 8081). PanResponder for drags
(works on web); no new native deps.

### Layout
- Wide (>= 1024px): three regions — preview (center-left, top), chat dock
  (right column, full height), timeline (bottom, full width under preview).
  Narrow: stacked preview → timeline → chat (current behavior's spirit).
- Project home (`app/index.tsx`): project cards (title, format badge, duration,
  clip count, first asset thumbnail) + create-new + import media. Clicking a
  card opens the editor.

### Timeline (the centerpiece)
- Time ruler with tick labels; zoom control (px-per-second, buttons or slider,
  default fitting the project duration to the viewport).
- Lanes: one per track (video lane tall with filmstrip clips, caption lane slim
  showing text chips). Clips are absolutely positioned blocks:
  `left = start * pxPerSec`, `width = timelineDuration * pxPerSec`.
- Video clip block: filmstrip background (use `/assets/:id/filmstrip.jpg`,
  crop via overflow + negative offset mapping in/out into the 20-tile strip),
  clip label, duration badge, speed badge when != 1.
- Caption chip: the text, tinted; overlapping chips (pre-fix data) render
  stacked with a warning tint so overlap is VISIBLE, not hidden.
- Interactions (all optimistic-update then `POST /projects/:id/ops`, rolling
  back on error via query invalidation — the pattern already in the file):
  - Drag block horizontally → move (`set_clip_properties` with new `start`).
    Snap (±8px) to: neighboring clip edges, playhead, t=0. While dragging show
    a ghost + a live start-time tooltip. Clamp so clips on a track never
    overlap (push is out of scope; just clamp).
  - Drag left/right edge handles → trim (`trim_clip` with new in/out mapped
    from pixels; respect asset bounds and min 0.2s duration).
  - Click selects (highlight + inspector strip: name, start, in/out, speed,
    volume; editable speed + volume via small steppers → ops).
  - Toolbar: split-at-playhead (`split_clip`), delete selected (`remove_clip`),
    close gaps (`close_gaps` via ops route if it is exposed as an operation —
    check OPERATION_CATALOG; if it is tool-only, add a tiny server route or
    compute the repack client-side as set_clip_properties batch), zoom +/-,
    undo (`POST /projects/:id/undo` if the route exists — check; omit if not).
- Playhead: vertical line over all lanes; drag it or click the ruler to seek.
  Auto-scroll timeline into view while playing.

### Preview player (timeline playback, not per-clip)
- Map playhead time → active video clip (sorted by start). Render that clip's
  proxy (`/assets/:id/proxy.mp4`) via expo-video, seeking to
  `clip.in + (playhead - clip.start) * speed`, playbackRate = speed.
  On crossing a clip boundary swap source + seek. In a gap: black frame.
- Caption overlay: absolutely positioned text matching the active caption
  clip (approximate style: size from sizePct/size, color, anchor from
  anchorPct/position, uppercase already baked into text). Karaoke highlight
  not required in preview.
- Transport: play/pause (space on web), current / total time, jump-to-start.
  Playhead advances via requestAnimationFrame or 60ms interval while playing.

### Chat dock
- Full history from `GET /projects/:id/chat` (user + assistant bubbles,
  assistant shows expandable trace via AgentTrace).
- Composer at bottom + PresetPicker chips above it.
- While the mutation is in flight show AgentActivity; on success the project
  query updates and the timeline re-renders (animate opacity on changed lane).
- Render button: existing render flow; when done show inline <video> (web) or
  link with the output URL.

### Acceptance (verify yourself before finishing)
- `npx tsc --noEmit` green in apps/mobile; the app loads on web with the
  seeded project; timeline shows real clips with filmstrips; dragging a clip
  changes its start on the server (confirm via GET /projects/:id); chat round
  trip works; preview plays across at least one clip boundary.

## D. Storage direction (doc only — no code)
Append a `## Storage` section to README.md (create if missing): local-disk
asset store today behind AssetStore; the seam for a blob backend (S3/Supabase
presigned upload, proxy/thumb/filmstrip as derived objects keyed by asset id,
CDN for proxies); mobile devices keep original footage local and upload
proxies first. Five sentences max. No implementation.
