import { spawn } from 'node:child_process';

/**
 * Audio sync: where does a second recording of the same event (a voice memo,
 * a lav, a second camera) line up against a video's own soundtrack?
 *
 * Two stages, because one is too slow and the other too coarse:
 *   1. coarse — cross-correlate 10ms onset envelopes over every possible lag.
 *      Envelopes are level-independent, so a pocket memo and a camera across
 *      the room still agree on *when* things got louder.
 *   2. fine — GCC-PHAT on raw samples within ±50ms of the coarse lag. Phase
 *      whitening keeps the peak sharp through room reverb, which a plain
 *      waveform correlation smears across several milliseconds.
 * The fine stage runs early and late in the overlap; if the two answers differ,
 * the recorders' clocks drift and the memo needs a tiny speed correction.
 */

export const SYNC_SAMPLE_RATE = 8000;
/** 10ms envelope cells: fine enough to land the fine search, cheap enough to search a whole set. */
const HOP = 80;
const ENVELOPE_RATE = SYNC_SAMPLE_RATE / HOP;
/** The coarse lag is good to a cell or two; the fine stage searches this far either side of it. */
const FINE_SEARCH_SAMPLES = 400;
/** Fine windows are at most ~16s: long enough to hold speech, short enough to sit early and late. */
const MAX_FINE_WINDOW = 1 << 17;
const MIN_FINE_WINDOW = 1 << 12;
/**
 * Below these the match is a guess, so sync refuses rather than moving the
 * clip. The fine score does the real gating: a wrong coarse lag leaves the
 * fine search nothing to lock onto (unrelated recordings score under 3.5, a
 * true match through four room echoes and hiss about 33), while the coarse
 * peak-to-runner-up sags toward 1.3 under noise even when its lag is right.
 */
export const MIN_COARSE_RATIO = 1.1;
export const MIN_FINE_SCORE = 8;
/** Real recorders drift tens of ppm; a "drift" past this is a bad match, not a clock. */
const MAX_DRIFT_RATE = 500e-6;

export interface FineMatch {
  /** Video seconds at the window's centre. */
  at: number;
  /** Video time minus memo time for the same sound, in seconds. */
  lag: number;
  /** Peak height over the search range's noise floor, in standard deviations. */
  score: number;
}

export interface SyncMeasurement {
  /**
   * Video source seconds at which memo source second 0 plays: memo time `m`
   * lines up with video time `m + lag` (at `anchor`, when drift is corrected).
   * Negative when the memo started recording first.
   */
  lag: number;
  /** Video seconds the lag was measured at; drift is applied about this point. */
  anchor: number;
  /** Memo source seconds per video second. 1 unless the clocks measurably drift. */
  rate: number;
  /** Coarse peak over its runner-up. */
  coarseRatio: number;
  /** Weakest fine-stage peak score across the windows used. */
  fineScore: number;
  confident: boolean;
  /** Seconds the two recordings drift apart across their whole overlap, when measured. */
  driftSec?: number;
  /** Seconds of overlap between the two recordings at this lag. */
  overlapSec: number;
  windows: FineMatch[];
}

/** Decode any media file's first audio stream to mono float PCM at `SYNC_SAMPLE_RATE`. */
export async function decodeMono(path: string): Promise<Float32Array> {
  return await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error', '-nostdin', '-i', path, '-vn', '-map', '0:a:0',
      '-ac', '1', '-ar', String(SYNC_SAMPLE_RATE), '-f', 'f32le', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      const joined = Buffer.concat(chunks);
      // Copy into a fresh, aligned buffer: Buffer pool slices need not be 4-byte aligned.
      const samples = new Float32Array(Math.floor(joined.byteLength / 4));
      new Uint8Array(samples.buffer).set(joined.subarray(0, samples.length * 4));
      resolve(samples);
    });
  });
}

export async function measureSyncFiles(videoPath: string, memoPath: string): Promise<SyncMeasurement> {
  const [video, memo] = await Promise.all([decodeMono(videoPath), decodeMono(memoPath)]);
  return measureSync(video, memo);
}

