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
export const LANE_GUTTER = 54;

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

/** Every time a dragged edge should magnet to: neighbouring edges, playhead, zero. */
export function snapTargets(track: Track | undefined, movingClipId: string, playhead: number): number[] {
  const edges = (track?.clips ?? [])
    .filter((clip) => clip.id !== movingClipId)
    .flatMap((clip) => [clip.start, clipEnd(clip)]);
  return [0, playhead, ...edges];
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
  const sourceTail = assetDuration === undefined ? Number.POSITIVE_INFINITY : Math.max(0, assetDuration - clip.out);
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
