import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTION_FONT_FACE,
  CAPTION_FONTS,
  captionFaceFor,
  captionStyleSchema,
  DEFAULT_CAPTION_FONT,
  parseRenderPlanForExecutor,
  PLAN_FONT_FACES,
  PLAN_LIMITS,
  planFrameAt,
  planFrameCount,
  renderPlanSchema,
  UnsupportedPlanError,
  type RenderPlan,
} from '@editify/shared';

/**
 * T1 of the on-device export plan: the frozen RenderPlan v1 contract. Every
 * fixture here is also a golden-frame input for the Swift renderer and the
 * server, so they must stay valid; the invalid cases pin the errors an
 * executor relies on the schema to catch.
 */
const fixturesDir = fileURLToPath(new URL('../../packages/shared/fixtures/render-plans/', import.meta.url));
const fixtureNames = readdirSync(fixturesDir).filter((name) => name.endsWith('.json')).sort();

interface Fixture { description: string; plan: RenderPlan }

function load(name: string): Fixture {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, 'utf8')) as Fixture;
}

/** A deep copy of a fixture's plan, for breaking one thing at a time. */
function planFrom(name: string): RenderPlan {
  return structuredClone(load(`${name}.json`).plan);
}

/** Every issue as "path: message", so a failing case reads well. */
function issues(plan: unknown): string[] {
  const result = renderPlanSchema.safeParse(plan);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('render plan fixtures', () => {
  it('has fixtures to check', () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(13);
  });

  it.each(fixtureNames)('%s parses and round-trips unchanged', (name) => {
    const fixture = load(name);
    expect(fixture.description).toMatch(/^[^\n]{20,}$/);
    expect(issues(fixture.plan)).toEqual([]);
    // No defaults or transforms in the contract: what a builder writes is what an executor reads.
    expect(renderPlanSchema.parse(fixture.plan)).toEqual(fixture.plan);
  });

  it('covers every clip kind and edge the executors must draw', () => {
    const plans = fixtureNames.map((name) => renderPlanSchema.parse(load(name).plan));
    const layers = plans.flatMap((plan) => plan.video.segments.flatMap((segment) => segment.layers));
    const captions = plans.flatMap((plan) => plan.captions);
    expect(new Set(plans.flatMap((plan) => plan.overlays.map((overlay) => overlay.kind))))
      .toEqual(new Set(['image', 'gif', 'emoji', 'callout', 'broll']));
    expect(plans.flatMap((plan) => plan.overlays).filter((overlay) => overlay.box.rotationDeg !== 0).length).toBeGreaterThanOrEqual(4);
    expect(plans.some((plan) => plan.video.segments.some((segment) => new Set(segment.layers.map((layer) => layer.trackIndex)).size > 1))).toBe(true);
    expect(layers.some((layer) => layer.hold)).toBe(true);
    expect(layers.some((layer) => layer.opacityKeys.length > 0)).toBe(true);
    expect(layers.some((layer) => layer.dimKeys?.length)).toBe(true);
    expect(layers.some((layer) => layer.cropKeys.length > 1)).toBe(true);
    expect(layers.some((layer) => layer.speed === 2)).toBe(true);
    expect(captions.some((caption) => caption.lines.some((line) => line.words))).toBe(true);
    expect(captions.some((caption) => caption.fitted.shrunk)).toBe(true);
    expect(new Set(captions.map((caption) => caption.lane)).size).toBeGreaterThan(1);
    expect(plans.some((plan) => plan.color === 'hlg')).toBe(true);
    expect(plans.some((plan) => plan.audio.some((entry) => entry.gainKeys.length > 2) && plan.loudness.targetLufs !== null)).toBe(true);
    // The v1 builder never emits a raster (the device uploads one with a snapshot, T8); the schema still takes one.
    const withRaster = planFrom('overlays');
    withRaster.overlays[3]!.raster = { id: 'raster-callout-check', kind: 'image' };
    expect(issues(withRaster)).toEqual([]);
    expect(plans.every((plan) => plan.requires.length === 0)).toBe(true);
    expect(plans.some((plan) => plan.duration === 0 && plan.video.segments.length === 0)).toBe(true);
  });
});

