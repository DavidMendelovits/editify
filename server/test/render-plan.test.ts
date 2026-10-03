import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  audioEntryEnd,
  buildRenderPlan,
  exportPlanSize,
  PLAN_LOUDNESS,
  planCaptionLanes,
  planDuckWindows,
  planFrameCount,
  planVideoTransitions,
  RenderPlanBuildError,
  renderPlanSchema,
  sourceYToScreen,
  type Clip,
  type PlanAssetInfo,
  type PlanTarget,
  type Project,
  type RenderPlan,
  type Track,
} from '@editify/shared';
import { formatAssTime, generateAss } from '../src/media/ass.js';
import { duckExpression, duckWindows } from '../src/media/duck.js';
import { planTransitions } from '../src/media/transitions.js';
import { TARGET_LUFS } from '../src/services/render-qa.js';

/**
 * T2 of the on-device export plan: buildRenderPlan reproduces the legacy
 * server render's timing and layout decisions as a RenderPlan v1. Each
 * scenario mirrors one fixture in packages/shared/fixtures/render-plans/;
 * where the legacy code computes the same number (transitions.ts, duck.ts,
 * ass.ts), the test calls it and compares.
 */
const fixturesDir = fileURLToPath(new URL('../../packages/shared/fixtures/render-plans/', import.meta.url));
function fixture(name: string): RenderPlan {
  return (JSON.parse(readFileSync(`${fixturesDir}${name}.json`, 'utf8')) as { plan: RenderPlan }).plan;
}

const ASSETS: Record<string, PlanAssetInfo> = {
  'asset-talk': { kind: 'video', width: 1080, height: 1920, duration: 30, hasAudio: true, fps: 30 },
  'asset-cutaway': { kind: 'video', width: 1080, height: 1920, duration: 30, hasAudio: true, fps: 30 },
  'asset-a': { kind: 'video', width: 1080, height: 1920, duration: 8, hasAudio: true, fps: 30 },
  'asset-short': { kind: 'video', width: 1080, height: 1920, duration: 2.2, hasAudio: true, fps: 30 },
  'asset-b': { kind: 'video', width: 1080, height: 1920, duration: 8, hasAudio: true, fps: 30 },
  'asset-wide': { kind: 'video', width: 1920, height: 1080, duration: 30, hasAudio: true, fps: 30 },
  'asset-hlg': { kind: 'video', width: 1080, height: 1920, duration: 10, hasAudio: true, fps: 30 },
  'asset-music': { kind: 'audio', width: 0, height: 0, duration: 60, hasAudio: true },
  'asset-voice': { kind: 'audio', width: 0, height: 0, duration: 10, hasAudio: true },
  'asset-logo': { kind: 'image', width: 500, height: 500, duration: 0, hasAudio: false },
  'asset-gif': { kind: 'image', width: 400, height: 300, duration: 2, hasAudio: false, animated: true },
  'asset-city': { kind: 'video', width: 1080, height: 1920, duration: 20, hasAudio: true, fps: 30 },
  'asset-rotated': { kind: 'video', width: 1920, height: 1080, duration: 20, hasAudio: false, rotation: 90 },
};

const PREVIEW: PlanTarget = { kind: 'preview', size: { w: 360, h: 640 }, color: 'sdr' };

function project(tracks: Track[], overrides: Partial<Project> = {}): Project {
  const duration = Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + (clip.out - clip.in) / (clip.speed ?? 1))));
  return { id: 'p', title: 'Plan', format: '9:16', fps: 30, duration, version: 0, tracks, ...overrides };
}

function build(input: Project, target: PlanTarget = PREVIEW, revision = 1, buildSeq = 1): RenderPlan {
  const plan = buildRenderPlan(input, target, { revision, buildSeq, assetInfo: (id) => ASSETS[id] });
  // The builder self-checks, but the test says it out loud too.
  expect(renderPlanSchema.safeParse(plan).success).toBe(true);
  return plan;
}

const video = (clips: Clip[], id = 'video'): Track => ({ id, kind: 'video', clips });
const audio = (clips: Clip[], id = 'audio'): Track => ({ id, kind: 'audio', clips });
const captions = (clips: Clip[], id = 'captions'): Track => ({ id, kind: 'caption', clips });
const overlay = (clips: Clip[], id = 'overlay'): Track => ({ id, kind: 'overlay', clips });

