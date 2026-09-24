import type { Clip, Project, Track } from '@editify/shared';
import { clipTimelineDuration, deriveProjectDuration } from '@editify/shared';

/** Shortest timeline duration a manual trim is allowed to leave behind. */
export const MIN_CLIP_DURATION = 0.2;
/** Magnet radius, in pixels, for clip edges / playhead / t=0 while dragging. */
export const SNAP_PX = 8;
export const MIN_PX_PER_SEC = 3;
export const MAX_PX_PER_SEC = 600;
/** Height of the video lane body — also the filmstrip height. */
export const VIDEO_LANE_HEIGHT = 62;
export const CAPTION_ROW_HEIGHT = 22;
/** Fixed gutter on the left of the timeline holding the lane labels. */
export const LANE_GUTTER = 60;

export function clipEnd(clip: Clip): number {
  return clip.start + clipTimelineDuration(clip);
}

export function sortClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
}

export function trackOfClip(project: Project, clipId: string): Track | undefined {
  return project.tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
}

export function findClip(project: Project, clipId: string | undefined): Clip | undefined {
  if (!clipId) return undefined;
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return undefined;
}

/** The clip under the playhead on a track, or `undefined` inside a gap. */
export function clipAt(clips: readonly Clip[], time: number): Clip | undefined {
  return sortClips(clips).find((clip) => time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6);
}

/**
 * Per-frame variants for pre-sorted lists: these run inside playhead selectors
 * ~60 times a second, so they must not sort or allocate.
 * ponytail: linear scans — clip counts are tens, not thousands.
 */
export function clipIndexAtSorted(clips: readonly Clip[], time: number): number {
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index] as Clip;
    if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) return index;
  }
  return -1;
}

/** Pool anchor: the active clip, else the clip the playhead is heading into. */
export function anchorIndexAtSorted(clips: readonly Clip[], time: number): number {
  const active = clipIndexAtSorted(clips, time);
  if (active >= 0) return active;
  for (let index = 0; index < clips.length; index += 1) {
    if ((clips[index] as Clip).start > time) return index;
  }
  return Math.max(0, clips.length - 1);
}

/** Comma-joined ids of the clips visible at `time` — a comparable signature for selectors. */
export function visibleIdsAt(clips: readonly Clip[], time: number): string {
  let ids = '';
  for (const clip of clips) {
    if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) ids += ids ? `,${clip.id}` : clip.id;
  }
  return ids;
}

/**
 * Ruler tick spacing: the smallest human-readable step that still leaves at
 * least `minPx` between labels at the current zoom.
 */
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
export function tickStep(pxPerSec: number, minPx = 74): number {
  return TICK_STEPS.find((step) => step * pxPerSec >= minPx) ?? TICK_STEPS[TICK_STEPS.length - 1] ?? 600;
}

/** `74.3` → `1:14.3`; the timeline ruler and transport both read this way. */
export function formatTimecode(seconds: number, tenths = true): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const whole = Math.floor(rest).toString().padStart(2, '0');
  return tenths
    ? `${minutes}:${whole}.${Math.floor((rest % 1) * 10)}`
    : `${minutes}:${whole}`;
}

/**
 * Every time a dragged edge should magnet to: neighbouring edges, playhead,
 * zero, and the measured beats passed in by the caller (see `beatTargets`).
 */
export function snapTargets(
  track: Track | undefined,
  movingClipId: string,
  playhead: number,
  beats: readonly number[] = [],
): number[] {
  const edges = (track?.clips ?? [])
    .filter((clip) => clip.id !== movingClipId)
    .flatMap((clip) => [clip.start, clipEnd(clip)]);
  return [0, playhead, ...edges, ...beats];
}

/** Ceiling on beat targets: a whole song of onsets is a magnet field, not a guide. */
export const MAX_BEAT_TARGETS = 200;
/** Beats this close together in timeline seconds are one target, not two. */
const BEAT_MERGE_SEC = 0.02;

/**
 * Timeline seconds of the measured audio onsets under a lane's clips: source
 * peaks mapped through each clip's `in`, `start`, and `speed`, then sorted,
 * deduped, and capped. `peaksOf` returns source-second peaks for an asset, or
 * `undefined` when nothing has been measured — this stays a pure function of
 * what it is handed.
 * ponytail: the cap keeps the first `MAX_BEAT_TARGETS` beats rather than
 * thinning across the project, so a very long timeline loses its late beats.
 */
export function beatTargets(
  clips: readonly Clip[],
  peaksOf: (assetId: string) => readonly number[] | undefined,
): number[] {
  const times: number[] = [];
  for (const clip of clips) {
    const peaks = clip.assetId ? peaksOf(clip.assetId) : undefined;
    if (!peaks) continue;
    const speed = clip.speed ?? 1;
    for (const peak of peaks) {
      if (peak < clip.in || peak > clip.out) continue;
      times.push(clip.start + (peak - clip.in) / speed);
    }
  }
  const deduped: number[] = [];
  for (const time of times.sort((left, right) => left - right)) {
    const previous = deduped.at(-1);
    if (previous !== undefined && time - previous < BEAT_MERGE_SEC) continue;
    deduped.push(time);
    if (deduped.length >= MAX_BEAT_TARGETS) break;
  }
  return deduped;
}