describe('invalid render plans', () => {
  it('requires a revision and a build sequence', () => {
    const plan: Partial<RenderPlan> = planFrom('crossfade');
    delete plan.revision;
    delete plan.buildSeq;
    expect(issues(plan)).toEqual(['revision: Required', 'buildSeq: Required']);
  });

  it('refuses required features it does not know, in the strict builder check', () => {
    expect(issues({ ...planFrom('crossfade'), requires: ['animated-captions'] })).toEqual(['requires.0: unknown required feature "animated-captions"']);
    const plan: Partial<RenderPlan> = planFrom('crossfade');
    delete plan.requires;
    expect(issues(plan)).toEqual(['requires: Required']);
  });

  it('refuses another version', () => {
    expect(issues({ ...planFrom('crossfade'), version: 2 })).toEqual([expect.stringMatching(/^version: Invalid literal value, expected 1/)]);
  });

  it('refuses a field the contract does not define', () => {
    expect(issues({ ...planFrom('crossfade'), projectId: 'p' })).toEqual([expect.stringMatching(/Unrecognized key.*projectId/)]);
  });

  it('refuses spans that end before they start', () => {
    const plan = planFrom('overlays');
    plan.overlays[0]!.end = plan.overlays[0]!.start - 0.5;
    expect(issues(plan)).toContain('overlays.0.end: overlay end -0.5 must be after its start 0');

    const captions = planFrom('captions-multi-lane');
    captions.captions[0]!.end = 0;
    expect(issues(captions)).toContain('captions.0.end: caption end 0 must be after its start 0');

    const sound = planFrom('crossfade');
    sound.audio[0]!.out = sound.audio[0]!.in;
    expect(issues(sound)).toContain('audio.0.out: audio out 0 must be after its in 0');
  });

  it('refuses a segment that ends before it starts, and gaps between segments', () => {
    const backwards = planFrom('crossfade');
    backwards.video.segments[1]!.end = 1.5;
    expect(issues(backwards)).toEqual(expect.arrayContaining([
      'video.segments.1.end: segment end 1.5 must be after its start 2',
      'video.segments.2.start: segment 2 starts at 2.5 but the previous one ends at 1.5; joins must be exact',
    ]));

    const short = planFrom('crossfade');
    short.duration = 5;
    expect(issues(short)).toEqual(['video.segments.2.end: the last segment ends at 4, not at duration 5']);

    // Joins are exact, not within a tolerance: a 1e-9 gap is a gap.
    const loose = planFrom('crossfade');
    loose.video.segments[1]!.start = 2 + 1e-9;
    expect(issues(loose)).toEqual([expect.stringMatching(/^video\.segments\.1\.start: segment 1 starts at 2\.000000001 but the previous one ends at 2; joins must be exact/)]);

    const offGrid = planFrom('crossfade');
    offGrid.video.segments[0]!.end = 2.01;
    offGrid.video.segments[1]!.start = 2.01;
    expect(issues(offGrid)).toContain('video.segments.0.end: segment end 2.01 is not on the 1/30 s frame grid');

    const empty = planFrom('empty-project');
    empty.duration = 1;
    expect(issues(empty)).toEqual([expect.stringMatching(/^video\.segments: segments must cover \[0, 1\]/)]);
  });

  it('refuses negative and zero speeds', () => {
    const plan = planFrom('speed-2x');
    plan.video.segments[0]!.layers[0]!.speed = -2;
    plan.audio[0]!.speed = 0;
    expect(issues(plan)).toEqual([
      'video.segments.0.layers.0.speed: Number must be greater than or equal to 0.1',
      'audio.0.speed: Number must be greater than or equal to 0.1',
    ]);
  });

  it('refuses ambiguous stacking: two layers or two overlays sharing a z', () => {
    const tracks = planFrom('overlapping-video-tracks');
    tracks.video.segments[1]!.layers[1]!.z = 0;
    expect(issues(tracks)).toEqual(['video.segments.1.layers.1.z: layers 0 and 1 share z 0; stacking order must be explicit']);

    const overlays = planFrom('overlays');
    overlays.overlays[3]!.z = 1;
    expect(issues(overlays)).toEqual(['overlays.3.z: overlays 1 and 3 share z 1; stacking order must be explicit']);
  });

  it('refuses a caption font that is not bundled', () => {
    const plan = planFrom('captions-multi-lane') as unknown as { captions: Array<{ font: string }> };
    plan.captions[0]!.font = 'Inter';
    expect(issues(plan)).toEqual([expect.stringMatching(/^captions\.0\.font: Invalid enum value\. Expected 'Montserrat-Bold', received 'Inter'/)]);
  });

  it('refuses keys outside their segment or entry, or out of order', () => {
    const zoom = planFrom('zoom');
    zoom.video.segments[0]!.layers[0]!.cropKeys[1]!.t = 3.5;
    expect(issues(zoom)).toEqual(['video.segments.0.layers.0.cropKeys.1.t: key at t=3.5 is outside the segment [0, 3]']);

    const crossfade = planFrom('crossfade');
    crossfade.video.segments[1]!.layers[1]!.opacityKeys[1]!.t = 2.6;
    expect(issues(crossfade)).toEqual(['video.segments.1.layers.1.opacityKeys.1.t: key at t=2.6 is outside the segment [2, 2.5]']);

    const dip = planFrom('dip');
    dip.video.segments[0]!.layers[0]!.dimKeys![1]!.t = 1.7;
    expect(issues(dip)).toEqual(['video.segments.0.layers.0.dimKeys.1.t: key at t=1.7 must come after the previous key at t=1.7']);

    const duck = planFrom('audio-duck-loudness');
    duck.audio[2]!.gainKeys = [{ t: 1, gain: 1 }];
    expect(issues(duck)).toEqual(['audio.2.gainKeys.0.t: key at t=1 is outside the audio entry [2, 4]']);
  });

  it('refuses karaoke words outside the caption, and words that do not spell the line', () => {
    const late = planFrom('caption-karaoke');
    late.captions[0]!.lines[1]!.words![1]!.e = 3;
    expect(issues(late)).toEqual([
      'captions.0.lines.1.words.1: word "TODAY" [2, 3] is outside the caption\'s time [0.5, 2.9]; word times are absolute timeline seconds',
    ]);

    // Source-relative times (the document's words[0].s convention) are the classic mistake.
    const relative = planFrom('caption-karaoke');
    relative.captions[0]!.lines[0]!.words![0]!.s = 10.2;
    expect(issues(relative)[0]).toMatch(/word "HOW" \[10\.2, 0\.8\] is outside the caption's time/);

    const misspelt = planFrom('caption-karaoke');
    misspelt.captions[0]!.lines[0]!.text = 'HOW R U';
    expect(issues(misspelt)).toEqual(['captions.0.lines.0.words: the line\'s words joined by spaces must equal its text']);
  });

  it('refuses two captions sharing a lane at the same time', () => {
    const plan = planFrom('captions-multi-lane');
    // The builder lists captions in timeline order: cap-1, cap-top, cap-2.
    plan.captions[2]!.start = 1.2;
    expect(issues(plan)).toEqual(['captions.2.start: captions cap-1 and cap-2 overlap in lane 0; a lane shows one caption at a time']);
  });

  it('refuses a shrink receipt that contradicts its scale', () => {
    const plan = planFrom('caption-shrunk');
    plan.captions[0]!.fitted.scale = 1;
    expect(issues(plan)).toEqual(['captions.0.fitted.scale: a shrunk caption has a scale below 1']);
  });

  it('refuses overlay payloads that do not match their kind', () => {
    const plan = planFrom('overlays');
    const emoji = plan.overlays[2]!;
    emoji.media = { assetRef: { id: 'asset-logo', kind: 'image' }, srcStart: 0, speed: 1 };
    const broll = plan.overlays[4]!;
    broll.media!.assetRef.kind = 'image';
    delete plan.overlays[3]!.callout;
    plan.overlays[0]!.raster = { id: 'raster-logo', kind: 'image' };
    expect(issues(plan)).toEqual([
      'overlays.0.raster: a image overlay has no raster; its media is the picture',
      'overlays.2.media: a emoji overlay carries no media',
      'overlays.3.callout: a callout overlay needs its callout payload',
      'overlays.4.media.assetRef.kind: a broll overlay needs a video asset, not image',
    ]);
  });

  it('refuses a callout whose vector glyph does not match its variant', () => {
    const plan = planFrom('overlays');
    plan.overlays[3]!.callout!.glyph!.shape = 'cross';
    expect(issues(plan)).toEqual(['overlays.3.callout.glyph: a check callout draws the check glyph']);
    delete plan.overlays[3]!.callout!.glyph;
    plan.overlays[3]!.callout!.variant = 'card';
    expect(issues(plan)).toEqual([]);
  });

  it('refuses a limiter ceiling above the true-peak limit', () => {
    const plan = planFrom('audio-duck-loudness');
    plan.loudness.limiterCeilingDb = -0.5;
    expect(issues(plan)).toEqual(['loudness.limiterCeilingDb: the limiter ceiling must sit at or under the true-peak limit']);
  });

  it('refuses anything that runs past the plan duration', () => {
    const plan = planFrom('overlays');
    plan.overlays[0]!.end = 4.5;
    plan.audio[0]!.out = 5;
    expect(issues(plan)).toEqual([
      'overlays.0.end: overlay ends at 4.5, past duration 4',
      'audio.0: audio entry ends at 5, past duration 4',
    ]);
  });
});

describe('hostile plans', () => {
  it('caps the frame size at 3840 x 2160 either way round', () => {
    expect(issues({ ...planFrom('crossfade'), size: { w: 3840, h: 2160 } })).toEqual([]);
    expect(issues({ ...planFrom('crossfade'), size: { w: 2160, h: 3840 } })).toEqual([]);
    expect(issues({ ...planFrom('crossfade'), size: { w: 3840, h: 3840 } })).toEqual(['size: the shorter side must be at most 2160 px']);
    expect(issues({ ...planFrom('crossfade'), size: { w: 8192, h: 1080 } })).toEqual(['size.w: Number must be less than or equal to 3840']);
  });

  it('caps text, ids, requires and array lengths', () => {
    const long = planFrom('captions-multi-lane');
    long.captions[0]!.lines[0]!.text = 'A'.repeat(PLAN_LIMITS.textChars + 1);
    expect(issues(long)).toEqual(['captions.0.lines.0.text: String must contain at most 500 character(s)']);

    const many = { ...planFrom('crossfade'), requires: Array.from({ length: PLAN_LIMITS.requires + 1 }, (_unused, index) => `f${index}`) };
    expect(issues(many)).toContain('requires: Array must contain at most 32 element(s)');

    const crowded = planFrom('overlays');
    crowded.video.segments[0]!.layers = Array.from({ length: PLAN_LIMITS.layersPerSegment + 1 }, (_unused, index) => ({ ...crowded.video.segments[0]!.layers[0]!, z: index }));
    expect(issues(crowded)).toEqual(['video.segments.0.layers: Array must contain at most 32 element(s)']);

    expect(issues({ ...planFrom('empty-project'), duration: PLAN_LIMITS.durationSec + 1 })).toContain('duration: Number must be less than or equal to 14400');
  });

  it('keeps the unsupported-feature message bounded', () => {
    const plan = { ...planFrom('crossfade'), requires: Array.from({ length: 20 }, () => 'x'.repeat(1000)) };
    let message = '';
    try {
      parseRenderPlanForExecutor(plan);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/and 15 more$/);
    expect(message.length).toBeLessThan(500);
  });
});

describe('executor parsing', () => {
  it('ignores unknown non-critical keys', () => {
    const plan = { ...planFrom('crossfade'), addedInV1_1: true, overlays: [{ ...planFrom('overlays').overlays[0]!, glow: 0.4 }] };
    expect(issues(plan).length).toBe(2);
    const parsed = parseRenderPlanForExecutor(plan);
    expect(parsed).not.toHaveProperty('addedInV1_1');
    expect(parsed.overlays[0]).not.toHaveProperty('glow');
  });

  it('refuses a plan that requires a feature it does not draw, naming it', () => {
    const plan = { ...planFrom('overlays'), requires: ['overlay-kind-lottie'] };
    plan.overlays[0] = { ...plan.overlays[0]!, kind: 'lottie' as never };
    expect(() => parseRenderPlanForExecutor(plan)).toThrow(UnsupportedPlanError);
    expect(() => parseRenderPlanForExecutor(plan)).toThrow('overlay-kind-lottie');
  });

  it('quantizes times to frames with floor(t * fps + 1e-6), exact frame times included', () => {
    // Legacy Math.trunc(t / (1 / fps)) gives 60 here: one frame early.
    expect(planFrameAt(61 / 30, 30)).toBe(61);
    expect(planFrameAt(2.2, 30)).toBe(66);
    expect(planFrameAt(2.21, 30)).toBe(66);
    expect(planFrameAt(0, 30)).toBe(0);
  });

  it('counts output frames as ceil(duration * fps - 1e-6)', () => {
    expect(planFrameCount({ duration: 2.2, fps: 30 })).toBe(66);
    expect(planFrameCount({ duration: 0, fps: 30 })).toBe(0);
    expect(planFrameCount({ duration: 1.01, fps: 30 })).toBe(31);
  });
});

describe('caption fonts (OV7)', () => {
  it('maps every caption family to a bundled face', () => {
    expect(CAPTION_FONTS).toContain(DEFAULT_CAPTION_FONT);
    for (const font of CAPTION_FONTS) expect(PLAN_FONT_FACES).toContain(CAPTION_FONT_FACE[font]);
  });

  it.each([['Montserrat'], ['Inter'], ['Space Grotesk'], [undefined]])('draws document font %j in Montserrat Bold', (font) => {
    expect(captionFaceFor(font)).toBe('Montserrat-Bold');
  });

  it('leaves the document field free text, so stored projects and their hashes do not change', () => {
    expect(captionStyleSchema.parse({ font: 'Helvetica Neue' }).font).toBe('Helvetica Neue');
    expect(captionStyleSchema.parse({}).font).toBe('Montserrat');
  });
});
