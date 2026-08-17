import type { Clip } from '@editify/shared';

/**
 * What one clip's stream has to do for the transitions touching it: extra
 * source material so it keeps playing under the clip that follows, plus the
 * fades that replace its plain edges. Fade times are in the clip's own
 * post-speed seconds, so they sit before its absolute timeline offset.
 */
export interface TransitionPlan {
  /** Extra SOURCE seconds appended to the clip's trim/atrim end. */
  extendSourceBy: number;
  videoFadeIn?: { d: number; alpha: boolean };
  videoFadeOut?: { st: number; d: number };
  audioFadeIn?: number;
  audioFadeOut?: { st: number; d: number };
}

const clipSeconds = (clip: Clip): number => (clip.out - clip.in) / (clip.speed ?? 1);

/**
 * Plans `clip.transition` for one video track's clips, in timeline order.
 * A `crossfade` into B borrows source frames past the previous clip's out
 * point so it keeps playing under B's alpha fade-in; a `dip` fades both sides
 * through black around the cut and borrows nothing. Timeline positions never
 * move, and clips without an entry render exactly as they do without
 * transitions.
 */
export function planTransitions(
  clips: Clip[],
  assetDurations: Map<string, number>,
  fps: number,
): Map<string, TransitionPlan> {
  const plans = new Map<string, TransitionPlan>();
  const planFor = (id: string): TransitionPlan => {
    const existing = plans.get(id);
    if (existing) return existing;
    const plan: TransitionPlan = { extendSourceBy: 0 };
    plans.set(id, plan);
    return plan;
  };
  // Butt-joined within a frame counts as adjacent; anything looser is a gap,
  // and a gap has no outgoing clip to blend with.
  const tolerance = 1 / fps + 1e-6;
  clips.forEach((clip, index) => {
    if (!clip.transition) return;
    // A transition can never outlast the clip it opens.
    const duration = Math.min(clip.transition.duration, clipSeconds(clip));
    const previous = clips[index - 1];
    const adjacent = previous && Math.abs(previous.start + clipSeconds(previous) - clip.start) <= tolerance
      ? previous
      : undefined;
    if (clip.transition.type === 'crossfade') {
      const opening = planFor(clip.id);
      opening.videoFadeIn = { d: duration, alpha: true };
      opening.audioFadeIn = duration;
      if (!adjacent) return;
      const speed = adjacent.speed ?? 1;
      // Only frames the asset actually has past the out point can be borrowed.
      // With none, the outgoing clip just cuts and the incoming one fades up
      // from the base canvas instead — reads as a fade from black.
      const headroom = Math.max(0, (assetDurations.get(adjacent.assetId ?? '') ?? adjacent.out) - adjacent.out);
      const extend = Math.min(duration * speed, headroom);
      if (extend <= 0) return;
      const closing = planFor(adjacent.id);
      closing.extendSourceBy = extend;
      // The borrowed tail fades out exactly where the clip used to end.
      closing.audioFadeOut = { st: clipSeconds(adjacent), d: extend / speed };
      return;
    }
    const half = duration / 2;
    const opening = planFor(clip.id);
    opening.videoFadeIn = { d: half, alpha: false };
    opening.audioFadeIn = half;
    if (!adjacent) return;
    const seconds = clipSeconds(adjacent);
    const out = { st: Math.max(0, seconds - half), d: Math.min(half, seconds) };
    const closing = planFor(adjacent.id);
    closing.videoFadeOut = out;
    closing.audioFadeOut = out;
  });
  return plans;
}
