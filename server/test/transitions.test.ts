import { describe, expect, it } from 'vitest';
import type { Clip } from '@editify/shared';
import { planTransitions } from '../src/media/transitions.js';

/** Defaults to a 2s slice of a source that has 8s of material to borrow from. */
function clip(overrides: Partial<Clip> & { id: string }): Clip {
  return { assetId: 'asset', start: 0, in: 0, out: 2, ...overrides };
}

const durations = new Map([['asset', 8]]);

describe('planTransitions', () => {
  it('plans nothing when no clip asks for a transition', () => {
    const plans = planTransitions([clip({ id: 'a' }), clip({ id: 'b', start: 2 })], durations, 30);
    expect(plans.size).toBe(0);
  });

  it('extends the previous clip and alpha-fades the incoming one for a crossfade', () => {
    const plans = planTransitions([
      clip({ id: 'a' }),
      clip({ id: 'b', start: 2, transition: { type: 'crossfade', duration: 0.5 } }),
    ], durations, 30);
    expect(plans.get('a')).toEqual({ extendSourceBy: 0.5, audioFadeOut: { st: 2, d: 0.5 } });
    expect(plans.get('b')).toEqual({ extendSourceBy: 0, videoFadeIn: { d: 0.5, alpha: true }, audioFadeIn: 0.5 });
  });

  it('borrows source seconds at the outgoing clip speed', () => {
    const plans = planTransitions([
      clip({ id: 'a', out: 4, speed: 2 }),
      clip({ id: 'b', start: 2, transition: { type: 'crossfade', duration: 0.5 } }),
    ], durations, 30);
    // 0.5 timeline seconds of a 2x clip is 1 source second, faded over 0.5s.
    expect(plans.get('a')).toEqual({ extendSourceBy: 1, audioFadeOut: { st: 2, d: 0.5 } });
  });

  it('clamps the extension to the material left past the out point', () => {
    const plans = planTransitions([
      clip({ id: 'a' }),
      clip({ id: 'b', start: 2, transition: { type: 'crossfade', duration: 0.5 } }),
    ], new Map([['asset', 2.25]]), 30);
    expect(plans.get('a')).toEqual({ extendSourceBy: 0.25, audioFadeOut: { st: 2, d: 0.25 } });
    // The incoming clip still fades over the full duration — it just reveals
    // the base canvas once the borrowed tail runs out.
    expect(plans.get('b')?.videoFadeIn).toEqual({ d: 0.5, alpha: true });
  });

  it('degrades to a fade from the canvas when there is no headroom at all', () => {
    const plans = planTransitions([
      clip({ id: 'a' }),
      clip({ id: 'b', start: 2, transition: { type: 'crossfade', duration: 0.5 } }),
    ], new Map([['asset', 2]]), 30);
    expect(plans.has('a')).toBe(false);
    expect(plans.get('b')).toEqual({ extendSourceBy: 0, videoFadeIn: { d: 0.5, alpha: true }, audioFadeIn: 0.5 });
  });

  it('treats a clip more than a frame after its predecessor as having no partner', () => {
    const gapped = planTransitions([
      clip({ id: 'a' }),
      clip({ id: 'b', start: 2.5, transition: { type: 'crossfade', duration: 0.5 } }),
    ], durations, 30);
    expect(gapped.has('a')).toBe(false);
    expect(gapped.get('b')?.videoFadeIn).toEqual({ d: 0.5, alpha: true });
    const touching = planTransitions([
      clip({ id: 'a' }),
      clip({ id: 'b', start: 2 + 1 / 30, transition: { type: 'crossfade', duration: 0.5 } }),
    ], durations, 30);
    expect(touching.get('a')?.extendSourceBy).toBe(0.5);
  });

  it('gives the first clip of a track its fade with nothing to extend', () => {
    const plans = planTransitions([
      clip({ id: 'a', transition: { type: 'crossfade', duration: 0.5 } }),
      clip({ id: 'b', start: 2 }),
    ], durations, 30);
    expect(plans.size).toBe(1);
    expect(plans.get('a')).toEqual({ extendSourceBy: 0, videoFadeIn: { d: 0.5, alpha: true }, audioFadeIn: 0.5 });
  });

  it('splits a dip symmetrically around the cut without borrowing frames', () => {
    const plans = planTransitions([
      clip({ id: 'a' }),
      clip({ id: 'b', start: 2, transition: { type: 'dip', duration: 0.5 } }),
    ], durations, 30);
    expect(plans.get('a')).toEqual({
      extendSourceBy: 0,
      videoFadeOut: { st: 1.75, d: 0.25 },
      audioFadeOut: { st: 1.75, d: 0.25 },
    });
    expect(plans.get('b')).toEqual({ extendSourceBy: 0, videoFadeIn: { d: 0.25, alpha: false }, audioFadeIn: 0.25 });
  });

  it('composes a head fade and a borrowed tail on the same middle clip', () => {
    const plans = planTransitions([
      clip({ id: 'a' }),
      clip({ id: 'b', start: 2, transition: { type: 'crossfade', duration: 0.5 } }),
      clip({ id: 'c', start: 4, transition: { type: 'crossfade', duration: 0.5 } }),
    ], durations, 30);
    expect(plans.get('b')).toEqual({
      extendSourceBy: 0.5,
      videoFadeIn: { d: 0.5, alpha: true },
      audioFadeIn: 0.5,
      audioFadeOut: { st: 2, d: 0.5 },
    });
  });

  it('never lets a transition outlast the clip it opens', () => {
    const plans = planTransitions([
      clip({ id: 'a' }),
      clip({ id: 'b', start: 2, out: 0.5, transition: { type: 'crossfade', duration: 2 } }),
    ], durations, 30);
    expect(plans.get('b')?.videoFadeIn).toEqual({ d: 0.5, alpha: true });
    expect(plans.get('a')?.extendSourceBy).toBe(0.5);
  });
});