/** Snaps `time` to the closest target within `tolerance` seconds, else returns it unchanged. */
export function snapTime(time: number, targets: readonly number[], tolerance: number): number {
  let best: number | undefined;
  let bestDistance = tolerance;
  for (const target of targets) {
    const distance = Math.abs(target - time);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best ?? time;
}

/**
 * Keeps a moved clip inside the free space between its neighbours on the same
 * track. Pushing neighbours is out of scope — the drag simply stops.
 */
export function clampStart(track: Track | undefined, clip: Clip, desiredStart: number): number {
  const duration = clipTimelineDuration(clip);
  const others = sortClips((track?.clips ?? []).filter((candidate) => candidate.id !== clip.id));
  const before = others.filter((candidate) => clipEnd(candidate) <= clip.start + 1e-6).at(-1);
  const after = others.find((candidate) => candidate.start >= clipEnd(clip) - 1e-6);
  const lower = before ? clipEnd(before) : 0;
  const upper = after ? after.start - duration : Number.POSITIVE_INFINITY;
  return Math.max(lower, Math.min(desiredStart, Math.max(lower, upper)));
}

export interface TrimPreview { in: number; out: number; start: number }

/**
 * Left-edge trim: the visible edge moves, the clip's right edge stays nailed to
 * the timeline, so `in` and `start` travel together. Bounded by the source head,
 * the previous clip, and `MIN_CLIP_DURATION`.
 */
export function trimInPreview(track: Track | undefined, clip: Clip, deltaSeconds: number): TrimPreview {
  const speed = clip.speed ?? 1;
  const others = sortClips((track?.clips ?? []).filter((candidate) => candidate.id !== clip.id));
  const before = others.filter((candidate) => clipEnd(candidate) <= clip.start + 1e-6).at(-1);
  const floor = before ? clipEnd(before) : 0;
  const maxLeft = Math.max(0, Math.min(clip.in / speed, clip.start - floor));
  const maxRight = Math.max(0, (clip.out - clip.in) / speed - MIN_CLIP_DURATION);
  const delta = Math.max(-maxLeft, Math.min(deltaSeconds, maxRight));
  return { in: clip.in + delta * speed, out: clip.out, start: clip.start + delta };
}

/**
 * Right-edge trim: only `out` moves. Bounded by the source tail (asset
 * duration), the next clip on the track, and `MIN_CLIP_DURATION`.
 * `assetDuration === undefined` means "unknown" and locks extension — trims
 * committed past the real source end used to slip through while the asset
 * query was still loading. Pass `Infinity` for clips with no source at all
 * (stickers, captions).
 */
export function trimOutPreview(
  track: Track | undefined,
  clip: Clip,
  deltaSeconds: number,
  assetDuration: number | undefined,
): TrimPreview {
  const speed = clip.speed ?? 1;
  const others = sortClips((track?.clips ?? []).filter((candidate) => candidate.id !== clip.id));
  const after = others.find((candidate) => candidate.start >= clipEnd(clip) - 1e-6);
  const sourceTail = assetDuration === undefined ? 0 : Math.max(0, assetDuration - clip.out);
  const gapAhead = after ? after.start - clipEnd(clip) : Number.POSITIVE_INFINITY;
  const maxRight = Math.min(sourceTail / speed, gapAhead);
  const maxLeft = Math.max(0, (clip.out - clip.in) / speed - MIN_CLIP_DURATION);
  const delta = Math.max(-maxLeft, Math.min(deltaSeconds, maxRight));
  return { in: clip.in, out: clip.out + delta * speed, start: clip.start };
}

/**
 * Client-side `close_gaps`: repack a track sequentially from its first clip's
 * start, preserving order. Mirrors the server agent tool of the same name,
 * which is tool-only and has no operation in OPERATION_CATALOG.
 */
export function closeGapUpdates(track: Track | undefined): Array<{ clipId: string; start: number }> {
  const ordered = sortClips(track?.clips ?? []);
  let cursor = ordered[0]?.start ?? 0;
  const updates: Array<{ clipId: string; start: number }> = [];
  for (const clip of ordered) {
    if (Math.abs(clip.start - cursor) > 1e-9) updates.push({ clipId: clip.id, start: Number(cursor.toFixed(6)) });
    cursor += clipTimelineDuration(clip);
  }
  return updates;
}

/**
 * Ids of the inclusive run between two clips on one track, in start order —
 * what a shift-click on the timeline selects.
 */
export function clipRangeBetween(clips: readonly Clip[], anchorId: string, targetId: string): string[] {
  const ordered = sortClips(clips);
  const from = ordered.findIndex((clip) => clip.id === anchorId);
  const to = ordered.findIndex((clip) => clip.id === targetId);
  if (from === -1 || to === -1) return [targetId];
  return ordered.slice(Math.min(from, to), Math.max(from, to) + 1).map((clip) => clip.id);
}

/**
 * Bulk move: the snapped travel of the dragged clip applied to every selected
 * clip on the same track, the dragged one included. The selection shifts by one
 * common amount,
 * clamped at t=0 and clamped so no moved clip can land on a clip that is not
 * moving — the selection keeps its internal spacing and never lands in an
 * overlap, which the server rejects outright on a video track.
 */
export function bulkMoveUpdates(
  clips: readonly Clip[],
  movingIds: readonly string[],
  shiftSeconds: number,
): Array<{ clipId: string; start: number }> {
  const ordered = sortClips(clips);
  const moving = ordered.filter((clip) => movingIds.includes(clip.id));
  if (!moving.length) return [];
  const staying = ordered.filter((clip) => !movingIds.includes(clip.id));
  let lower = -Math.min(...moving.map((clip) => clip.start));
  let upper = Number.POSITIVE_INFINITY;
  for (const clip of moving) {
    const end = clipEnd(clip);
    for (const other of staying) {
      const otherEnd = clipEnd(other);
      // A clip that already overlaps this one is pre-existing damage: neither
      // bound can describe it, so it is left alone rather than freezing the drag.
      if (otherEnd <= clip.start + 1e-6) lower = Math.max(lower, otherEnd - clip.start);
      else if (other.start >= end - 1e-6) upper = Math.min(upper, other.start - end);
    }
  }
  const shift = Math.max(lower, Math.min(shiftSeconds, Math.max(lower, upper)));
  const updates: Array<{ clipId: string; start: number }> = [];
  for (const clip of moving) {
    const start = Number(Math.max(0, clip.start + shift).toFixed(6));
    if (Math.abs(start - clip.start) > 1e-9) updates.push({ clipId: clip.id, start });
  }
  return updates;
}

export interface CaptionRow { clip: Clip; row: number; overlapping: boolean }

/**
 * Lays overlapping caption clips onto stacked rows so bad data (SPEC-WAVE3 §A)
 * is visible rather than hidden behind whichever chip painted last.
 */
export function captionRows(clips: readonly Clip[]): { rows: CaptionRow[]; rowCount: number } {
  const ordered = sortClips(clips);
  const rowEnds: number[] = [];
  const rows: CaptionRow[] = [];
  for (const clip of ordered) {
    let row = rowEnds.findIndex((end) => end <= clip.start + 1e-6);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(0);
    }
    rowEnds[row] = clipEnd(clip);
    rows.push({ clip, row, overlapping: row > 0 });
  }
  return { rows, rowCount: Math.max(1, rowEnds.length) };
}

