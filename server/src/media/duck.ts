import type { Clip } from '@editify/shared';

/** A stretch of timeline seconds where a ducking clip is playing. */
export interface DuckWindow { start: number; end: number }

// ponytail: one house depth/ramp for every voiceover. Per-clip tuning would
// need schema fields, and 0.3/0.12s is the podcast default nobody argues with.
/** Everything else plays at 30% under the voice. */
const DUCK_FLOOR = 0.3;
/** Seconds of linear ramp on each edge — long enough to be inaudible, short enough to feel tight. */
const DUCK_RAMP = 0.12;

/** Filtergraph number — millisecond precision keeps float noise out of the expression. */
function n(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * The timeline windows that `duck` clips occupy, sorted and merged so back-to-back
 * voiceovers read as one continuous duck instead of dipping back up between them.
 */
export function duckWindows(clips: Clip[]): DuckWindow[] {
  const spans = clips
    .filter((clip) => clip.duck)
    .map((clip) => ({ start: clip.start, end: clip.start + (clip.out - clip.in) / (clip.speed ?? 1) }))
    .sort((left, right) => left.start - right.start);
  const merged: DuckWindow[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * A `volume` expression that holds 1.0 outside the windows and `DUCK_FLOOR`
 * inside them, crossing over a `DUCK_RAMP` linear ramp on each edge.
 *
 * A `volume` envelope rather than `sidechaincompress`: the windows are known
 * exactly from the timeline, so the bed drops by the same amount every render
 * regardless of how loud the voice actually was — which is what "duck to 30%"
 * means and what volumedetect can check. A compressor's reduction tracks the
 * sidechain level instead, and it would cost an `asplit` plus a second `amix`.
 */
export function duckExpression(windows: DuckWindow[]): string {
  const envelope = windows
    .map(({ start, end }) => (
      // Rising edge × falling edge: 1 inside the window, 0 a ramp outside it.
      // The rise is clamped at 0 so a window at the head never emits `t--0.12`.
      `clip((t-${n(Math.max(0, start - DUCK_RAMP))})/${n(DUCK_RAMP)},0,1)` +
      `*clip((${n(end + DUCK_RAMP)}-t)/${n(DUCK_RAMP)},0,1)`
    ))
    .reduce((left, right) => `max(${left},${right})`);
  return `1-${n(1 - DUCK_FLOOR)}*${envelope}`;
}
