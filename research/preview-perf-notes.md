# Preview performance work — Aug 16, 2026

Branch: `DM/import-speed-agent-trace-preview-perf`. All four phases landed; types clean, 113/113 server tests pass, exercised end-to-end in the browser.

## What landed

### Phase 1 — the 60Hz hot path is gone

`apps/mobile/src/components/editor/PreviewPlayer.tsx` no longer renders per frame:

- Clip lists are sorted once per timeline change (`useMemo` on `project.tracks`); the playhead reaches the component only through coarse selectors (`clipIndexAtSorted`, `visibleIdsAt` in `lib/timeline.ts`) that re-render it at clip boundaries, never per tick.
- Per-frame consumers became tiny leaves:
  - `PoseLayer` — children-as-props wrapper for zoom/crop; an animated punch-in re-renders only the wrapper style, React bails on the identical VideoView children. Static transforms skip the per-frame subscription entirely.
  - `TransitionDip` — selector returns a steady 0 outside transition windows.
  - `CaptionOverlay` — karaoke re-renders per *word flip* (sung-word-count selector), not per frame.
  - `TransportTimecode` — the transport's only per-frame text.
- Drift correction is one clock subscription gated by the throttle **before** any `player.currentTime` read (bridge/DOM read; previously six of them per frame at 60Hz). Covers background re-parks, active drift, the lost-play self-heal, and audio.
- `TimelineClip` / `CaptionChip` / `StickerChip` / `Filmstrip` are `memo`ized with stable id-passing callbacks (`chipSelect`/`chipDragStart`/... in `Timeline.tsx` read live impls through a ref) — a drag no longer reconciles every clip's up-to-26 filmstrip `<Image>` cells per move event.
- Waveform endpoint (`server/src/routes/assets.ts`) peak-reduces envelopes to ≤2000 cells on the way out (~100KB → ≤~16KB).

### Phase 2 — timeline viewport culling

Clips, caption/sticker chips, beat ticks, and ruler ticks render only within the scroll viewport ± one screen of buffer (`cullStart` state updated with half-buffer hysteresis in `onScroll`). Selected and dragged clips always render — unmounting a chip mid-gesture kills the gesture.

### Phase 3 — scrub, pool, audio fidelity

- **Scrub posters**: while the ruler is dragged (`onScrub` prop chain: Timeline → `[id].tsx` → PreviewPlayer), the stage shows the filmstrip tile nearest the playhead (`ScrubPoster`, re-renders per tile) and video seeks are suppressed; one precise seek fires on release.
- **Adaptive pool**: `POOL_SIZE` 5 on web/desktop, 3 on native (window ±1) — each slot is a live H.264 decoder, the preview's main memory cost on device.
- **Audio mini-pool + ducking**: the single viewless audio player became a pool of 3 with sticky slot assignment, so music bed + SFX + dub all play together like the export's `amix`. A `duck` clip drops bed players *and* the video to `DUCK_FLOOR = 0.3` — the same floor `server/src/media/duck.ts` burns into the export (minus its 0.12s edge ramps). This fixed a real preview/export divergence: only the first overlapping audio clip used to be audible.

### Phase 4 — real crossfade

Crossfades preview as an actual dissolve instead of the black-dip approximation: per-slot `Animated.Value` opacities written imperatively from a clock listener (zero React renders), incoming slot ramps 0→1 across the window, outgoing player keeps rolling (muted) underneath and is paused on window exit. `crossfadeRef` coordinates with the cut effect so the boundary doesn't stomp the ramp. Dip transitions keep the dim overlay.

## Deliberately skipped (revisit only if symptoms appear)

| Item | Why skipped | Add when |
|---|---|---|
| Native proxy cache (`expo-file-system`) | New native dep + needs session-stable URI resolution to avoid mid-session reload glitches | Device testing shows repeat-play stalls over the network |
| `requestVideoFrameCallback` drift tightening | Drift thresholds exist to avoid seek-cancel loops, not measurement noise — tighter measurement wouldn't help | Sync complaints on web after profiling |
| Per-cell filmstrip culling | `MAX_STRIP_CELLS = 26` caps the cost; clip-level culling covers long projects | Never, probably |
| Reanimated (Phase 5) | No per-frame React work left beyond four tiny leaves | Device profiling shows dropped JS frames during play + drag |
| Crossfade audio volume ramps | Audio hard-switches at the cut; inaudible at typical 0.2s windows | Long crossfades become common |
| AppState background player release | OS pauses playback anyway; full decoder release needs reload plumbing | Memory pressure reports on device |

## Verification notes

- Verified in browser: playback across 12 clips with cuts (opacity flips slot-to-slot confirmed via DOM sampling), scrub poster mount/unmount + exact seek landing, duck floor (bed at 0.3 / ducker at 1.0 with both audio clips loaded simultaneously), first frame visible at 0:00.
- **Gotcha**: the Claude Code browser pane throttles rAF to ~0.5Hz when unfocused, so the wall-clock playhead jumps seconds per tick — sub-second windows (0.2s crossfade ramps, duck edges during playback) can't be observed live there. Verify them with *paused seeks into the window* (one publish = one driver tick), or eyeball in a focused browser.
- Still worth a manual pass in a focused browser: watch a crossfade dissolve at 60Hz, and profile on-device with the pool of 3.
