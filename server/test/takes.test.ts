import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '../src/db/transcript-store.js';
import { buildTakeMap, snapTakeToWords, splitSentences } from '../src/services/takes.js';

/** Lay words out back to back: 0.3s each, `gap` seconds of silence after each line (or `gaps[i]`). */
function speak(lines: string[], gap = 1, gaps: number[] = []): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let cursor = 0.5;
  for (const [index, line] of lines.entries()) {
    for (const w of line.split(' ')) {
      words.push({ w, s: round(cursor), e: round(cursor + 0.3) });
      cursor += 0.35;
    }
    cursor += gaps[index] ?? gap;
  }
  return words;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

describe('take map', () => {
  it('splits sentences on full stops and on long pauses', () => {
    const words = speak(['Hello there.', 'no stop here', 'last one.'], 1);
    expect(splitSentences(words).map((sentence) => sentence.text)).toEqual(['Hello there.', 'no stop here', 'last one.']);
  });

  it('groups retakes, drops restart lines and false starts, and picks the last complete take', () => {
    const words = speak([
      'Most launches fail quietly.',
      'The reason is distribution,',
      'okay, again.',
      'Most launches fail quietly.',
      'The reason is',
      'The reason is distribution, not the product.',
      'Here is what to do instead.',
    ], 1, [1, 1, 1, 1, 1, 0.3]);
    const map = buildTakeMap(words, 60);
    expect(map.sentences.map((sentence) => sentence.flags)).toEqual([
      ['retake'], ['false-start'], ['restart'], [], ['false-start'], [], [],
    ]);
    expect(map.groups.map((group) => [group.attempts, group.pick])).toEqual([
      [[0, 3], 3],
      [[1, 4, 5], 5],
      [[6], 6],
    ]);
    // Picks 5 and 6 were one breath in the recording, so they stay one take.
    expect(map.takes.map((take) => take.sentences)).toEqual([[3], [5, 6]]);
    expect(map.takes[1]?.text).toBe('The reason is distribution, not the product. Here is what to do instead.');
  });

  it('keeps a single clean take as one line per group', () => {
    const map = buildTakeMap(speak(['One idea.', 'Two ideas.', 'Three ideas today.']), 20);
    expect(map.groups.every((group) => group.attempts.length === 1)).toBe(true);
    expect(map.takes).toHaveLength(3);
  });

  it('pads cut points around the words and never into a neighbour', () => {
    const words: TranscriptWord[] = [
      { w: 'before', s: 1, e: 1.5 },
      { w: 'keep', s: 1.55, e: 2 },
      { w: 'this', s: 2.1, e: 2.5 },
      { w: 'after', s: 3, e: 3.4 },
    ];
    // Lead is clamped by `before` ending at 1.5; tail gets its full 0.25s.
    expect(snapTakeToWords(words, 1.55, 2.5, 10)).toEqual({ start: 1.52, end: 2.75 });
    // Tail is clamped by `after` starting at 3.0 when the words run close.
    expect(snapTakeToWords([...words.slice(0, 3), { w: 'after', s: 2.6, e: 3 }], 1.55, 2.5, 10)).toEqual({ start: 1.52, end: 2.58 });
    expect(snapTakeToWords(words, 5, 6, 10)).toBeUndefined();
  });
});
