import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPlanSchema } from '@editify/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Plan 9A: golden frames from the phone's renderer. The macOS harness
 * (apps/mobile/modules/editify-engine/parity/render-golden) synthesizes test
 * media, renders every RenderPlan fixture through PlanBuilder +
 * EditifyCompositor (the code exportProject and the native preview run), and
 * reports pixels. This test holds it to the committed goldens and to exact
 * values: decoded frame indices (sampling, speed, holds), linear-light blends,
 * the colour pipeline across SDR/HLG/PQ sources, caption white at reference
 * white, karaoke states, GIF timing, EXIF orientation, audio gains.
 *
 * Needs swiftc (macOS). Elsewhere it skips, except where REQUIRE_SWIFT=1
 * (the macOS CI `engine` job): there a missing toolchain fails.
 * Re-bless after an intended visual change: UPDATE_GOLDENS=1 npx vitest run test/render-golden.test.ts
 * (writes straight into parity/goldens; review the PNGs, then commit).
 *
 * Re-bless from CI: the goldens were blessed on a local Mac (macOS 27, Xcode
 * 26.6) and CI runs macos-26, so a first CI run may need its own. With
 * GOLDEN_OUT_DIR set, the rendered PNGs (named exactly like the goldens) and
 * diffs/ (|rendered - golden| x 4) stay there; the engine job uploads that
 * directory as the `render-goldens` artifact when it fails. To adopt CI's
 * frames: download the artifact, copy its top-level *.png (not diffs/) over
 * apps/mobile/modules/editify-engine/parity/goldens/, check them by eye, commit.
 *
 * Golden tolerance, on PNGs of the ENCODED output (8-bit SDR, 16-bit HLG;
 * 1080x1920 plans compared at half size): per-channel mean absolute
 * difference <= 0.01 (about 2.5/255) and, after a 5x5 box blur of the
 * per-pixel worst-channel difference, a maximum <= 0.1. The first catches a
 * global shift (a colour or gamma change), the second a local one (a caption
 * or overlay moved or missing) while letting through encoder and GPU noise
 * on edges (ProRes vs H.264 sources, Metal vs the CPU renderer on CI VMs).
 */
const root = resolve(fileURLToPath(import.meta.url), '../../..');
const engine = join(root, 'apps/mobile/modules/editify-engine');
const goldens = join(engine, 'parity/goldens');
const swiftAvailable = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;
const required = process.env.REQUIRE_SWIFT === '1';
const bless = process.env.UPDATE_GOLDENS === '1';
const MEAN_ABS_MAX = 0.01;
const BLURRED_MAX = 0.1;

type Vec = [number, number, number];
interface Probe { encoded?: Vec; linear?: Vec; brightestLinear?: Vec; brightestEncoded?: Vec }
interface Frame {
  k: number;
  code?: number;
  tags: { primaries: string; transfer: string; matrix: string };
  probes: Record<string, Probe>;
  golden?: string;
  compare?: { meanAbs?: Vec; blurredMax?: number; missingGolden?: boolean; sizeMismatch?: boolean };
}
interface Render {
  name: string;
  emptyPlanRefused?: boolean;
  instructions?: number;
  durationSeconds?: number;
  frames?: Frame[];
  sequentialCodes?: number[];
  audioEdits?: Array<{ end: number; edits: number; scaled: number; carrier: boolean }>;
  audio?: {
    samples: number;
    overshootDropped: number;
    windows: Record<string, Record<string, number>>;
    left: Record<string, Record<string, number>>;
    right: Record<string, Record<string, number>>;
  };
}
interface Report {
  media: Record<string, Record<string, unknown>>;
  checks: Record<string, Record<string, unknown>>;
  renders: Render[];
}

let dir: string | undefined;
let report: Report;
/** Kept after the run when set (CI uploads it on failure). */
const keepOut = process.env.GOLDEN_OUT_DIR;

// Async on purpose: the build and the render take minutes on a CI runner, and a
// blocked event loop starves vitest's worker RPC ("Timeout calling onTaskUpdate").
const run = promisify(execFile);