describe('buildRenderPlan: video', () => {
  it('stacks two overlapping video tracks by track (overlapping-video-tracks.json)', () => {
    const plan = build(project([
      video([{ id: 'main', assetId: 'asset-talk', start: 0, in: 0, out: 3 }], 'v0'),
      video([{ id: 'cutaway', assetId: 'asset-cutaway', start: 1, in: 4, out: 5 }], 'v1'),
    ]));
    const expected = fixture('overlapping-video-tracks');
    expect(plan.video).toEqual(expected.video);
    expect(plan.audio).toEqual(expected.audio);
  });

  it('crossfades by borrowing source under an opacity ramp (crossfade.json)', () => {
    const plan = build(project([video([
      { id: 'a', assetId: 'asset-a', start: 0, in: 0, out: 2 },
      { id: 'b', assetId: 'asset-b', start: 2, in: 1, out: 3, transition: { type: 'crossfade', duration: 0.5 } },
    ])]), PREVIEW, 3);
    const expected = fixture('crossfade');
    expect(plan.video).toEqual(expected.video);
    expect(plan.audio).toEqual(expected.audio);
    expect(plan.revision).toBe(3);
  });

  it('holds the last frame where a crossfade outlasts the source (crossfade-hold.json)', () => {
    const plan = build(project([video([
      { id: 'a', assetId: 'asset-short', start: 0, in: 0, out: 2 },
      { id: 'b', assetId: 'asset-b', start: 2, in: 0, out: 2, transition: { type: 'crossfade', duration: 0.6 } },
    ])]));
    const expected = fixture('crossfade-hold');
    // The fixture names its short asset asset-a.
    const renamed = JSON.parse(JSON.stringify(plan).replaceAll('asset-short', 'asset-a')) as RenderPlan;
    expect(renamed.video).toEqual(expected.video);
    expect(renamed.audio).toEqual(expected.audio);
  });

  it('dips through black on both sides of the cut (dip.json)', () => {
    const plan = build(project([video([
      { id: 'a', assetId: 'asset-a', start: 0, in: 0, out: 2 },
      { id: 'b', assetId: 'asset-b', start: 2, in: 0, out: 2, transition: { type: 'dip', duration: 0.6 } },
    ])]));
    const expected = fixture('dip');
    // z is the clip's stacking across the whole track (b above a), so b keeps z 1 when it is alone;
    // the hand-written fixture renumbered it 0. Only the order within a segment matters.
    expected.video.segments[1]!.layers[0]!.z = 1;
    expect(plan.video).toEqual(expected.video);
    expect(plan.audio).toEqual(expected.audio);
  });

  it('turns a matched-aspect zoom into two crop keys (zoom.json)', () => {
    const plan = build(project([video([{
      id: 'talk', assetId: 'asset-talk', start: 0, in: 0, out: 3,
      transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.15, x: 0, y: -0.2 },
    }])]));
    expect(plan.video).toEqual(fixture('zoom').video);
  });

  it('samples a zoom on a mismatched source once per frame, matching the zoompan geometry', () => {
    const clip: Clip = {
      id: 'wide', assetId: 'asset-wide', start: 0, in: 0, out: 1,
      transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.5, x: 0.4, y: -0.3 },
    };
    const plan = build(project([video([clip])]));
    const keys = plan.video.segments[0]!.layers[0]!.cropKeys;
    expect(keys).toHaveLength(31);
    const frame = { width: 360, height: 640 };
    const source = { width: 1920, height: 1080 };
    // safezone.sourceYToScreen follows render.ts's zoompan; the crop key convention must land a source row in the same place.
    for (const key of [keys[0]!, keys[10]!, keys[30]!]) {
      const cover = Math.max(frame.width / source.width, frame.height / source.height) * key.scale;
      const oy = (source.height * cover - frame.height) / 2 * (1 + key.y);
      for (const v of [0.2, 0.5, 0.8]) {
        // Keys carry 6 decimals, so a row lands within a thousandth of a pixel.
        expect(v * source.height * cover - oy).toBeCloseTo(sourceYToScreen(v, clip, key.t, source, frame), 3);
      }
    }
  });

  it('keeps a static crop as one key and matches the static chain geometry', () => {
    const clip: Clip = { id: 'c', assetId: 'asset-wide', start: 0, in: 0, out: 2, transform: { scale: 1.2, x: 0.5, y: -0.4 } };
    const plan = build(project([video([clip])]));
    const [key] = plan.video.segments[0]!.layers[0]!.cropKeys;
    expect(key).toEqual({ t: 0, scale: 1.2, x: 0.5, y: -0.4 });
    const frame = { width: 360, height: 640 };
    const source = { width: 1920, height: 1080 };
    const cover = Math.max(frame.width / source.width, frame.height / source.height) * key!.scale;
    const oy = (source.height * cover - frame.height) / 2 * (1 + key!.y);
    expect(0.3 * source.height * cover - oy).toBeCloseTo(sourceYToScreen(0.3, clip, 0, source, frame), 6);
  });

  it('plays a 2x clip over half the timeline, picture and sound (speed-2x.json)', () => {
    const plan = build(project([video([{ id: 'fast', assetId: 'asset-talk', start: 0, in: 1, out: 5, speed: 2 }])]));
    const expected = fixture('speed-2x');
    expect(plan.video).toEqual(expected.video);
    expect(plan.audio).toEqual(expected.audio);
  });

  it('continues srcStart across segments at the clip speed', () => {
    const plan = build(project([
      video([{ id: 'main', assetId: 'asset-talk', start: 0, in: 2, out: 8, speed: 2 }], 'v0'),
      video([{ id: 'cut', assetId: 'asset-cutaway', start: 1, in: 0, out: 1 }], 'v1'),
    ]));
    const main = plan.video.segments.map((segment) => segment.layers.find((layer) => layer.clipId === 'main')?.srcStart);
    expect(main).toEqual([2, 4, 6]);
  });

  it('agrees with transitions.ts on every transition shape', () => {
    const cases: Array<{ clips: Clip[]; durations: Map<string, number> }> = [
      { clips: [{ id: 'a', assetId: 'x', start: 0, in: 0, out: 2 }, { id: 'b', assetId: 'x', start: 2, in: 0, out: 2, transition: { type: 'crossfade', duration: 0.5 } }], durations: new Map([['x', 8]]) },
      { clips: [{ id: 'a', assetId: 'x', start: 0, in: 0, out: 2 }, { id: 'b', assetId: 'x', start: 2, in: 0, out: 2, transition: { type: 'crossfade', duration: 0.5 } }], durations: new Map([['x', 2.25]]) },
      { clips: [{ id: 'a', assetId: 'x', start: 0, in: 0, out: 4, speed: 2 }, { id: 'b', assetId: 'x', start: 2, in: 0, out: 2, transition: { type: 'crossfade', duration: 0.5 } }], durations: new Map([['x', 8]]) },
      { clips: [{ id: 'a', assetId: 'x', start: 0, in: 0, out: 2 }, { id: 'b', assetId: 'x', start: 2.5, in: 0, out: 2, transition: { type: 'crossfade', duration: 0.5 } }], durations: new Map([['x', 8]]) },
      { clips: [{ id: 'a', assetId: 'x', start: 0, in: 0, out: 0.2 }, { id: 'b', assetId: 'x', start: 0.2, in: 0, out: 2, transition: { type: 'dip', duration: 1 } }], durations: new Map() },
      { clips: [{ id: 'a', assetId: 'x', start: 0, in: 0, out: 2 }, { id: 'b', assetId: 'x', start: 2, in: 0, out: 0.3, transition: { type: 'dip', duration: 2 } }, { id: 'c', assetId: 'x', start: 2.3, in: 0, out: 1, transition: { type: 'crossfade', duration: 0.4 } }], durations: new Map([['x', 2]]) },
    ];
    for (const { clips, durations } of cases) {
      expect(Object.fromEntries(planVideoTransitions(clips, durations, 30))).toEqual(Object.fromEntries(planTransitions(clips, durations, 30)));
    }
  });

  it('draws a still on a video track for its whole span, upright sources sized by their rotation', () => {
    const plan = build(project([video([
      { id: 'still', assetId: 'asset-logo', start: 0, in: 0, out: 1 },
      { id: 'phone', assetId: 'asset-rotated', start: 1, in: 0, out: 1, transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.2, x: 0, y: 0 } },
    ])]));
    expect(plan.video.segments[0]!.layers[0]).toMatchObject({ assetRef: { kind: 'image' }, srcStart: 0, speed: 1 });
    // 1920x1080 turned 90 degrees is 1080x1920, the frame's aspect: two keys, not one per frame.
    expect(plan.video.segments[1]!.layers[0]!.cropKeys).toHaveLength(2);
  });

  it('holds the source\'s last frame when a clip runs past its asset', () => {
    const plan = build(project([video([{ id: 'over', assetId: 'asset-short', start: 0, in: 1, out: 2.5 }])]));
    const [playing, held] = plan.video.segments;
    expect(playing).toMatchObject({ start: 0, end: 1.2 });
    expect(held!.layers[0]!.hold).toEqual({ frameAt: 2.166667 });
  });

  it('quantizes both clip edges with floor(t * fps + 1e-6) and fills gaps with empty segments', () => {
    const plan = build(project([video([
      { id: 'a', assetId: 'asset-talk', start: 0.1, in: 0, out: 1 },
      { id: 'b', assetId: 'asset-talk', start: 1.51, in: 0, out: 0.5 },
    ])]));
    expect(plan.video.segments.map(({ start, end, layers }) => [start * 30, end * 30, layers.length].map((value) => Math.round(value))))
      .toEqual([[0, 3, 0], [3, 33, 1], [33, 45, 0], [45, 60, 1], [60, 61, 0]]);
  });
});

