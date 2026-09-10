import { describe, expect, it } from 'vitest';
// Straight from source: `@editify/shared` resolves to the package's build output,
// which lags the checklist module this file exercises.
import { evaluateChecklist } from '../../packages/shared/src/checklists.js';
import type { AssetInsights, Clip, Project, Track } from '../../packages/shared/src/index.js';

function track(kind: Track['kind'], clips: Partial<Clip>[]): Track {
  return {
    id: `${kind}-track`,
    kind,
    clips: clips.map((clip, index) => ({ id: `${kind}-${index}`, start: 0, in: 0, out: 3, ...clip })),
  };
}

function insights(overrides: Partial<AssetInsights> = {}): AssetInsights {
  return {
    assetId: 'asset-1',
    hook: { start: 0, end: 2, text: 'Did you know this?', reason: 'question' },
    highlights: [],
    summary: 'A take.',
    generatedAt: 'now',
    ...overrides,
  };
}

function project(tracks: Track[], duration = 25): Project {
  return { id: 'p1', title: 'Cut', format: '9:16', fps: 30, duration, tracks, version: 1 };
}

/** A talking-head cut that satisfies every criterion. */
function perfectTalkingHead(): Project {
  return project([
    track('video', [
      { assetId: 'asset-1', start: 0, in: 0, out: 3, transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.12, x: 0, y: 0 } },
      { assetId: 'asset-1', start: 3, in: 5, out: 8, transform: { scale: 1.12, x: 0, y: 0 }, transformEnd: { scale: 1, x: 0, y: 0 } },
    ]),
    track('caption', [{ text: 'hello', style: { font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'highlight' } }]),
  ]);
}

const unmet = (result: ReturnType<typeof evaluateChecklist>, id: string) => result.items.find((item) => item.id === id)!;