/** Optimistic edit: replaces one clip's fields and re-derives the project duration. */
export function patchClip(project: Project, clipId: string, patch: Partial<Clip>): Project {
  const tracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
  }));
  return { ...project, tracks, duration: deriveProjectDuration({ tracks }) };
}

/** Optimistic edit for a `set_clip_properties` batch of start moves. */
export function patchStarts(project: Project, updates: ReadonlyArray<{ clipId: string; start: number }>): Project {
  const byId = new Map(updates.map((update) => [update.clipId, update.start]));
  const tracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      const start = byId.get(clip.id);
      return start === undefined ? clip : { ...clip, start };
    }),
  }));
  return { ...project, tracks, duration: deriveProjectDuration({ tracks }) };
}

/** Optimistic removal of a clip from whichever track holds it. */
export function removeClip(project: Project, clipId: string): Project {
  const tracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => clip.id !== clipId),
  }));
  return { ...project, tracks, duration: deriveProjectDuration({ tracks }) };
}

/**
 * Filmstrip geometry. The endpoint tiles 20 frames left→right across
 * `[0, assetDuration]`; a clip only shows `[in, out]`, so each visible cell
 * picks the tile whose sample time is closest to that cell's source time.
 */
export const FILMSTRIP_TILES = 20;
export const MAX_STRIP_CELLS = 26;

export interface StripCell { key: string; tile: number }

export function stripCells(options: {
  width: number;
  height: number;
  clip: Clip;
  assetDuration: number;
  assetAspect: number;
}): { cells: StripCell[]; cellWidth: number } {
  const natural = Math.max(24, options.height * (options.assetAspect > 0 ? options.assetAspect : 16 / 9));
  const count = Math.max(1, Math.min(MAX_STRIP_CELLS, Math.ceil(options.width / natural)));
  const cellWidth = options.width / count;
  const duration = options.assetDuration > 0 ? options.assetDuration : 1;
  const cells = Array.from({ length: count }, (_unused, index) => {
    const sourceTime = options.clip.in + ((index + 0.5) / count) * (options.clip.out - options.clip.in);
    const tile = Math.max(0, Math.min(FILMSTRIP_TILES - 1, Math.floor((sourceTime / duration) * FILMSTRIP_TILES)));
    return { key: `${index}-${tile}`, tile };
  });
  return { cells, cellWidth };
}
