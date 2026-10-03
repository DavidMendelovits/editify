import { describe, expect, it } from 'vitest';
import { SYNC_SAMPLE_RATE, SyncError, crossCorrelate, measureSync } from '../src/media/sync.js';
import { capture, performance, reverberant } from './helpers/sync-fixtures.js';

const RATE = SYNC_SAMPLE_RATE;

describe('crossCorrelate', () => {
  it('puts Σ a[k+lag]·b[k] at index lag, negative lags wrapped', () => {
    const a = Float64Array.from([0, 0, 1, 2, 0]);
    const b = Float64Array.from([1, 2, 0]);
    const result = crossCorrelate(a, b, false);
    const at = (lag: number): number => result[(lag + result.length) % result.length] as number;
    expect(at(2)).toBeCloseTo(5, 9);
    expect(at(1)).toBeCloseTo(2, 9);
    expect(at(-1)).toBeCloseTo(0, 9);
  });
});

describe('measureSync', () => {
  const show = performance(120, 1);

  it('finds a memo that started recording before the camera', () => {
    // Memo rolls from 0s, camera from 12.3456s: memo second 12.3456 is video second 0.
    const video = capture(show, { from: 12.3456, seconds: 60, gain: 0.4, echo: 0.021, noise: 0.01 });
    const memo = capture(show, { from: 0, seconds: 100, gain: 1.3, noise: 0.005, seed: 9 });
    const result = measureSync(video, memo);
    expect(result.confident).toBe(true);
    expect(result.lag).toBeCloseTo(-12.3456, 3);
    expect(result.rate).toBe(1);
  });

  it('finds a memo that started after the camera', () => {
    const video = capture(show, { from: 3, seconds: 90, gain: 0.5, echo: 0.013, noise: 0.02 });
    const memo = capture(show, { from: 20.5, seconds: 40, noise: 0.01, seed: 3 });
    const result = measureSync(video, memo);
    expect(result.confident).toBe(true);
    expect(result.lag).toBeCloseTo(17.5, 3);
  });

  it('measures clock drift across a long overlap and corrects it', () => {
    const long = performance(700, 2);
    // 60ppm: about 36ms apart after ten minutes, a visibly late mouth.
    const video = capture(long, { from: 30, seconds: 600, gain: 0.4, noise: 0.01 });
    const memo = capture(long, { from: 0, seconds: 660, drift: 60e-6, seed: 5 });
    const result = measureSync(video, memo);
    expect(result.confident).toBe(true);
    expect(result.windows).toHaveLength(2);
    expect(Math.abs(result.driftSec ?? 0)).toBeGreaterThan(0.02);
    // The memo recorded 60ppm more samples per second of show, so it has to play that much faster.
    expect(result.rate).toBeCloseTo(1 + 60e-6, 5);
    // After correction the memo lands within half a millisecond at both ends.
    for (const window of result.windows) {
      const memoAt = (window.at - result.lag - (window.at - result.anchor)) + result.rate * (window.at - result.anchor);
      expect(Math.abs(memoAt - (window.at - window.lag))).toBeLessThan(0.0005);
    }
  }, 30000);

  it('still locks on when the camera barely hears the room over its own hiss', () => {
    const video = capture(show, { from: 12, seconds: 60, gain: 0.3, noise: 0.15 });
    const memo = capture(show, { from: 0, seconds: 100, seed: 4 });
    const result = measureSync(video, memo);
    expect(result.confident).toBe(true);
    expect(result.lag).toBeCloseTo(-12, 3);
  });

  it('trusts a clear global match when room reverb smears the fine peak', () => {
    const long = performance(90, 3);
    const video = reverberant(long, { from: 12, seconds: 60, rt: 0.6, direct: 0.2, noise: 0.03 });
    const result = measureSync(video, long.subarray(0, 90 * RATE));
    // The regression: a fine peak this soft used to be refused outright.
    expect(result.fineScore).toBeLessThan(8);
    expect(result.coarseRatio).toBeGreaterThan(2);
    expect(result.confident).toBe(true);
    expect(result.lag).toBeCloseTo(-12, 3);
  });

  it('falls back to the coarse lag when the room leaves no fine peak at all', () => {
    const long = performance(90, 3);
    const video = reverberant(long, { from: 12, seconds: 60, rt: 0.8, direct: 0.05, noise: 0.05 });
    const result = measureSync(video, long.subarray(0, 90 * RATE));
    expect(result.confident).toBe(true);
    // One 10ms envelope cell: a third of a frame at 30fps.
    expect(Math.abs(result.lag + 12)).toBeLessThanOrEqual(0.0101);
  });

  it('still corrects drift when a long set carries it tens of ms past the coarse answer', () => {
    // 20 minutes at 60ppm is 72ms of drift: the early and late windows sit
    // ~35ms either side of the single coarse lag. That used to fail a fixed
    // 20ms lock and come back "confident, rate 1", wrong by 72ms at the end.
    const long = performance(1300, 4);
    const video = capture(long, { from: 30, seconds: 1200, gain: 0.4, noise: 0.01 });
    const memo = capture(long, { from: 0, seconds: 1260, drift: 60e-6, seed: 6 });
    const result = measureSync(video, memo);
    expect(result.confident).toBe(true);
    expect(result.rate).toBeCloseTo(1 + 60e-6, 5);
  }, 60000);

  it('does not call short unrelated clips a match just because nothing competes', () => {
    for (const seconds of [0.1, 0.3, 1]) {
      const video = capture(performance(2, 21), { from: 0, seconds });
      const memo = capture(performance(2, 22), { from: 0, seconds });
      expect(measureSync(video, memo).confident).toBe(false);
    }
  });

  it('refuses to guess between unrelated recordings', () => {
    const video = capture(performance(60, 11), { from: 0, seconds: 60 });
    const memo = capture(performance(60, 12), { from: 0, seconds: 60 });
    const result = measureSync(video, memo);
    expect(result.confident).toBe(false);
  });

  it('rejects silence outright', () => {
    const video = capture(show, { from: 0, seconds: 20 });
    expect(() => measureSync(video, new Float32Array(20 * RATE))).toThrow(SyncError);
  });
});
