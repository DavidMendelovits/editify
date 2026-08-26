import { clipTimelineDuration, type Project } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import type { TranscriptService } from './transcript-service.js';

export interface CleanupRange { start: number; end: number }

export interface TimelineTranscriptWord {
  index: number;
  text: string;
  timelineStart: number;
  timelineEnd: number;
  sourceStart: number;
  sourceEnd: number;
  clipId: string;
  trackId: string;
  assetId: string;
}

export interface TimelineTranscript {
  words: TimelineTranscriptWord[];
  rows: Array<[number, string, number]>;
  segments: Array<[number, string, number, number]>;
}

export function buildTimelineTranscript(project: Project, getTranscript: (assetId: string) => ReturnType<TranscriptService['get']>): TimelineTranscript {
  const words: TimelineTranscriptWord[] = [];
  const segments: Array<[number, string, number, number]> = [];
  const clips = project.tracks.filter((track) => track.kind === 'video')
    .flatMap((track) => track.clips.map((clip) => ({ trackId: track.id, clip })))
    .sort((left, right) => left.clip.start - right.clip.start || left.trackId.localeCompare(right.trackId) || left.clip.id.localeCompare(right.clip.id));
  for (const { trackId, clip } of clips) {
    if (!clip.assetId) continue;
    const transcript = getTranscript(clip.assetId);
    if (!transcript) continue;
    const speed = clip.speed ?? 1;
    const clipWords = transcript.words.filter((word) => word.s >= clip.in && word.s < clip.out && word.e > word.s);
    const firstIndex = words.length;
    for (const word of clipWords) {
      words.push({
        index: words.length,
        text: word.w,
        timelineStart: clip.start + (word.s - clip.in) / speed,
        timelineEnd: clip.start + (Math.min(word.e, clip.out) - clip.in) / speed,
        sourceStart: word.s,
        sourceEnd: Math.min(word.e, clip.out),
        clipId: clip.id,
        trackId,
        assetId: clip.assetId,
      });
    }
    for (const segment of transcript.segments) {
      const included = words.slice(firstIndex).filter((word) => word.sourceStart >= segment.s && word.sourceStart < segment.e);
      const first = included[0];
      const last = included.at(-1);
      if (!first || !last) continue;
      segments.push([first.index, included.map((word) => word.text).join(' '), first.timelineStart, last.timelineEnd]);
    }
  }
  return { words, rows: words.map((word) => [word.index, word.text, word.timelineStart]), segments };
}

export function planWordCutRanges(
  words: Array<{ start: number; end: number; selected: boolean }>,
  clipStart: number,
  clipEnd: number,
  keptGapMs = 150,
): CleanupRange[] {
  const halfGap = keptGapMs / 2000;
  const ranges: CleanupRange[] = [];
  let index = 0;
  while (index < words.length) {
    if (!words[index]?.selected) { index += 1; continue; }
    const first = index;
    while (index + 1 < words.length && words[index + 1]?.selected) index += 1;
    const last = index;
    const runStart = words[first]?.start ?? clipStart;
    const runEnd = words[last]?.end ?? clipEnd;
    const left = first > 0 ? words[first - 1]?.end ?? clipStart : clipStart;
    const right = last + 1 < words.length ? words[last + 1]?.start ?? clipEnd : clipEnd;
    const start = Math.max(clipStart, runStart - Math.min(Math.max(0, runStart - left), halfGap));
    const end = Math.min(clipEnd, runEnd + Math.min(Math.max(0, right - runEnd), halfGap));
    if (end > start) ranges.push({ start, end });
    index += 1;
  }
  return mergeRanges(ranges);
}

export function mergeRanges(ranges: CleanupRange[]): CleanupRange[] {
  const result: CleanupRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

/** Lowercase and strip surrounding punctuation — the word-boundary form both selectors compare on. */
export function normalizeWord(value: string): string {
  return value.toLowerCase().replace(/^\W+|\W+$/g, '');
}

/**
 * Deliberately conservative. 'like', 'so', and 'you know' are ordinary speech far
 * more often than they are filler, and one-tap cleanup has no review step before
 * the cut lands — a false positive eats a real word.
 */
export const FILLER_WORDS = ['um', 'uh', 'uhh', 'erm', 'mm', 'hmm'] as const;

/** The range-planning half of `remove_words`: selected timeline words to per-track ripple ranges. */
export function planWordRemovalRanges(
  project: Project,
  words: TimelineTranscriptWord[],
  selected: Set<number>,
  keptGapMs = 150,
): Map<string, CleanupRange[]> {
  const tracks = new Map<string, CleanupRange[]>();
  const byClip = new Map<string, TimelineTranscriptWord[]>();
  for (const word of words) {
    const list = byClip.get(word.clipId) ?? [];
    list.push(word);
    byClip.set(word.clipId, list);
  }
  for (const clipWords of byClip.values()) {
    if (!clipWords.some((word) => selected.has(word.index))) continue;
    const clip = project.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === clipWords[0]?.clipId);
    if (!clip) continue;
    const ranges = planWordCutRanges(clipWords.map((word) => ({
      start: word.timelineStart, end: word.timelineEnd, selected: selected.has(word.index),
    })), clip.start, clip.start + clipTimelineDuration(clip), keptGapMs);
    const list = tracks.get(clipWords[0]?.trackId ?? '') ?? [];
    list.push(...ranges);
    tracks.set(clipWords[0]?.trackId ?? '', list);
  }
  return new Map([...tracks].map(([trackId, ranges]) => [trackId, mergeRanges(ranges)]));
}