beforeAll(async () => {
  if (!swiftAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'editify-render-golden-'));
  const binary = join(dir, 'render-golden');
  const sources = ['RenderPlan', 'PlanBuilder', 'EditifyCompositor', 'CaptionRenderer', 'OverlayGraphics', 'AnalysisMath']
    .map((name) => join(engine, 'ios', `${name}.swift`));
  const harness = ['HarnessMedia.swift', 'main.swift'].map((name) => join(engine, 'parity/render-golden', name));
  await run('xcrun', ['swiftc', '-O', '-swift-version', '5', ...sources, ...harness, '-o', binary], { maxBuffer: 64 << 20 });
  const args = [join(goldens, 'manifest.json'), root, join(dir, 'work'), keepOut ?? join(dir, 'out'), ...(bless ? ['--bless'] : [])];
  report = JSON.parse((await run(binary, args, { encoding: 'utf8', maxBuffer: 64 << 20 })).stdout) as Report;
}, 600000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function render(name: string): Render {
  const found = report.renders.find((item) => item.name === name);
  if (!found) throw new Error(`no render ${name}`);
  return found;
}
function frame(name: string, k: number): Frame {
  const found = render(name).frames?.find((item) => item.k === k);
  if (!found) throw new Error(`no frame ${k} in ${name}`);
  return found;
}
function probe(name: string, k: number, id: string): Probe {
  const found = frame(name, k).probes[id];
  if (!found) throw new Error(`no probe ${id} at ${name}#${k}`);
  return found;
}
function close(actual: readonly number[] | undefined, expected: readonly number[], tolerance: number): void {
  expect(actual).toBeDefined();
  actual!.forEach((value, index) => expect(Math.abs(value - expected[index]!), `channel ${index}: ${value} vs ${expected[index]}`).toBeLessThanOrEqual(tolerance));
}
const grey = (value: number): Vec => [value, value, value];
const mix = (a: Vec, b: Vec, alpha: number): Vec => [0, 1, 2].map((c) => a[c]! * (1 - alpha) + b[c]! * alpha) as Vec;
const scale = (a: Vec, factor: number): Vec => a.map((value) => value * factor) as Vec;
/** sRGB hex to linear (BT.709 primaries; neutral greys are the same in BT.2020). */
const srgbLinear = (byte: number): number => {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const tone = (name: string, window: string, hz: number): number => render(name).audio!.windows[window]![String(hz)]!;

describe('render goldens: harness availability', () => {
  it.runIf(required)('has swiftc where REQUIRE_SWIFT=1', () => {
    expect(swiftAvailable).toBe(true);
  });

  it('bundles the same caption font file as the server (OV7)', () => {
    expect(readFileSync(join(engine, 'ios/Fonts/Montserrat-Bold.ttf')).equals(readFileSync(join(root, 'server/fonts/Montserrat-Bold.ttf')))).toBe(true);
  });

  it('harness-only plans are valid RenderPlans', () => {
    for (const file of readdirSync(join(goldens, 'plans'))) {
      const { plan } = JSON.parse(readFileSync(join(goldens, 'plans', file), 'utf8')) as { plan: unknown };
      expect(() => renderPlanSchema.parse(plan), file).not.toThrow();
    }
  });
});

describe.skipIf(!swiftAvailable)('render goldens (EditifyCompositor on macOS)', () => {
  it('matches every committed golden frame', () => {
    const golden = report.renders.flatMap((item) => (item.frames ?? []).filter((f) => f.golden).map((f) => ({ name: item.name, f })));
    expect(golden.length).toBeGreaterThan(20);
    for (const { name, f } of golden) {
      const label = `${name}#${f.k} (${f.golden})`;
      expect(f.compare?.missingGolden, `${label}: golden missing; bless with UPDATE_GOLDENS=1`).toBeUndefined();
      expect(f.compare?.sizeMismatch, label).toBeUndefined();
      for (const value of f.compare!.meanAbs!) expect(value, `${label} mean abs`).toBeLessThanOrEqual(MEAN_ABS_MAX);
      expect(f.compare!.blurredMax!, `${label} blurred max`).toBeLessThanOrEqual(BLURRED_MAX);
    }
  });

  const planFile = (name: string): string => {
    const harnessOnly = join(goldens, 'plans', `${name}.json`);
    return readdirSync(join(goldens, 'plans')).includes(`${name}.json`) ? harnessOnly : join(root, 'packages/shared/fixtures/render-plans', `${name}.json`);
  };

  it('builds one instruction per plan segment and lasts exactly the plan, picture and sound', () => {
    for (const item of report.renders) {
      const fixture = planFile(item.name);
      const { plan } = JSON.parse(readFileSync(fixture, 'utf8')) as { plan: { duration: number; video: { segments: unknown[] } } };
      if (plan.duration === 0) {
        expect(item.emptyPlanRefused, item.name).toBe(true);
        continue;
      }
      expect(item.instructions, item.name).toBe(plan.video.segments.length);
      expect(item.durationSeconds, item.name).toBeCloseTo(plan.duration, 6);
      // Audio tracks (with the silent carrier) end at the plan's end, so the mix is exactly as long.
      if (item.audioEdits && item.audioEdits.length > 0) {
        expect(Math.max(...item.audioEdits.map((edit) => edit.end)), item.name).toBeCloseTo(plan.duration, 6);
      }
      if (item.audio) expect(item.audio.samples, item.name).toBe(Math.round(plan.duration * 48000));
    }
    expect(render('trailing-carrier').audio!.samples).toBe(144000);
    // A 2x entry ending at the plan's end: time-pitch emits past the end, PlanMixTrim drops it.
    expect(render('fast-audio-end').audio!.samples).toBe(96000);
    expect(render('fast-audio-end').audio!.overshootDropped).toBeGreaterThan(0);
    expect(tone('fast-audio-end', 'fast', 220)).toBeCloseTo(0.25, 2);
    expect(render('mixed-color-hlg').audio!.samples).toBe(96000);
  });

  it('time-scales audio only for speed != 1, and back-to-back entries do not split each other', () => {
    for (const item of report.renders) {
      const scaled = (item.audioEdits ?? []).reduce((sum, edit) => sum + edit.scaled, 0);
      expect(scaled, item.name).toBe(['speed-2x', 'fast-audio-end'].includes(item.name) ? 1 : 0);
    }
    // a (0-1 s) and b (1-2 s) share one track as two whole edits ending at 2 s; the carrier fills 2-3 s.
    const edits = render('trailing-carrier').audioEdits!;
    expect(edits.find((edit) => !edit.carrier)).toMatchObject({ edits: 2, end: 2 });
    expect(edits.find((edit) => edit.carrier)).toMatchObject({ edits: 1, end: 3 });
    expect(tone('trailing-carrier', 'a', 220)).toBeCloseTo(0.25, 2);
    expect(tone('trailing-carrier', 'a', 440)).toBeLessThan(0.005);
    expect(tone('trailing-carrier', 'b', 440)).toBeCloseTo(0.25, 2);
    expect(tone('trailing-carrier', 'b', 220)).toBeLessThan(0.005);
    expect(Math.max(tone('trailing-carrier', 'tail', 220), tone('trailing-carrier', 'tail', 440))).toBeLessThan(0.001);
  });

  it('reads every frame in order with the right source frame (sequential pass)', () => {
    expect(render('speed-2x').sequentialCodes).toEqual(Array.from({ length: 60 }, (_, k) => 30 + 2 * k));
    // crossfade-hold: a plays to 2.2 s, then holds frame 65 under b, which fades in over 2.0-2.6 s.
    // The code strip reads whichever layer weighs more; frames within 0.05 of an even blend are skipped.
    const codes = render('crossfade-hold').sequentialCodes!;
    expect(codes).toHaveLength(120);
    codes.forEach((code, k) => {
      const t = k / 30;
      const bAlpha = t < 2 ? 0 : t < 2.2 ? ((t - 2) / 0.2) / 3 : t < 2.6 ? 1 / 3 + ((t - 2.2) / 0.4) * (2 / 3) : 1;
      if (Math.abs(bAlpha - 0.5) < 0.05) return;
      const expected = bAlpha > 0.5 ? k - 60 : Math.min(k, 65);
      expect(code, `crossfade-hold frame ${k}`).toBe(expected);
    });
    // VFR holds: frame 10 at its exact PTS; 50 us before frame 20's PTS shows frame 19 for the whole segment.
    expect(render('hold-vfr').sequentialCodes).toEqual([...Array(30).fill(10), ...Array(30).fill(19)]);
    // A source whose edit list starts mid-frame (track 0 = media 1.008 s): holds map track time through it.
    expect(render('hold-edit').sequentialCodes).toEqual([...Array(30).fill(46), ...Array(30).fill(45)]);
  });

  it('downmixes 5.1 to stereo per BS.775 through the default mix output', () => {
    const side = (channel: 'left' | 'right', hz: number): number => render('surround').audio![channel].all![String(hz)]!;
    expect(side('left', 200)).toBeCloseTo(0.25, 2); // L
    expect(side('left', 400)).toBeCloseTo(0.25 * Math.SQRT1_2, 2); // C at 0.7071
    expect(side('left', 500)).toBeCloseTo(0.25 * Math.SQRT1_2, 2); // Ls at 0.7071
    expect(side('right', 300)).toBeCloseTo(0.25, 2);
    expect(side('right', 400)).toBeCloseTo(0.25 * Math.SQRT1_2, 2);
    expect(side('right', 600)).toBeCloseTo(0.25 * Math.SQRT1_2, 2);
    for (const hz of [300, 600, 50]) expect(side('left', hz), `left ${hz}`).toBeLessThan(0.005);
    for (const hz of [200, 500, 50]) expect(side('right', hz), `right ${hz}`).toBeLessThan(0.005); // LFE dropped
  });

  it('rebuilds a parameter-only edit without a new composition, reusing media and decoded images', () => {
    expect(report.checks.rebuild).toEqual({
      parameterEditUpdates: true,
      sameComposition: true,
      newVideoComposition: true,
      structuralEditRefused: true,
      assetsReused: true,
      noDecodeAtBuild: true,
      imagesDecodedOnce: true,
    });
    const update = report.checks.update as Record<string, unknown>;
    expect(update).toMatchObject({
      withoutNewMediaRefused: true,
      withNewMediaUpdates: true,
      invalidatedReloads: true,
      invalidatedKeepsOthers: true,
      updateAfterSwapRefused: true,
    });
    // The new green sticker draws (green dominant in linear light).
    const sticker = update.newStickerLinear as number[];
    expect(sticker[1]).toBeGreaterThan(0.8);
    expect(Math.max(sticker[0]!, sticker[2]!)).toBeLessThan(0.4);
    // Fifty stills at fifty sizes under a 2 MB budget: nothing decoded at build, the cache stays capped.
    const budget = report.checks.stillBudget as { cachedBeforeDraw: number; bytes: number; budget: number; entries: number };
    expect(budget.cachedBeforeDraw).toBe(0);
    expect(budget.bytes).toBeLessThanOrEqual(budget.budget);
    expect(budget.entries).toBeLessThan(50);
    // Stills decode at the size drawn: the 100 x 160 logo asked for 25 px fits in 25 x 40, upright.
    expect(report.media['asset-logo']).toMatchObject({ downsampled: [25, 40] });
  });

  it('samples the latest source frame at s + 1e-6: speed, crossfade sources, holds, track stacking', () => {
    expect([0, 15, 59].map((k) => frame('speed-2x', k).code)).toEqual([30, 60, 148]);
    expect(frame('crossfade', 30).code).toBe(30);
    expect(frame('crossfade', 80).code).toBe(50); // b: srcStart 1.5 at 2.5 s, 1/6 s later
    // The hold shows source frame 65 (frameAt 2.166667) for the whole segment, under b at 1/3..
    expect(frame('crossfade-hold', 66).code).toBe(65);
    expect(frame('crossfade-hold', 67).code).toBe(65);
    expect(frame('crossfade-hold', 100).code).toBe(40);
    expect([15, 45, 75].map((k) => frame('overlapping-video-tracks', k).code)).toEqual([15, 135, 75]);
    expect(frame('dip', 30).code).toBe(30);
    expect(frame('audio-duck-loudness', 90).code).toBe(90);
  });

  it('crossfades and dips in linear light', () => {
    // Expectations come from the same render's solo frames of each clip.
    const solo = (name: string, k: number): Vec => probe(name, k, 'base').linear!;
    const alpha = (67 / 30 - 2) / 0.5;
    close(probe('crossfade', 67, 'base').linear, mix(solo('crossfade', 30), solo('crossfade', 80), alpha), 0.01);
    // A gamma-space blend would land far from it.
    const aEnc = probe('crossfade', 30, 'base').encoded!;
    const bEnc = probe('crossfade', 80, 'base').encoded!;
    expect(Math.abs(probe('crossfade', 67, 'base').encoded![0] - mix(aEnc, bEnc, alpha)[0])).toBeGreaterThan(0.05);
    const holdAlpha = 1 / 3 + ((70 / 30 - 2.2) / 0.4) * (2 / 3);
    close(probe('crossfade-hold', 70, 'base').linear, mix(solo('crossfade-hold', 30), solo('crossfade-hold', 100), holdAlpha), 0.01);
    close(probe('dip', 55, 'base').linear, scale(solo('dip', 30), 1 - (55 / 30 - 1.7) / 0.3), 0.01);
    close(probe('dip', 60, 'base').linear, grey(0), 0.002);
    // b rises from black: dim 1 at 2 s to 0 at 2.3 s, so it keeps (t - 2) / 0.3 of its light.
    close(probe('dip', 65, 'base').linear, scale(solo('dip', 100), (65 / 30 - 2) / 0.3), 0.01);
  });

  it('zooms with the crop-key convention', () => {
    // Source white patch centre (70, 130) at scale 1.14833, y -0.19778 lands at (53.7, 111.2).
    close(probe('zoom', 89, 'white').linear, grey(1), 0.03);
  });

  it('draws overlays: EXIF-upright stills, GIF delays clamped, z order', () => {
    expect(report.media['asset-logo']).toMatchObject({ orientation: 6, uprightWidth: 100, uprightHeight: 160 });
    expect(report.media['asset-gif']).toMatchObject({ unclampedDelays: [0, 0.05, 0.1, 0.01], total: 0.35 });
    close(probe('overlays', 0, 'logoWhite').linear, grey(1), 0.03);
    const top = probe('overlays', 0, 'logoTop').encoded!;
    expect(top[0]).toBeGreaterThan(0.9);
    expect(Math.max(top[1], top[2])).toBeLessThan(0.3);
    const bottom = probe('overlays', 0, 'logoBottom').encoded!;
    expect(bottom[2]).toBeGreaterThan(0.9);
    expect(bottom[0]).toBeLessThan(0.2);
    const colour = (k: number): string => {
      const [r, g, b] = probe('overlays', k, 'gif').encoded!;
      return `${r > 0.5 ? 'r' : ''}${g > 0.5 ? 'g' : ''}${b > 0.5 ? 'b' : ''}`;
    };
    // Delays 0, 5, 10, 1 cs play as 10, 5, 10, 10 cs from t = 0.5 s, looping every 0.35 s.
    expect([15, 17, 18, 20, 23, 26].map(colour)).toEqual(['r', 'r', 'g', 'b', 'rg', 'r']);
  });

  it('keeps one colour pipeline across SDR, HLG and PQ sources (HLG out)', () => {
    const f = frame('mixed-color-hlg', 15);
    expect(f.tags).toEqual({ primaries: 'ITU_R_2020', transfer: 'ITU_R_2100_HLG', matrix: 'ITU_R_2020' });
    for (const source of ['sdr', 'hlg', 'pq']) {
      const p = (id: string): Probe => probe('mixed-color-hlg', 15, `${source}-${id}`);
      close(p('white').linear, grey(1), 0.02);
      close(p('white').encoded, grey(0.75), 0.01); // BT.2408: reference white at 75% HLG
      close(p('grey').linear, grey(0.18), 0.01);
      close(p('colour').linear, [0.6, 0.25, 0.05], 0.02);
      // HDR sources keep their highlights; SDR cannot exceed its white.
      close(p('highlight').linear, grey(source === 'sdr' ? 1 : 2), source === 'sdr' ? 0.02 : 0.06);
    }
    const late = frame('mixed-color-hlg', 50);
    close(late.probes.captionBox!.linear, grey(1), 0.02);
    close(late.probes.captionBox!.encoded, grey(0.75), 0.01);
    close(late.probes.background!.linear, [srgbLinear(0x0b), srgbLinear(0x0b), srgbLinear(0x0f)], 0.0015);
  });

  it('tone maps HDR sources only, under a documented knee (SDR out)', () => {
    const f = frame('mixed-color-sdr', 15);
    expect(f.tags).toEqual({ primaries: 'ITU_R_709_2', transfer: 'ITU_R_709_2', matrix: 'ITU_R_709_2' });
    expect(report.checks.sdrCurve).toMatchObject({ '0.18': 0.18, '1': 0.9 });
    for (const source of ['sdr', 'hlg', 'pq']) {
      const p = (id: string): Probe => probe('mixed-color-sdr', 15, `${source}-${id}`);
      close(p('grey').linear, grey(0.18), 0.01);
      close(p('colour').linear, [0.6, 0.25, 0.05], 0.02);
      close(p('white').linear, grey(source === 'sdr' ? 1 : 0.9), 0.02);
      close(p('highlight').linear, grey(source === 'sdr' ? 1 : 0.9714), 0.02);
    }
    close(probe('mixed-color-sdr', 15, 'sdr-white').encoded, grey(1), 0.01);
    const late = frame('mixed-color-sdr', 50);
    close(late.probes.captionBox!.encoded, grey(1), 0.01);
    close(late.probes.background!.linear, [srgbLinear(0x0b), srgbLinear(0x0b), srgbLinear(0x0f)], 0.0015);
  });

  it('draws captions at reference white in an HLG master and keeps HDR video', () => {
    const f = frame('hlg-color', 30);
    expect(f.tags.transfer).toBe('ITU_R_2100_HLG');
    const caption = f.probes.caption!;
    const mean = (v: Vec): number => (v[0] + v[1] + v[2]) / 3;
    expect(mean(caption.brightestEncoded!)).toBeCloseTo(0.75, 1);
    expect(Math.abs(mean(caption.brightestLinear!) - 1)).toBeLessThan(0.06);
    close(f.probes.white!.encoded, grey(0.75), 0.01);
    close(f.probes.highlight!.linear, grey(2), 0.06);
    expect(f.probes.highlight!.encoded![0]).toBeGreaterThan(0.85);
  });

  it('lights karaoke words at their absolute start times', () => {
    const isYellow = (v: Vec | undefined): boolean => v !== undefined && v[0] > 0.9 && v[1] > 0.65 && v[2] < 0.3;
    const isWhite = (v: Vec | undefined): boolean => v !== undefined && Math.min(...v) > 0.95;
    const at = (k: number, word: string): Vec => frame('caption-karaoke', k).probes[word]!.brightestEncoded!;
    expect(Math.max(...frame('caption-karaoke', 10).probes.how!.brightestLinear!)).toBeLessThan(0.7); // before 0.5 s: no caption
    expect(isYellow(at(20, 'how'))).toBe(true);
    expect(isWhite(at(20, 'are'))).toBe(true);
    expect(isYellow(at(40, 'are'))).toBe(true);
    expect(isYellow(at(40, 'you'))).toBe(true);
    expect(isWhite(at(40, 'doing'))).toBe(true);
    expect(isYellow(at(75, 'doing'))).toBe(true);
    expect(isYellow(at(75, 'today'))).toBe(true);
    expect(report.checks.captionCache).toMatchObject({ 'sungAt0.49': 0, 'sungAt0.5': 1, 'sungAt2.0': 5, sungStates: [1, 2, 3, 4, 5] });
  });

  it('keeps the caption cache under its byte budget', () => {
    const cache = report.checks.captionCache as { bytes: number; budget: number; entries: number };
    expect(cache.bytes).toBeLessThanOrEqual(cache.budget);
    expect(cache.entries).toBeLessThan(5);
  });

  it('shows caption lanes together and each caption only in its span', () => {
    const present = (k: number, lane: string): boolean => Math.min(...frame('captions-multi-lane', k).probes[lane]!.brightestLinear!) > 0.95;
    expect([10, 30, 50, 80].map((k) => present(k, 'top'))).toEqual([false, true, true, false]);
    expect([10, 30, 50, 80].map((k) => present(k, 'bottom'))).toEqual([true, true, true, true]);
  });

  it('mixes audio with gain ramps, tri-fades and pitch-preserving speed', () => {
    expect(tone('audio-duck-loudness', 'duck', 220) / tone('audio-duck-loudness', 'pre', 220)).toBeCloseTo(0.3, 2);
    expect(tone('audio-duck-loudness', 'duck', 330) / tone('audio-duck-loudness', 'pre', 330)).toBeCloseTo(0.3, 2);
    expect(tone('audio-duck-loudness', 'pre', 330)).toBeCloseTo(0.125, 2); // bed at 0.5
    expect(tone('audio-duck-loudness', 'duck', 440)).toBeCloseTo(0.25, 2);
    expect(tone('audio-duck-loudness', 'pre', 440)).toBeLessThan(0.005);
    expect(tone('audio-duck-loudness', 'post', 220) / tone('audio-duck-loudness', 'pre', 220)).toBeCloseTo(1, 2);
    // Linear tri-fades sum to unity: both at half across the middle of the 0.5 s crossfade.
    expect(tone('crossfade', 'mid', 262)).toBeCloseTo(0.125, 2);
    expect(tone('crossfade', 'mid', 392)).toBeCloseTo(0.125, 2);
    expect(tone('crossfade', 'after', 262)).toBeLessThan(0.005);
    // 2x speed keeps a 220 Hz tone at 220 Hz (spectral time-pitch), not 440.
    expect(tone('speed-2x', 'all', 220)).toBeCloseTo(0.25, 1);
    expect(tone('speed-2x', 'all', 440)).toBeLessThan(0.01);
    expect(tone('overlapping-video-tracks', 'during', 523)).toBeCloseTo(0.25, 2);
    expect(tone('overlapping-video-tracks', 'before', 523)).toBeLessThan(0.005);
    const ramps = report.checks.ramps as Record<string, number | boolean>;
    expect(ramps).toMatchObject({ contiguous: true, start: 1, end: 2 });
    expect(ramps['gainAt1.1']).toBeCloseTo(0.45, 9); // half-sine at p 0.5 x key 0.9
    expect(ramps['gainAt1.85']).toBeCloseTo(0.25, 9); // linear fade-out at p 0.5 x key 0.5
    expect(ramps.maxPieceError as number).toBeLessThan(0.001);
  });

  it('drops plans that are not strictly newer (OV10)', () => {
    // Offered (revision, buildSeq): (3,1) (3,1) (2,9) (3,2) (4,0) (4,0).
    expect(report.checks.ordering).toEqual({ accepted: [true, false, false, true, true, false] });
  });

  it('refuses plans the executor must not draw', () => {
    expect(report.checks.decode).toEqual({
      fixture: 'ok',
      unknownKeysIgnored: 'ok',
      version2: 'unsupportedVersion',
      requiresFeature: 'unsupportedFeatures:caption-animation',
      tooManyRequires: 'overLimit',
      size4kSquare: 'overLimit',
      size4kPortrait: 'ok',
      oddSize: 'invalid',
      durationOverCap: 'overLimit',
      longCaptionLine: 'overLimit',
      longId: 'overLimit',
      segmentGap: 'invalid',
      badColour: 'invalid',
      unknownFace: 'invalid',
      overlaysFixture: 'ok',
      zeroCalloutCard: 'invalid',
      zeroCalloutGlyph: 'invalid',
    });
  });
});
