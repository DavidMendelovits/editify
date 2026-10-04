import type { TranscriptWord } from './analysis.js';
import { FILLER_WORDS, normalizeWord } from './cleanup.js';

/**
 * The take map of a multi-take recording. People record by saying a line,
 * disliking it, and saying it again, so a raw talking-head file is the script
 * read two or three times over with the fluent versions towards the end. This
 * finds the sentences, groups the attempts at each one, and picks a take per
 * group; the agent reviews the pick and assembles the cut.
 *
 * Adapted from kurbaitaev/ghost-editor (MIT), whose take selection is itself
 * adapted from mariagorskikh/talking-head-reel (MIT).
 */

/** Spoken restart markers: the speaker telling the editor a take is dead. */
const RESTART = /\b(ok(?:ay)?,? (?:again|one more time|let me (?:do|say|try) (?:that|this|it) again)|let me (?:do|say|try) (?:that|this|it) again|start (?:over|again)|one more time|take two|from the top|let'?s try (?:that |this |it )?again|wait,? no|sorry,? let me)\b/i;
/** A pause this long ends a sentence even when whisper gave it no full stop. */
const SENTENCE_PAUSE_SEC = 0.8;
/** Cut padding on word times: a breath in before the first word, a beat after the last. */
export const TAKE_LEAD_SEC = 0.12;
export const TAKE_TAIL_SEC = 0.25;
/** Never cut closer than this to a neighbouring word. */
const NEIGHBOUR_CLEARANCE_SEC = 0.02;
/** Picks this close in the source stay one take: one breath, one cut fewer. */
const MERGE_GAP_SEC = 0.6;

export interface TakeSentence {
  index: number;
  start: number;
  end: number;
  text: string;
  firstWord: number;
  lastWord: number;
  /** `restart`: a "let me do that again" line; `false-start`: cut off and said again later. */
  flags: Array<'restart' | 'false-start' | 'retake'>;
}

export interface TakeGroup {
  /** Sentence indexes of every attempt at this line, in recording order. */
  attempts: number[];
  pick: number;
  why: string;
}

export interface SuggestedTake {
  start: number;
  end: number;
  sentences: number[];
  text: string;
}

export interface TakeMap {
  sentences: TakeSentence[];
  groups: TakeGroup[];
  takes: SuggestedTake[];
  keptSeconds: number;
  sourceSeconds: number;
}

const FILLERS = new Set<string>(FILLER_WORDS);

function tokens(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter((token) => token && !FILLERS.has(token));
}

function lcsLength(left: string[], right: string[]): number {
  const row = new Array<number>(right.length + 1).fill(0);
  for (const token of left) {
    let diagonal = 0;
    for (let column = 1; column <= right.length; column += 1) {
      const above = row[column] as number;
      row[column] = token === right[column - 1] ? diagonal + 1 : Math.max(above, row[column - 1] as number);
      diagonal = above;
    }
  }
  return row[right.length] as number;
}

/** Same line said twice, or one attempt cut short and started over. */
function sameLine(left: string[], right: string[]): 'retake' | 'false-start' | undefined {
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (shorter < 2) return undefined;
  const common = lcsLength(left, right);
  if (longer >= 4 && common / longer >= 0.6) return 'retake';
  if (longer < 4 && common === longer && left.length === right.length) return 'retake';
  const sameOpening = left[0] === right[0] && left[1] === right[1];
  if (sameOpening && common / shorter >= 0.8 && shorter < longer) return 'false-start';
  return undefined;
}

export function splitSentences(words: TranscriptWord[]): TakeSentence[] {
  const sentences: TakeSentence[] = [];
  let first = 0;
  words.forEach((word, index) => {
    const next = words[index + 1];
    const ends = !next || /[.?!]["')\]]*$/.test(word.w) || next.s - word.e >= SENTENCE_PAUSE_SEC;
    if (!ends) return;
    const run = words.slice(first, index + 1);
    sentences.push({
      index: sentences.length,
      start: run[0]?.s ?? word.s,
      end: word.e,
      text: run.map((item) => item.w).join(' '),
      firstWord: first,
      lastWord: index,
      flags: [],
    });
    first = index + 1;
  });
  return sentences;
}

/** Word-time cut points for a source range, padded and clear of the neighbouring words. */
export function snapTakeToWords(words: TranscriptWord[], start: number, end: number, duration: number): { start: number; end: number } | undefined {
  const inside = words.map((word, index) => ({ word, index }))
    .filter(({ word }) => word.e > start + NEIGHBOUR_CLEARANCE_SEC && word.s < end - NEIGHBOUR_CLEARANCE_SEC);
  const first = inside[0];
  const last = inside.at(-1);
  if (!first || !last) return undefined;
  const previous = words[first.index - 1];
  const next = words[last.index + 1];
  const snappedStart = Math.max(0, first.word.s - TAKE_LEAD_SEC, previous ? previous.e + NEIGHBOUR_CLEARANCE_SEC : 0);
  const snappedEnd = Math.min(duration, last.word.e + TAKE_TAIL_SEC, next ? next.s - NEIGHBOUR_CLEARANCE_SEC : duration);
  if (snappedEnd <= snappedStart) return undefined;
  return { start: round2(snappedStart), end: round2(snappedEnd) };
}

export function buildTakeMap(words: TranscriptWord[], duration: number): TakeMap {
  const sentences = splitSentences(words);
  const tokenized = sentences.map((sentence) => tokens(sentence.text));
  for (const sentence of sentences) {
    // A restart marker with little else in the line is an instruction, not script.
    if (RESTART.test(sentence.text) && (tokenized[sentence.index]?.length ?? 0) <= 7) sentence.flags.push('restart');
  }

  // Union-find over every pair of script lines that are attempts at the same line.
  const parent = sentences.map((sentence) => sentence.index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    parent[index] = root;
    return root;
  };
  const script = sentences.filter((sentence) => !sentence.flags.includes('restart'));
  for (const [position, later] of script.entries()) {
    for (const earlier of script.slice(0, position)) {
      const relation = sameLine(tokenized[earlier.index] ?? [], tokenized[later.index] ?? []);
      if (!relation) continue;
      parent[find(later.index)] = find(earlier.index);
      const shorter = (tokenized[earlier.index]?.length ?? 0) < (tokenized[later.index]?.length ?? 0) ? earlier : later;
      if (relation === 'false-start' && !shorter.flags.includes('false-start')) shorter.flags.push('false-start');
    }
  }

  const byRoot = new Map<number, number[]>();
  for (const sentence of script) {
    const root = find(sentence.index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), sentence.index]);
  }
  const groups: TakeGroup[] = [...byRoot.values()]
    .sort((left, right) => (left[0] as number) - (right[0] as number))
    .map((attempts) => {
      const longest = Math.max(...attempts.map((index) => tokenized[index]?.length ?? 0));
      const complete = attempts.filter((index) => !sentences[index]?.flags.includes('false-start')
        && (tokenized[index]?.length ?? 0) >= longest * 0.8);
      // Later takes are the warmed-up ones; the last complete attempt wins.
      const pick = complete.at(-1) ?? attempts.at(-1) as number;
      if (attempts.length > 1) {
        for (const index of attempts) {
          if (index !== pick && !sentences[index]?.flags.includes('false-start')) sentences[index]?.flags.push('retake');
        }
      }
      const why = attempts.length === 1
        ? 'only take'
        : `last complete take of ${attempts.length}${complete.length < attempts.length ? `; ${attempts.length - complete.length} cut short` : ''}`;
      return { attempts, pick, why };
    });

  const takes: SuggestedTake[] = [];
  for (const group of groups) {
    const sentence = sentences[group.pick];
    if (!sentence) continue;
    const snapped = snapTakeToWords(words, sentence.start, sentence.end, duration);
    if (!snapped) continue;
    const previous = takes.at(-1);
    const previousLast = previous ? sentences[previous.sentences.at(-1) as number] : undefined;
    // Consecutive picks that were one breath in the recording stay one take.
    if (previous && previousLast && previousLast.lastWord + 1 === sentence.firstWord && sentence.start - previousLast.end <= MERGE_GAP_SEC) {
      previous.end = snapped.end;
      previous.sentences.push(sentence.index);
      previous.text = `${previous.text} ${sentence.text}`;
      continue;
    }
    takes.push({ start: snapped.start, end: snapped.end, sentences: [sentence.index], text: sentence.text });
  }
  return {
    sentences,
    groups,
    takes,
    keptSeconds: round2(takes.reduce((total, take) => total + take.end - take.start, 0)),
    sourceSeconds: round2(duration),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