export interface FillerPlan {
  rangesByTrack: Map<string, CleanupRange[]>;
  /** The distinct lexicon words actually heard, for the UI to name. */
  matched: string[];
}

export function planFillerRanges(project: Project, words: TimelineTranscriptWord[], keptGapMs = 150): FillerPlan {
  const lexicon = new Set<string>(FILLER_WORDS);
  const selected = new Set<number>();
  const matched = new Set<string>();
  for (const word of words) {
    const token = normalizeWord(word.text);
    if (!lexicon.has(token)) continue;
    selected.add(word.index);
    matched.add(token);
  }
  return { rangesByTrack: planWordRemovalRanges(project, words, selected, keptGapMs), matched: [...matched].sort() };
}

export interface SilenceOptions {
  minSilenceSeconds: number;
  padSeconds: number;
  protectLoudGaps: boolean;
}

/** The `remove_silence` tool defaults, shared so one-tap cleanup measures what the agent would cut. */
export const SILENCE_DEFAULTS: SilenceOptions = { minSilenceSeconds: 0.5, padSeconds: 0.15, protectLoudGaps: true };

export interface SilencePlan {
  rangesByTrack: Map<string, CleanupRange[]>;
  gapsCut: number;
  gapsProtected: number;
}

export interface CleanupSources {
  assets: AssetStore;
  transcripts: TranscriptService;
}

/**
 * The range-planning half of `remove_silence`. Gaps live between timeline words,
 * so an asset with no transcript contributes nothing here.
 */
export async function planSilenceRanges(
  project: Project,
  words: TimelineTranscriptWord[],
  sources: CleanupSources,
  options: SilenceOptions,
): Promise<SilencePlan> {
  const rangesByTrack = new Map<string, CleanupRange[]>();
  let gapsCut = 0;
  let gapsProtected = 0;
  for (let index = 0; index + 1 < words.length; index += 1) {
    const left = words[index];
    const right = words[index + 1];
    if (!left || !right || left.clipId !== right.clipId || left.trackId !== right.trackId) continue;
    const gapDuration = right.timelineStart - left.timelineEnd;
    if (gapDuration < options.minSilenceSeconds) continue;
    const asset = sources.assets.get(left.assetId);
    if (!asset) continue;
    const speed = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === left.clipId)?.speed ?? 1;
    const stored = sources.transcripts.get(left.assetId);
    if (!stored) continue;
    const energy = options.protectLoudGaps ? (stored.energy ?? await sources.transcripts.ensureEnergy(asset)) : undefined;
    const gapCells = energy ? energyCells(energy.rmsDb, energy.cellSeconds, left.sourceEnd, right.sourceStart) : [];
    const speechCells = energy ? words.filter((word) => word.assetId === left.assetId && word.clipId === left.clipId)
      .flatMap((word) => energyCells(energy.rmsDb, energy.cellSeconds, word.sourceStart, word.sourceEnd).map((cell) => cell.db)) : [];
    const isLoud = Boolean(energy) && median(gapCells.map((cell) => cell.db)) >= median(speechCells) - 12;
    const list = rangesByTrack.get(left.trackId) ?? [];
    if (isLoud && energy) {
      gapsProtected += 1;
      if (gapDuration > 2 && gapCells.length) {
        const peak = gapCells.reduce((best, cell) => cell.db > best.db ? cell : best, gapCells[0] as { index: number; db: number });
        const keepThroughSource = (peak.index + 1) * energy.cellSeconds + 0.4 * speed;
        const cutStart = left.timelineEnd + Math.max(0, keepThroughSource - left.sourceEnd) / speed;
        const cutEnd = right.timelineStart - options.padSeconds;
        if (cutEnd > cutStart) { list.push({ start: cutStart, end: cutEnd }); gapsCut += 1; }
      }
    } else {
      const start = left.timelineEnd + options.padSeconds;
      const end = right.timelineStart - options.padSeconds;
      if (end > start) { list.push({ start, end }); gapsCut += 1; }
    }
    rangesByTrack.set(left.trackId, list);
  }
  return {
    rangesByTrack: new Map([...rangesByTrack].map(([trackId, ranges]) => [trackId, mergeRanges(ranges)])),
    gapsCut,
    gapsProtected,
  };
}

export function totalRangeSeconds(ranges: CleanupRange[]): number {
  return ranges.reduce((total, range) => total + range.end - range.start, 0);
}

function median(values: number[]): number {
  if (!values.length) return Number.NEGATIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function energyCells(rmsDb: number[], cellSeconds: number, start: number, end: number): Array<{ index: number; db: number }> {
  const first = Math.max(0, Math.floor(start / cellSeconds));
  const last = Math.min(rmsDb.length, Math.ceil(end / cellSeconds));
  return rmsDb.slice(first, last).map((db, offset) => ({ index: first + offset, db }));
}