describe('buildRenderPlan: frame grid', () => {
  /** Small deterministic PRNG so the fuzz is the same every run. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  it.each([24, 25, 30, 50, 60, 120])('tiles awkward clip edges exactly at %i fps', (fps) => {
    const next = random(fps);
    const clips = (count: number, prefix: string): Clip[] => Array.from({ length: count }, (_unused, index) => {
      const start = Math.round(next() * 8000) / 1000;
      const length = 0.05 + Math.round(next() * 3000) / 1000;
      return { id: `${prefix}${index}`, assetId: 'asset-talk', start, in: 1, out: 1 + length, speed: [1, 2, 0.5][index % 3]! };
    });
    const input = project([video(clips(6, 'a'), 'v0'), video(clips(4, 'b'), 'v1')], { fps });
    const plan = build(input);
    expect(plan.fps).toBe(fps);
    expect(planFrameCount(plan)).toBe(Math.ceil(input.duration * fps - 1e-6));
    let cursor = 0;
    for (const segment of plan.video.segments) {
      expect(segment.start).toBe(cursor);
      cursor = segment.end;
    }
    expect(cursor).toBe(plan.duration);
  });

  it('refuses a fractional rate such as 29.97 instead of fudging the grid', () => {
    const input = project([video([{ id: 'a', assetId: 'asset-talk', start: 0, in: 0, out: 1 }])]);
    expect(() => buildRenderPlan(input, { ...PREVIEW, fps: 29.97 }, { revision: 0, buildSeq: 0, assetInfo: (id) => ASSETS[id] }))
      .toThrow(RenderPlanBuildError);
  });

  it('rounds the duration up to whole frames', () => {
    const plan = build(project([video([{ id: 'a', assetId: 'asset-talk', start: 0, in: 0, out: 1.01 }])]));
    expect(plan.duration).toBe(31 / 30);
  });
});

describe('buildRenderPlan: audio', () => {
  it('ducks the bed under a voiceover and carries the loudness block (audio-duck-loudness.json)', () => {
    const plan = build(project([
      video([{ id: 'talk', assetId: 'asset-talk', start: 0, in: 0, out: 6 }]),
      audio([{ id: 'bed', assetId: 'asset-music', start: 0, in: 0, out: 6, volume: 0.5 }], 'music'),
      audio([{ id: 'vo', assetId: 'asset-voice', start: 2, in: 0, out: 2, duck: true }], 'voice'),
    ]), PREVIEW, 14);
    const expected = fixture('audio-duck-loudness');
    expect(plan.audio).toEqual(expected.audio);
    expect(plan.loudness).toEqual(expected.loudness);
    expect(plan.loudness.targetLufs).toBe(TARGET_LUFS);
  });

  it('matches duck.ts\'s volume expression sample for sample, merged and close windows included', () => {
    const voices: Clip[] = [
      { id: 'v1', assetId: 'asset-voice', start: 0.05, in: 0, out: 1, duck: true },
      { id: 'v2', assetId: 'asset-voice', start: 1, in: 0, out: 1, duck: true },
      { id: 'v3', assetId: 'asset-voice', start: 2.2, in: 0, out: 0.5, duck: true },
      { id: 'v4', assetId: 'asset-voice', start: 3.5, in: 0, out: 0.08, duck: true },
    ];
    const plan = build(project([
      audio([{ id: 'bed', assetId: 'asset-music', start: 0, in: 0, out: 5, volume: 0.8 }], 'music'),
      audio(voices, 'voice'),
    ]));
    expect(planDuckWindows(voices)).toEqual(duckWindows(voices));
    const expression = duckExpression(duckWindows(voices));
    // The ffmpeg expression is plain arithmetic over clip() and max(); evaluate it directly.
    const legacy = new Function('t', 'clip', 'max', `return ${expression};`) as (t: number, clip: (v: number, lo: number, hi: number) => number, max: (a: number, b: number) => number) => number;
    const bed = plan.audio.find((entry) => entry.id === 'bed')!;
    const gainAt = (time: number): number => {
      const keys = bed.gainKeys;
      if (time <= keys[0]!.t) return keys[0]!.gain;
      for (let index = 1; index < keys.length; index += 1) {
        const right = keys[index]!;
        const left = keys[index - 1]!;
        if (time <= right.t) return left.gain + (right.gain - left.gain) * (time - left.t) / (right.t - left.t);
      }
      return keys.at(-1)!.gain;
    };
    for (let time = 0; time <= 5; time += 0.001) {
      const want = 0.8 * legacy(time, (v, lo, hi) => Math.min(hi, Math.max(lo, v)), Math.max);
      expect(Math.abs(gainAt(time) - want)).toBeLessThan(2e-3);
    }
    // The voices themselves are never ducked.
    expect(plan.audio.filter((entry) => entry.id.startsWith('v')).every((entry) => entry.gainKeys.length === 1)).toBe(true);
  });

  it('declicks short entries with half their length and stops sound at the duration', () => {
    const plan = build(project([
      audio([{ id: 'blip', assetId: 'asset-voice', start: 0, in: 0, out: 0.01 }]),
      audio([{ id: 'long', assetId: 'asset-music', start: 0.5, in: 0, out: 10 }], 'music'),
    ], { duration: 2 }));
    expect(plan.audio[0]!.fadeIn).toEqual({ duration: 0.005, curve: 'halfSine' });
    expect(audioEntryEnd(plan.audio[1]!)).toBeCloseTo(2, 9);
  });

  it('turns loudness off with targetLufs null and keeps the constants', () => {
    const plan = build(project([]), { ...PREVIEW, loudness: false });
    expect(plan.loudness).toEqual({ ...PLAN_LOUDNESS, targetLufs: null });
  });

  it('gives b-roll no sound, as legacy did', () => {
    const plan = build(project([overlay([{ id: 'broll', assetId: 'asset-city', start: 0, in: 3, out: 4 }])]));
    expect(plan.audio).toEqual([]);
  });
});

describe('buildRenderPlan: overlays', () => {
  const overlayProject = (): Project => project([
    video([{ id: 'talk', assetId: 'asset-talk', start: 0, in: 0, out: 4 }]),
    overlay([
      { id: 'sticker-logo', assetId: 'asset-logo', start: 0, in: 0, out: 4, overlay: { x: 0.25, y: 0.1875, width: 100 / 360, rotation: 0 } },
      { id: 'sticker-gif', assetId: 'asset-gif', start: 0.5, in: 0, out: 3, overlay: { x: 0.75, y: 0.21875, width: 1 / 3, rotation: -12 } },
      { id: 'emoji-fire', start: 1, in: 0, out: 2, text: '🔥', overlay: { x: 0.5, y: 300 / 640, width: 100 / 360, rotation: 15 } },
      { id: 'callout-check', start: 1.5, in: 0, out: 2.5, text: 'Do this', callout: { variant: 'check' }, overlay: { x: 0.5, y: 0.75, width: 260 / 360, rotation: -4 } },
      { id: 'broll-city', assetId: 'asset-city', start: 2, in: 3, out: 4.5, overlay: { x: 250 / 360, y: 0.3125, width: 0.5, rotation: 6 } },
    ]),
  ]);

  it('places every overlay kind with its payload (overlays.json)', () => {
    const plan = build(overlayProject());
    const expected = fixture('overlays');
    expect(plan.overlays.map(({ id, kind, z, start, end }) => ({ id, kind, z, start, end })))
      .toEqual(expected.overlays.map(({ id, kind, z, start, end }) => ({ id, kind, z, start, end })));
    const byId = new Map(plan.overlays.map((item) => [item.id, item]));
    const fixtureById = new Map(expected.overlays.map((item) => [item.id, item]));
    for (const id of ['sticker-logo', 'sticker-gif', 'broll-city']) {
      expect(byId.get(id)!.box).toEqual(fixtureById.get(id)!.box);
      expect(byId.get(id)!.media).toMatchObject(fixtureById.get(id)!.media!);
    }
    expect(byId.get('broll-city')!.media).toEqual({ assetRef: { id: 'asset-city', kind: 'video' }, srcStart: 3, speed: 1, loop: false });
    expect(byId.get('sticker-gif')!.media).toEqual({ assetRef: { id: 'asset-gif', kind: 'image' }, srcStart: 0, speed: 1, loop: true });
  });

  it('fits emoji to the box the way the 320 px Apple Color Emoji raster did', () => {
    const fire = build(overlayProject()).overlays.find((item) => item.id === 'emoji-fire')!;
    // One emoji rasterizes 320 x 420 (1 em wide, 1.3125 em tall): a 100 px sticker is 132 px tall.
    expect(fire.box).toEqual({ x: 180, y: 300, w: 100, h: 132, rotationDeg: 15 });
    expect(fire.emoji!.sizePx).toBeCloseTo(100, 6);
    expect(fire.emoji!.width).toBeCloseTo(100, 6);
    expect(fire.emoji!.x).toBeCloseTo(0, 6);
    // Centred vertically: (132 - 131.25) / 2 above the ascent.
    expect(fire.emoji!.y).toBeCloseTo(100.375, 3);
  });

  it('resolves a callout into card, vector glyph and baseline label inside its box', () => {
    const card = build(overlayProject()).overlays.find((item) => item.id === 'callout-check')!;
    const { callout, box } = card;
    expect(callout!.card).toMatchObject({ x: 0, y: 0, w: box.w, h: box.h, color: '#14141BF2' });
    expect(callout!.glyph).toMatchObject({ shape: 'check', color: '#39D98A' });
    expect(callout!.label).toMatchObject({ text: 'Do this', font: 'Montserrat-Bold', color: '#FFFFFF' });
    // Everything sits inside the card: glyph, then the label to its right.
    expect(callout!.glyph!.x + callout!.glyph!.w).toBeLessThan(callout!.label.x);
    expect(callout!.label.x + callout!.label.width).toBeLessThanOrEqual(box.w);
    expect(callout!.label.y).toBeLessThan(box.h);
  });

  it('stacks overlays by track, then start, then id, and drops ones past the duration', () => {
    const plan = build(project([
      video([{ id: 'v', assetId: 'asset-talk', start: 0, in: 0, out: 2 }]),
      overlay([{ id: 'late', start: 1, in: 0, out: 1, text: '🙂' }, { id: 'early', start: 0, in: 0, out: 1, text: '🙂' }], 'o1'),
      overlay([{ id: 'top', start: 0, in: 0, out: 1, text: '🙂' }, { id: 'gone', start: 5, in: 0, out: 1, text: '🙂' }], 'o2'),
    ], { duration: 2 }));
    expect(plan.overlays.map((item) => [item.id, item.z])).toEqual([['early', 0], ['late', 1], ['top', 2]]);
  });
});

const style = { font: 'Montserrat', size: 64, color: '#FFFFFF', emphasis: 'bold' } as const;

describe('buildRenderPlan: captions', () => {
  it('keeps two lanes on screen and trims inside a lane as ass.ts does (captions-multi-lane.json)', () => {
    const input = project([captions([
      { id: 'cap-1', start: 0, in: 0, out: 2, text: 'FIRST LINE', style: { ...style, position: 'bottom' } },
      { id: 'cap-2', start: 1.5, in: 0, out: 1.5, text: 'SECOND LINE', style: { ...style, position: 'bottom' } },
      { id: 'cap-top', start: 0.5, in: 0, out: 2, text: 'TOP TEXT', style: { ...style, position: 'top' } },
    ])]);
    const plan = build(input, { ...PREVIEW, size: { w: 1080, h: 1920 } });
    const expected = fixture('captions-multi-lane');
    const spans = (list: RenderPlan['captions']) => list.map(({ id, start, end, lane }) => ({ id, start, end, lane })).sort((left, right) => left.id.localeCompare(right.id));
    expect(spans(plan.captions)).toEqual(spans(expected.captions));
    // ass.ts's own event times, to the centisecond it writes.
    const ass = generateAss(input, 1080, 1920, { fontFamily: 'Montserrat', safeAreaBottomPct: 12 });
    const dialogue = ass.split('\n').filter((line) => line.startsWith('Dialogue: 0,')).map((line) => line.split(',').slice(1, 3));
    expect(dialogue).toEqual(plan.captions.map((caption) => [formatAssTime(caption.start), formatAssTime(caption.end)]));
  });

  it('drops a caption that lane trimming leaves empty', () => {
    const lanes = planCaptionLanes(project([captions([
      { id: 'a', start: 1, in: 0, out: 2, text: 'one' },
      { id: 'b', start: 1, in: 0, out: 2, text: 'two' },
    ])]));
    expect(lanes.map(({ clip, start, end }) => [clip.id, start, end])).toEqual([['a', 1, 1], ['b', 1, 3]]);
    const plan = build(project([captions([
      { id: 'a', start: 1, in: 0, out: 2, text: 'one' },
      { id: 'b', start: 1, in: 0, out: 2, text: 'two' },
    ])]));
    expect(plan.captions.map((caption) => caption.id)).toEqual(['b']);
  });

  it('lays out a bottom caption the way libass sets it: cell size, safe margin, centred', () => {
    const plan = build(project([captions([{ id: 'c', start: 0, in: 0, out: 1, text: 'HHHH AV', style: { ...style, size: 100, position: 'bottom' } }])]), { ...PREVIEW, size: { w: 1080, h: 1920 } });
    const [caption] = plan.captions;
    // Fontsize 100 is the cell (winAscent + winDescent = 1562 units): em 64.02 px.
    expect(caption!.sizePx).toBeCloseTo(100 * 1000 / 1562, 2);
    // Baseline: 1920 - 230 (12% margin) - winDescent (453/1562 of the cell); libass draws it at row 1661.
    expect(caption!.lines[0]!.y).toBeCloseTo(1920 - 230 - 100 * 453 / 1562, 3);
    expect(caption!.lines[0]!.x + caption!.lines[0]!.width / 2).toBeCloseTo(540, 6);
    expect(caption).toMatchObject({ strokePx: 3, strokeColor: '#000000', shadow: { color: '#000000', offsetPx: 1 }, align: 'center' });
    expect(caption!.box).toBeUndefined();
  });

  it('scales captions with the frame so a preview breaks lines like the export', () => {
    const input = project([captions([{ id: 'c', start: 0, in: 0, out: 1, text: 'THIS CAPTION IS LONG ENOUGH TO WRAP ONTO TWO LINES', style: { ...style, position: 'center' } }])]);
    const big = build(input, { kind: 'export', size: exportPlanSize('9:16', '1080p'), color: 'sdr' }).captions[0]!;
    const small = build(input).captions[0]!;
    expect(small.lines.map((line) => line.text)).toEqual(big.lines.map((line) => line.text));
    expect(small.lines.length).toBeGreaterThan(1);
    small.lines.forEach((line, index) => {
      expect(line.y).toBeCloseTo(big.lines[index]!.y / 3, 2);
      expect(line.width).toBeCloseTo(big.lines[index]!.width / 3, 2);
    });
  });

  it('places karaoke words at absolute times and their own x (caption-karaoke.json)', () => {
    const words = [
      { w: 'HOW', s: 10.2, e: 10.5 }, { w: 'ARE', s: 10.5, e: 10.8 }, { w: 'YOU', s: 10.8, e: 11.1 },
      { w: 'DOING', s: 11.2, e: 11.6 }, { w: 'TODAY', s: 11.7, e: 12.3 },
    ];
    const input = project([captions([{ id: 'cap-k', start: 0.5, in: 0, out: 2.4, text: 'HOW ARE YOU DOING TODAY', style: { ...style, size: 140, position: 'bottom', words } }])]);
    const plan = build(input, { ...PREVIEW, size: { w: 1080, h: 1920 } });
    const caption = plan.captions[0]!;
    const expected = fixture('caption-karaoke').captions[0]!;
    expect(caption.lines.flatMap((line) => line.words!.map(({ w, s, e }) => ({ w, s, e }))))
      .toEqual(expected.lines.flatMap((line) => line.words!.map(({ w, s, e }) => ({ w, s, e }))));
    expect(caption.lines.length).toBe(2);
    for (const line of caption.lines) {
      expect(line.words!.map((word) => word.w).join(' ')).toBe(line.text);
      expect(line.words![0]!.x).toBe(line.x);
    }
    // libass lights word i once the preceding \k durations have elapsed from the event start.
    const ass = generateAss(input, 1080, 1920, { fontFamily: 'Montserrat' });
    const ks = [...ass.matchAll(/\\k(\d+)/g)].map((match) => Number(match[1]) / 100);
    const lit = ks.map((_unused, index) => 0.5 + ks.slice(0, index).reduce((sum, value) => sum + value, 0));
    expect(caption.lines.flatMap((line) => line.words!.map((word) => word.s)).map((s, index) => Math.abs(s - lit[index]!) < 0.006)).not.toContain(false);
  });

  it('shrinks an overflowing caption and flags it, never cutting text (caption-shrunk.json)', () => {
    const text = 'NOBODY TELLS YOU THIS ABOUT RUNNING A MARATHON IN THE POURING RAIN WITH NO SHOES AND A BROKEN WATCH';
    const plan = build(project([captions([{ id: 'cap-long', start: 0, in: 0, out: 3, text, style: { ...style, size: 120, position: 'bottom' } }])]));
    const caption = plan.captions[0]!;
    expect(caption.fitted.shrunk).toBe(true);
    expect(caption.fitted.scale).toBeLessThan(1);
    expect(caption.lines.length).toBeLessThanOrEqual(3);
    expect(caption.lines.map((line) => line.text).join(' ')).toBe(text);
    for (const line of caption.lines) expect(line.width).toBeLessThanOrEqual(360 - 2 * 40 / 3 + 1e-6);
    expect(fixture('caption-shrunk').captions[0]!.fitted.shrunk).toBe(true);
  });

  it('changes rev with anything visible and keeps it across a time-only move', () => {
    const base: Clip = { id: 'c', start: 0, in: 0, out: 1, text: 'HELLO', style: { ...style, position: 'bottom' } };
    const rev = (clip: Clip): string => build(project([captions([clip])], { duration: 3 })).captions[0]!.rev;
    const original = rev(base);
    expect(rev({ ...base, start: 1 })).toBe(original);
    expect(rev({ ...base, text: 'HELLO!' })).not.toBe(original);
    expect(rev({ ...base, style: { ...base.style!, color: '#FF0000' } })).not.toBe(original);
    expect(rev({ ...base, style: { ...base.style!, position: 'top' } })).not.toBe(original);
  });
});

describe('buildRenderPlan: whole plans', () => {
  it('builds the HLG plan with the target colour (hlg-color.json)', () => {
    const plan = build(project([
      video([{ id: 'sunset', assetId: 'asset-hlg', start: 0, in: 0, out: 2 }]),
      captions([{ id: 'cap-hdr', start: 0, in: 0, out: 2, text: 'GOLDEN HOUR' }]),
    ]), { ...PREVIEW, color: 'hlg' }, 13);
    const expected = fixture('hlg-color');
    expect(plan.color).toBe('hlg');
    expect(plan.audio).toEqual(expected.audio);
    expect(plan.video).toEqual(expected.video);
  });

  it('builds an empty project as a zero-length plan (empty-project.json)', () => {
    const plan = build(project([video([]), captions([])]), PREVIEW, 0, 1);
    expect(plan).toEqual(fixture('empty-project'));
  });

  it('passes revision and buildSeq through and builds byte-identical JSON twice', () => {
    const input = project([
      video([{ id: 'a', assetId: 'asset-a', start: 0, in: 0, out: 2 }, { id: 'b', assetId: 'asset-wide', start: 2, in: 0, out: 2, transition: { type: 'crossfade', duration: 0.5 }, transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.3, x: 0.2, y: 0 } }]),
      audio([{ id: 'vo', assetId: 'asset-voice', start: 0.5, in: 0, out: 2, duck: true }]),
      captions([{ id: 'k', start: 0, in: 0, out: 3, text: 'one two three', style: { ...style, position: 'bottom', words: [{ w: 'one', s: 0, e: 0.5 }, { w: 'two', s: 0.5, e: 1 }, { w: 'three', s: 1, e: 2 }] } }]),
      overlay([{ id: 'e', start: 0, in: 0, out: 1, text: '👍🏽🔥' }]),
    ]);
    const first = JSON.stringify(build(input, PREVIEW, 42, 7));
    const second = JSON.stringify(build(structuredClone(input), PREVIEW, 42, 7));
    expect(first).toBe(second);
    const plan = JSON.parse(first) as RenderPlan;
    expect([plan.revision, plan.buildSeq, plan.requires]).toEqual([42, 7, []]);
  });

  it('sizes exports like render.ts and keeps preview sizes even', () => {
    expect(exportPlanSize('9:16', '1080p')).toEqual({ w: 1080, h: 1920 });
    expect(exportPlanSize('16:9', '720p')).toEqual({ w: 1280, h: 720 });
    expect(exportPlanSize('1:1', '4k')).toEqual({ w: 2160, h: 2160 });
    expect(build(project([]), { ...PREVIEW, size: { w: 393, h: 699 } }).size).toEqual({ w: 394, h: 700 });
  });

  it('names a missing asset instead of guessing', () => {
    const input = project([video([{ id: 'a', assetId: 'nowhere', start: 0, in: 0, out: 1 }])]);
    expect(() => buildRenderPlan(input, PREVIEW, { revision: 0, buildSeq: 0, assetInfo: () => undefined })).toThrow(/nowhere/);
  });
});
