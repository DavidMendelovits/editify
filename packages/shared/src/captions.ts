/* Transcript words -> caption chunks for one clip (or one audible window of it). */
import type { TranscriptWord } from './analysis.js';
import type { Clip } from './index.js';

export interface TranscriptCaptionChunk {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  start: number;
  duration: number;
  words: Array<{ w: string; s: number; e: number }>;
}

export interface CaptionChunkOptions {
  wordsPerChunk: number;
  maxWordsPerChunk?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  maxCharsPerSecond?: number;
}

export function chunkTranscriptForClip(
  words: TranscriptWord[],
  clip: Pick<Clip, 'start' | 'in' | 'out' | 'speed'>,
  options: number | CaptionChunkOptions = 3,
): TranscriptCaptionChunk[] {
  const settings: CaptionChunkOptions = typeof options === 'number' ? { wordsPerChunk: options } : options;
  const targetWords = settings.wordsPerChunk;
  const maxWords = settings.maxWordsPerChunk ?? targetWords;
  const maxDuration = settings.maxDurationSec ?? Number.POSITIVE_INFINITY;
  const maxCps = settings.maxCharsPerSecond ?? Number.POSITIVE_INFINITY;
  const eligible = words.filter((word) => word.s >= clip.in && word.s < clip.out && word.e > word.s);
  const groups: TranscriptWord[][] = [];
  for (const word of eligible) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const prospective = current ? [...current, word] : [word];
    const prospectiveDuration = (prospective.at(-1)?.e ?? word.e) - (prospective[0]?.s ?? word.s);
    const chars = prospective.map((candidate) => candidate.w).join(' ').length;
    const exceedsCps = prospective.length > 1 && chars / Math.max(prospectiveDuration, 0.01) > maxCps;
    if (!current || current.length >= maxWords || (previous && word.s - previous.e >= 0.6)
      || prospectiveDuration > maxDuration || exceedsCps
      || (current.length >= targetWords && /[,;:]$/.test(previous?.w ?? ''))) {
      groups.push([word]);
    } else {
      current.push(word);
    }
  }
  const speed = clip.speed ?? 1;
  const timelineEnd = clip.start + (clip.out - clip.in) / speed;
  const chunks = groups.flatMap((group) => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return [];
    const start = clip.start + (first.s - clip.in) / speed;
    const mappedEnd = clip.start + (Math.min(last.e, clip.out) - clip.in) / speed;
    const end = Math.min(timelineEnd, Math.max(mappedEnd, start + (settings.minDurationSec ?? 0.25)));
    if (end <= start) return [];
    return [{
      text: group.map((word) => word.w).join(' '),
      sourceStart: first.s,
      sourceEnd: Math.min(last.e, clip.out),
      start,
      duration: end - start,
      words: group.map((word) => ({
        w: word.w,
        s: clip.start + (word.s - clip.in) / speed,
        e: clip.start + (Math.min(word.e, clip.out) - clip.in) / speed,
      })),
    }];
  });
  return clampChunkOverlaps(chunks);
}

const CHUNK_GAP_SEC = 0.001;
const MIN_CHUNK_DURATION_SEC = 0.15;

// minDurationSec can push a chunk past the next chunk's start, which renders as stacked captions.
// Clamping only shortens chunks, so the postcondition start_{i+1} >= start_i + duration_i survives drops.
function clampChunkOverlaps(chunks: TranscriptCaptionChunk[]): TranscriptCaptionChunk[] {
  const sorted = [...chunks].sort((left, right) => left.start - right.start);
  const kept: TranscriptCaptionChunk[] = [];
  for (const [index, chunk] of sorted.entries()) {
    const next = sorted[index + 1];
    if (!next) { kept.push(chunk); continue; }
    const limit = next.start - CHUNK_GAP_SEC;
    if (chunk.start + chunk.duration <= limit) { kept.push(chunk); continue; }
    const duration = limit - chunk.start;
    if (duration >= MIN_CHUNK_DURATION_SEC) kept.push({ ...chunk, duration });
  }
  return kept;
}
