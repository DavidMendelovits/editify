import { describe, expect, it } from 'vitest';
import { SYNC_SAMPLE_RATE, SyncError, crossCorrelate, measureSync } from '../src/media/sync.js';

const RATE = SYNC_SAMPLE_RATE;

/** Deterministic PRNG so a failing case replays exactly. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stand-in for a room recording: bursts of band-limited noise with random
 * lengths and levels and silences between them, so there are attacks for the
 * envelope to find and waveform detail for the fine stage.
 */
function performance(seconds: number, seed: number): Float32Array {
  const next = random(seed);
  const samples = new Float32Array(Math.round(seconds * RATE));
  let cursor = 0;
  let low = 0;
  while (cursor < samples.length) {
    const burst = Math.round((0.08 + next() * 0.5) * RATE);
    const gap = Math.round((0.03 + next() * 0.4) * RATE);
    const level = 0.1 + next() * 0.6;
    for (let index = 0; index < burst && cursor + index < samples.length; index += 1) {
      low = 0.7 * low + 0.3 * (next() * 2 - 1);
      samples[cursor + index] = level * low;
    }
    cursor += burst + gap;
  }
  return samples;
}

interface Capture {
  /** Source seconds of the performance this recorder started at. */
  from: number;
  seconds: number;
  gain?: number;
  /** Seconds of room echo mixed in at half level. */
  echo?: number;
  /** Uncorrelated hiss level. */
  noise?: number;
  /** Recorder clock error: this many extra samples per performance sample. */
  drift?: number;
  seed?: number;
}

/** Record `source` the way a second device would: its own start, level, room, noise, and clock. */
function capture(source: Float32Array, options: Capture): Float32Array {
  const next = random(options.seed ?? 7);
  const out = new Float32Array(Math.round(options.seconds * RATE));
  const echo = Math.round((options.echo ?? 0) * RATE);
  const step = 1 + (options.drift ?? 0);
  for (let index = 0; index < out.length; index += 1) {
    const position = options.from * RATE + index / step;
    const whole = Math.floor(position);
    const fraction = position - whole;
    const read = (at: number): number => (at >= 0 && at + 1 < source.length
      ? (source[at] as number) * (1 - fraction) + (source[at + 1] as number) * fraction : 0);
    const dry = read(whole);
    const wet = echo ? 0.5 * read(whole - echo) : 0;
    out[index] = (options.gain ?? 1) * (dry + wet) + (options.noise ?? 0) * (next() * 2 - 1);
  }
  return out;
}

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