/** Align `memo` against `video`, both mono PCM at `SYNC_SAMPLE_RATE`. */
export function measureSync(video: Float32Array, memo: Float32Array): SyncMeasurement {
  const videoEnvelope = onsetEnvelope(video);
  const memoEnvelope = onsetEnvelope(memo);
  if (!videoEnvelope || !memoEnvelope) throw new SyncError('One of the recordings is silent, so there is nothing to line up');

  const coarse = coarseLag(videoEnvelope, memoEnvelope);
  const coarseLagSamples = coarse.lagCells * HOP;
  const overlapStart = Math.max(0, coarseLagSamples);
  const overlapEnd = Math.min(video.length, coarseLagSamples + memo.length);
  const overlap = overlapEnd - overlapStart;

  // Leave room for the fine search to slide either way without leaving either recording.
  const usable = overlap - 2 * FINE_SEARCH_SAMPLES;
  const window = Math.min(MAX_FINE_WINDOW, floorPowerOfTwo(Math.max(0, usable)));
  const windows: FineMatch[] = [];
  if (window >= MIN_FINE_WINDOW) {
    // Early and late windows when the overlap is long enough to tell them apart; one centred window otherwise.
    const centres = usable >= 3 * window ? [0.2, 0.8] : [0.5];
    for (const fraction of centres) {
      const centre = overlapStart + FINE_SEARCH_SAMPLES + Math.round(fraction * usable);
      const start = Math.min(Math.max(centre - window / 2, overlapStart + FINE_SEARCH_SAMPLES), overlapEnd - FINE_SEARCH_SAMPLES - window);
      windows.push(fineLag(video, memo, start, window, coarseLagSamples));
    }
  }

  const coarseLagSec = coarseLagSamples / SYNC_SAMPLE_RATE;
  const fineScore = windows.length ? Math.min(...windows.map((match) => match.score)) : 0;
  const fineConfident = windows.length > 0 && fineScore >= MIN_FINE_SCORE;
  const confident = coarse.ratio >= MIN_COARSE_RATIO && fineConfident;
  const first = windows[0];
  const last = windows.at(-1);
  let rate = 1;
  let driftSec: number | undefined;
  if (fineConfident && first && last && last !== first) {
    const slope = (last.lag - first.lag) / (last.at - first.at);
    driftSec = slope * (overlap / SYNC_SAMPLE_RATE);
    // Correct only what a viewer could see (a frame at 60fps) and only what a clock could cause.
    if (Math.abs(driftSec) > 1 / 60 && Math.abs(slope) <= MAX_DRIFT_RATE) rate = 1 - slope;
  }
  return {
    lag: first && fineConfident ? first.lag : coarseLagSec,
    anchor: first && fineConfident ? first.at : Math.max(0, coarseLagSec),
    rate,
    coarseRatio: coarse.ratio,
    fineScore,
    confident,
    ...(driftSec === undefined ? {} : { driftSec }),
    overlapSec: overlap / SYNC_SAMPLE_RATE,
    windows,
  };
}

export class SyncError extends Error {}

/**
 * Half-wave-rectified change in log energy per 10ms cell, z-normalised. Log
 * makes it gain-independent; the rectified difference keeps the attacks
 * (consonants, laughs, claps) that both microphones hear at the same moment
 * and drops the slow level differences that they do not share.
 */
function onsetEnvelope(samples: Float32Array): Float64Array | undefined {
  const cells = Math.floor(samples.length / HOP);
  if (cells < 2) return undefined;
  const envelope = new Float64Array(cells);
  let previous = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    let energy = 0;
    for (let offset = cell * HOP; offset < (cell + 1) * HOP; offset += 1) {
      const sample = samples[offset] as number;
      energy += sample * sample;
    }
    const level = Math.log10(energy / HOP + 1e-10);
    envelope[cell] = cell === 0 ? 0 : Math.max(0, level - previous);
    previous = level;
  }
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= cells;
  let variance = 0;
  for (const value of envelope) variance += (value - mean) ** 2;
  const deviation = Math.sqrt(variance / cells);
  if (deviation < 1e-6) return undefined;
  for (let cell = 0; cell < cells; cell += 1) envelope[cell] = ((envelope[cell] as number) - mean) / deviation;
  return envelope;
}

/** Best whole-cell lag of memo against video, and how far it stands above the next-best lag. */
function coarseLag(video: Float64Array, memo: Float64Array): { lagCells: number; ratio: number } {
  const correlation = crossCorrelate(video, memo, false);
  const size = correlation.length;
  // A lag that overlaps the two recordings by a sliver can match one stray
  // bang; demand a real overlap before a lag is allowed to win.
  const minOverlap = Math.max(1, Math.min(10 * ENVELOPE_RATE, Math.floor(0.5 * Math.min(video.length, memo.length))));
  const lowest = -(memo.length - minOverlap);
  const highest = video.length - minOverlap;
  const at = (lag: number): number => correlation[(lag + size) % size] as number;
  let best = lowest;
  for (let lag = lowest; lag <= highest; lag += 1) if (at(lag) > at(best)) best = lag;
  // The runner-up must be a different answer, not the shoulder of the same peak.
  const exclusion = Math.round(0.5 * ENVELOPE_RATE);
  let second = Number.NEGATIVE_INFINITY;
  for (let lag = lowest; lag <= highest; lag += 1) {
    if (Math.abs(lag - best) > exclusion) second = Math.max(second, at(lag));
  }
  return { lagCells: best, ratio: peakRatio(at(best), second) };
}

