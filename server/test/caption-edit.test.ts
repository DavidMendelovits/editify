import { describe, expect, it } from 'vitest';
import { refitCaptionWords, type Project } from '@editify/shared';
import { applyOperation } from '../src/operations/apply.js';

const WORDS = [
  { w: 'KEEP', s: 1, e: 1.4 },
  { w: 'IT', s: 1.4, e: 1.6 },
  { w: 'MOVING', s: 1.6, e: 2.4 },
];

function project(): Project {
  return {
    id: 'caption-edit', title: 'Caption edit', format: '9:16', fps: 30, duration: 4, version: 0,
    tracks: [{
      id: 'captions',
      kind: 'caption',
      clips: [{
        id: 'cap-1', start: 1, in: 0, out: 1.4, text: 'KEEP IT MOVING',
        style: { font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold', words: WORDS },
      }],
    }],
  };
}

describe('refitCaptionWords', () => {
  it('keeps every timing when the word count is unchanged', () => {
    expect(refitCaptionWords(WORDS, 'KEEP IT ROLLING')).toEqual([
      { w: 'KEEP', s: 1, e: 1.4 },
      { w: 'IT', s: 1.4, e: 1.6 },
      { w: 'ROLLING', s: 1.6, e: 2.4 },
    ]);
  });

  it('redistributes the original span when the word count changes', () => {
    const fitted = refitCaptionWords(WORDS, 'we  keep on moving now') ?? [];
    expect(fitted.map((word) => word.w)).toEqual(['we', 'keep', 'on', 'moving', 'now']);
    expect(fitted[0]?.s).toBe(1);
    expect(fitted.at(-1)?.e).toBe(2.4);
    for (const word of fitted) expect(word.e).toBeGreaterThan(word.s);
    // Longer words get a longer slice: 'moving' (6 chars) outlasts 'on' (2).
    expect(fitted[3]!.e - fitted[3]!.s).toBeGreaterThan(fitted[2]!.e - fitted[2]!.s);
  });

  it('returns undefined when there were no words or the text has none', () => {
    expect(refitCaptionWords(undefined, 'anything')).toBeUndefined();
    expect(refitCaptionWords([], 'anything')).toBeUndefined();
    expect(refitCaptionWords(WORDS, '   ')).toBeUndefined();
  });
});

describe('update_caption text edits', () => {
  it('refits style.words onto the new text', () => {
    const result = applyOperation(project(), {
      type: 'update_caption',
      params: { clipId: 'cap-1', text: 'KEEP IT ROLLING' },
    });
    const clip = result.tracks[0]?.clips[0];
    expect(clip?.text).toBe('KEEP IT ROLLING');
    expect(clip?.style?.words).toEqual([
      { w: 'KEEP', s: 1, e: 1.4 },
      { w: 'IT', s: 1.4, e: 1.6 },
      { w: 'ROLLING', s: 1.6, e: 2.4 },
    ]);
  });

  it('leaves an explicitly supplied style alone', () => {
    const words = [{ w: 'ONE', s: 0, e: 1 }];
    const result = applyOperation(project(), {
      type: 'update_caption',
      params: {
        clipId: 'cap-1',
        text: 'TWO WORDS HERE',
        style: { font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold', words },
      },
    });
    expect(result.tracks[0]?.clips[0]?.style?.words).toEqual(words);
  });
});