describe('preset checklists', () => {
  it('scores a full house for the punchy talking head', () => {
    const result = evaluateChecklist('talking_head_punchy', perfectTalkingHead(), [insights()]);
    expect(result.title).toBe('Punchy talking head');
    expect(result.score).toBe(result.total);
    expect(result.total).toBe(5);
    expect(result.items.every((item) => item.met)).toBe(true);
  });

  it('flags a hook that exists in the source but was trimmed out of the cut', () => {
    const doc = perfectTalkingHead();
    // Hook lives at 0-2s of the source; every clip starts at 5s in.
    doc.tracks[0]!.clips = doc.tracks[0]!.clips.map((clip) => ({ ...clip, in: 5, out: 8 }));
    const result = evaluateChecklist('talking_head_punchy', doc, [insights()]);
    const hook = unmet(result, 'hook');
    expect(hook.met).toBe(false);
    expect(hook.suggestion).toMatch(/film a punchy opening line/);
  });

  it('flags missing captions, flat captions, thin punch-ins and long shots one at a time', () => {
    const noCaptions = perfectTalkingHead();
    noCaptions.tracks = noCaptions.tracks.filter((t) => t.kind !== 'caption');
    expect(unmet(evaluateChecklist('talking_head_punchy', noCaptions, [insights()]), 'captions')).toMatchObject({
      met: false, suggestion: expect.stringContaining('burned-in captions'),
    });

    const flat = perfectTalkingHead();
    flat.tracks[1]!.clips[0]!.style!.emphasis = 'bold';
    expect(unmet(evaluateChecklist('talking_head_punchy', flat, [insights()]), 'action_words')).toMatchObject({
      met: false, suggestion: expect.stringContaining('keyword highlighting'),
    });

    const noZoom = perfectTalkingHead();
    noZoom.tracks[0]!.clips = noZoom.tracks[0]!.clips.map(({ transform: _t, transformEnd: _e, ...clip }) => clip);
    expect(unmet(evaluateChecklist('talking_head_punchy', noZoom, [insights()]), 'zoom_ins')).toMatchObject({
      met: false, suggestion: expect.stringContaining('punch-ins'),
    });

    const slow = perfectTalkingHead();
    // maxShotSeconds is 5 for talking_head_punchy.
    slow.tracks[0]!.clips[0] = { ...slow.tracks[0]!.clips[0]!, in: 0, out: 9 };
    expect(unmet(evaluateChecklist('talking_head_punchy', slow, [insights()]), 'pacing').met).toBe(false);
  });

  it('counts a punch-in only when the scale actually moves', () => {
    const doc = perfectTalkingHead();
    doc.tracks[0]!.clips = doc.tracks[0]!.clips.map((clip) => ({
      ...clip, transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1, x: 0, y: 0 },
    }));
    expect(unmet(evaluateChecklist('talking_head_punchy', doc, [insights()]), 'zoom_ins').met).toBe(false);
  });

  it('protects the punchline only when a clip fully covers it', () => {
    const highlights = [{ start: 6, end: 9, text: 'and that is why', score: 0.9, label: 'punchline' }];
    const covered = project([
      track('video', [{ assetId: 'asset-1', start: 0, in: 0, out: 10 }]),
      track('caption', [{ text: 'hi' }]),
    ]);
    const full = evaluateChecklist('standup_clip', covered, [insights({ highlights })]);
    expect(full.title).toBe('Stand-up clip');
    expect(full.score).toBe(4);

    const clipped = project([
      track('video', [{ assetId: 'asset-1', start: 0, in: 0, out: 7 }]),
      track('caption', [{ text: 'hi' }]),
    ]);
    const partial = unmet(evaluateChecklist('standup_clip', clipped, [insights({ highlights })]), 'punchline');
    expect(partial.met).toBe(false);
    expect(partial.suggestion).toMatch(/didn't make the cut/);
  });

  it('checks the stand-up duration against the preset band', () => {
    const short = project([track('video', [{ assetId: 'asset-1', in: 0, out: 6 }])], 6);
    expect(unmet(evaluateChecklist('standup_clip', short, []), 'tight_duration').met).toBe(false);
  });

  it('wants music and quick cuts for the day in the life', () => {
    const doc = project([
      track('video', [
        { assetId: 'asset-1', start: 0, in: 0, out: 2 },
        { assetId: 'asset-1', start: 2, in: 2, out: 4 },
      ]),
      track('audio', [{ assetId: 'music-1', in: 0, out: 20 }]),
      track('caption', [{ text: 'morning' }]),
    ]);
    const result = evaluateChecklist('vlog_montage', doc, [insights()]);
    expect(result.title).toBe('Day in the life');
    expect(result.score).toBe(4);

    const silent = project([...doc.tracks.filter((t) => t.kind !== 'audio')]);
    expect(unmet(evaluateChecklist('vlog_montage', silent, [insights()]), 'music')).toMatchObject({
      met: false, suggestion: expect.stringContaining('music'),
    });

    const lingering = project([
      track('video', [
        { assetId: 'asset-1', start: 0, in: 0, out: 8 },
        { assetId: 'asset-1', start: 8, in: 8, out: 16 },
      ]),
      track('audio', [{ assetId: 'music-1', in: 0, out: 20 }]),
    ]);
    // maxShotSeconds is 3 for vlog_montage.
    expect(unmet(evaluateChecklist('vlog_montage', lingering, [insights()]), 'quick_cuts').met).toBe(false);
  });

  it('scores an empty project as zero without throwing', () => {
    const result = evaluateChecklist('talking_head_punchy', project([], 0), []);
    expect(result.score).toBe(0);
    expect(result.items.every((item) => !item.met && item.suggestion.length > 0)).toBe(true);
  });

  it('throws for a preset with no checklist', () => {
    expect(() => evaluateChecklist('sketch_multicam', project([]), [])).toThrow(/No checklist/);
    expect(() => evaluateChecklist('not_a_preset', project([]), [])).toThrow(/No checklist/);
  });
});