/** Refine `coarseLag` (samples) with GCC-PHAT over one window starting at video sample `start`. */
function fineLag(video: Float32Array, memo: Float32Array, start: number, window: number, coarseLag: number): FineMatch {
  const videoWindow = Float64Array.from(video.subarray(start, start + window));
  const memoWindow = Float64Array.from(memo.subarray(start - coarseLag, start - coarseLag + window));
  const correlation = crossCorrelate(videoWindow, memoWindow, true);
  const size = correlation.length;
  const at = (lag: number): number => correlation[(lag + size) % size] as number;
  let best = -FINE_SEARCH_SAMPLES;
  for (let lag = -FINE_SEARCH_SAMPLES; lag <= FINE_SEARCH_SAMPLES; lag += 1) if (at(lag) > at(best)) best = lag;
  // How far the peak stands above the rest of the search range, in standard
  // deviations. Not peak-over-runner-up: a room's first reflection is a real
  // second peak at half height, and a ratio would punish exactly the reverb
  // every stand-up room has. PHAT peaks are a sample or two wide, so the
  // floor is measured outside a millisecond either side of it.
  const exclusion = SYNC_SAMPLE_RATE / 1000;
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let lag = -FINE_SEARCH_SAMPLES; lag <= FINE_SEARCH_SAMPLES; lag += 1) {
    if (Math.abs(lag - best) <= exclusion) continue;
    const value = at(lag);
    sum += value;
    squares += value * value;
    count += 1;
  }
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(squares / count - mean * mean, 1e-24));
  return {
    at: (start + window / 2) / SYNC_SAMPLE_RATE,
    lag: (coarseLag + best) / SYNC_SAMPLE_RATE,
    score: (at(best) - mean) / deviation,
  };
}

function peakRatio(best: number, second: number): number {
  if (!(best > 0)) return 0;
  return second > 0 ? best / second : Number.POSITIVE_INFINITY;
}

/**
 * Circular cross-correlation over a zero-padded FFT: index `lag` (mod size)
 * holds Σ a[k + lag]·b[k]. With `phat`, every frequency bin is normalised to
 * unit magnitude first, which leaves only the phase — the timing — to agree on.
 */
export function crossCorrelate(a: Float64Array, b: Float64Array, phat: boolean): Float64Array {
  const size = ceilPowerOfTwo(a.length + b.length);
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(a);
  bRe.set(b);
  const twiddles = twiddleTable(size);
  fft(aRe, aIm, twiddles, false);
  fft(bRe, bIm, twiddles, false);
  for (let bin = 0; bin < size; bin += 1) {
    // a · conj(b)
    const re = (aRe[bin] as number) * (bRe[bin] as number) + (aIm[bin] as number) * (bIm[bin] as number);
    const im = (aIm[bin] as number) * (bRe[bin] as number) - (aRe[bin] as number) * (bIm[bin] as number);
    const scale = phat ? 1 / (Math.hypot(re, im) + 1e-12) : 1;
    aRe[bin] = re * scale;
    aIm[bin] = im * scale;
  }
  fft(aRe, aIm, twiddles, true);
  return aRe;
}

interface Twiddles { cos: Float64Array; sin: Float64Array }

/** exp(-2πik/n) for k < n/2, computed once: a running product loses precision over a 2^20-point transform. */
function twiddleTable(size: number): Twiddles {
  const half = size >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let index = 0; index < half; index += 1) {
    cos[index] = Math.cos((2 * Math.PI * index) / size);
    sin[index] = -Math.sin((2 * Math.PI * index) / size);
  }
  return { cos, sin };
}

/** In-place iterative radix-2 FFT; `inverse` conjugates the twiddles and scales by 1/n. */
function fft(re: Float64Array, im: Float64Array, twiddles: Twiddles, inverse: boolean): void {
  const size = re.length;
  for (let index = 1, swap = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      const re0 = re[index] as number; re[index] = re[swap] as number; re[swap] = re0;
      const im0 = im[index] as number; im[index] = im[swap] as number; im[swap] = im0;
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const half = length >> 1;
    const step = size / length;
    for (let offset = 0; offset < size; offset += length) {
      for (let k = 0; k < half; k += 1) {
        const wRe = twiddles.cos[k * step] as number;
        const wIm = inverse ? -(twiddles.sin[k * step] as number) : twiddles.sin[k * step] as number;
        const even = offset + k;
        const odd = even + half;
        const oddRe = (re[odd] as number) * wRe - (im[odd] as number) * wIm;
        const oddIm = (re[odd] as number) * wIm + (im[odd] as number) * wRe;
        re[odd] = (re[even] as number) - oddRe;
        im[odd] = (im[even] as number) - oddIm;
        re[even] = (re[even] as number) + oddRe;
        im[even] = (im[even] as number) + oddIm;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      re[index] = (re[index] as number) / size;
      im[index] = (im[index] as number) / size;
    }
  }
}

function ceilPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size <<= 1;
  return size;
}

function floorPowerOfTwo(value: number): number {
  if (value < 1) return 0;
  let size = 1;
  while (size * 2 <= value) size <<= 1;
  return size;
}
