import { SYNC_SAMPLE_RATE, crossCorrelate } from '../../src/media/sync.js';

/*
 * Synthetic recordings of one performance, shared by sync.test.ts (the spec)
 * and sync-parity.test.ts (the Swift port must agree on exactly these).
 */
const RATE = SYNC_SAMPLE_RATE;

/** Deterministic PRNG so a failing case replays exactly. */
export function random(seed: number): () => number {
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
export function performance(seconds: number, seed: number): Float32Array {
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

export interface Capture {
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
export function capture(source: Float32Array, options: Capture): Float32Array {
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

/**
 * A camera across a real room: a weak direct path buried in a diffuse reverb
 * tail. Two phones at a real stand-up set looked like this, with a coarse ratio
 * of 15 and a fine score of only 6, because the tail smears the fine peak while
 * the loudness envelope survives it.
 */
export function reverberant(source: Float32Array, options: { from: number; seconds: number; rt: number; direct: number; noise: number }): Float32Array {
  const next = random(7);
  const tail = Math.round(options.rt * RATE);
  const response = Float64Array.from({ length: tail }, (_, index) => (index === 0
    ? options.direct
    : (next() * 2 - 1) * Math.exp((-6.9 * index) / tail) * 0.08));
  const start = Math.round(options.from * RATE);
  const dry = Float64Array.from(source.subarray(start - tail, start + Math.round(options.seconds * RATE)));
  // Convolution is correlation with the reversed impulse response: lag L holds
  // output sample L + tail - 1, so video sample i (dry sample tail + i) is at L = i + 1.
  const wet = crossCorrelate(dry, Float64Array.from(response).reverse(), false);
  return Float32Array.from({ length: Math.round(options.seconds * RATE) }, (_, index) =>
    (wet[index + 1] ?? 0) + options.noise * (next() * 2 - 1));
}
