import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planFrameCount, type RenderPlan } from '@editify/shared';
import { buildFixture, FIXTURE_SCENARIOS } from '../../packages/shared/scripts/render-plan-fixtures.js';
import { compare, decodeFrame, decodeLinearHlg, downscale, probe, quantize, readPng, sdrToLinear, type Comparison, type Picture } from './helpers/plan-compare.js';
import { synthesizeMedia, type MediaSpec } from './helpers/plan-media.js';

/*
 * P6 cross-renderer parity: the server's plan render (src/media/plan) draws
 * every RenderPlan fixture over the same synthetic media the native golden
 * harness synthesizes (helpers/plan-media.ts mirrors render-golden/main.swift),
 * and is held to the native goldens in apps/mobile/modules/editify-engine/
 * parity/goldens (same plans, same frame numbers) and to the values the
 * native suite (render-golden.test.ts) asserts: decoded frame indices,
 * linear-light blends, the colour pipeline across SDR / HLG / PQ sources,
 * karaoke states, GIF timing, audio gains.
 *
 * Golden tolerance, on the ENCODED output (8-bit SDR, 16-bit HLG; 1080 x
 * 1920 plans at half size, as the goldens are):
 * - every golden frame: per-channel mean absolute difference <= 0.012 (about
 *   3/255). Measured 0.003 to 0.009: sources here are lossless where the
 *   harness's are 24 Mb/s H.264/HEVC, chroma is resampled by a different
 *   filter, and the native compositor samples with Core Image.
 * - frames with only pictures on screen: the 5 x 5 box-blurred worst-channel
 *   difference <= 0.15 (the native suite's local check is 0.1 against its own
 *   renders). Measured up to 0.13: sub-pixel placement (a static crop is
 *   whole-pixel; animated crops interpolate bilinearly where Core Image
 *   samples its own way) on the harness's 2 px grid lines and code strip
 *   edges.
 * - frames with text or graphics on screen: the blurred maximum is reported,
 *   not bounded. libass and Core Text antialias glyph edges differently (and
 *   libass applies ligatures; an accepted difference in the schema), so text
 *   is checked by position instead: karaoke words and caption lanes are found
 *   in the plan's rectangles, lit or not, as the native suite checks them.
 * An emoji sticker the host cannot draw (no Apple Color Emoji, no raster) is
 * left out with a QA note; its box is then excluded from the comparison.
 *
 * Needs ffmpeg with zscale, lut1d, libass and the other PLAN_RENDER_FILTERS.
 * Where they are missing the suite skips, except in CI (CI set), where the
 * `check` job installs ffmpeg and a missing filter fails.
 */
const root = resolve(fileURLToPath(import.meta.url), '../../..');
const goldens = join(root, 'apps/mobile/modules/editify-engine/parity/goldens');
const manifest = JSON.parse(readFileSync(join(goldens, 'manifest.json'), 'utf8')) as {
  media: Record<string, MediaSpec>;
  renders: Array<{ name: string; plan: string; downscale?: number; frames: Array<{ k: number; golden?: boolean; probes?: Array<{ name: string; x: number; y: number; r?: number }>; rects?: Array<{ name: string; x: number; y: number; w: number; h: number }> }> }>;
};

const NEEDED_FILTERS = ['zscale', 'lut1d', 'maskedmerge', 'blend', 'subtitles', 'geq', 'fillborders', 'alimiter', 'premultiply', 'unpremultiply',
  'negate', 'extractplanes', 'mergeplanes', 'rotate', 'tpad', 'aeval', 'afade', 'atempo', 'amix', 'adelay', 'pan'];
const filterList = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
const available = new Set((filterList.stdout ?? '').split('\n').map((line) => line.trim().split(/\s+/)[1]));
const missing = filterList.status === 0 ? NEEDED_FILTERS.filter((name) => !available.has(name)) : ['ffmpeg'];
const usable = missing.length === 0;
const inCi = Boolean(process.env.CI);

/**
 * Media only the server suites draw: a 10-bit HLG grey ramp, shallow enough
 * (about one 10-bit code every eight pixels) that an 8-bit stage anywhere
 * before linearization shows, as steps of four codes or as dither noise.
 */
const SERVER_MEDIA: Record<string, MediaSpec> = {
  'asset-hlg-ramp': { kind: 'video', transfer: 'hlg', w: 360, h: 640, fps: 30, seconds: 4, ramp: [0.2, 0.26] },
};

const MEAN_ABS_MAX = 0.012;
const PICTURE_BLURRED_MAX = 0.15;

const scratch = mkdtempSync(join(tmpdir(), 'editify-plan-parity-'));
process.env.EDITIFY_DATA_DIR = scratch;

interface Rendered {
  plan: RenderPlan;
  path: string;
  workDir: string;
  notes: string[];
  frames: Map<number, Picture>;
  /** HLG renders: the same frames decoded to linear by zscale. */
  linear: Map<number, Picture>;
  comparisons: Map<number, Comparison>;
}
const renders = new Map<string, Rendered>();
let mediaPaths = new Map<string, string>();
const planFor = (relative: string): RenderPlan => (JSON.parse(readFileSync(join(root, relative), 'utf8')) as { plan: RenderPlan }).plan;
/** Every render the parity suite draws: the 13 shared fixtures plus the harness's two colour plans. */
const RENDER_NAMES = [...manifest.renders.map((render) => render.name).filter((name) => (
  existsSync(join(root, 'packages/shared/fixtures/render-plans', `${name}.json`)) || name.startsWith('mixed-color')
))];

beforeAll(async () => {
  if (!usable) return;
  const { renderPlan } = await import('../src/media/plan/render.js');
  const plans = RENDER_NAMES.map((name) => ({ name, plan: planFor(manifest.renders.find((render) => render.name === name)!.plan) }));
  const ids = new Set<string>();
  for (const { plan } of plans) {
    for (const segment of plan.video.segments) for (const layer of segment.layers) ids.add(layer.assetRef.id);
    for (const overlay of plan.overlays) if (overlay.media) ids.add(overlay.media.assetRef.id);
    for (const entry of plan.audio) ids.add(entry.assetRef.id);
  }
  const media = await synthesizeMedia(manifest.media, scratch, ids);
  for (const [id, path] of await synthesizeMedia(SERVER_MEDIA, scratch)) media.set(id, path);
  mediaPaths = media;
  for (const { name, plan } of plans) {
    const path = join(scratch, `${name}.mp4`);
    const workDir = join(scratch, name);
    if (plan.duration === 0) {
      renders.set(name, { plan, path, workDir, notes: [], frames: new Map(), linear: new Map(), comparisons: new Map() });
      continue;
    }
    const result = await renderPlan(plan, (ref) => media.get(ref.id), { outputPath: path, workDir, keepWorkDir: true });
    const rendered: Rendered = { plan, path, workDir, notes: result.notes, frames: new Map(), linear: new Map(), comparisons: new Map() };
    const spec = manifest.renders.find((render) => render.name === name)!;
    for (const frame of spec.frames) {
      const picture = decodeFrame(path, frame.k, plan.size, plan.color === 'hlg');
      rendered.frames.set(frame.k, picture);
      if (plan.color === 'hlg') rendered.linear.set(frame.k, decodeLinearHlg(path, frame.k, plan.size));
      const golden = join(goldens, `${name}-${String(frame.k).padStart(3, '0')}.png`);
      if (frame.golden && existsSync(golden)) {
        const factor = spec.downscale ?? 1;
        const mine = quantize(downscale(picture, factor), plan.color === 'hlg');
        const theirs = readPng(golden);
        maskSkippedEmoji(rendered, frame.k, factor, mine, theirs);
        rendered.comparisons.set(frame.k, compare(mine, theirs));
      }
    }
    renders.set(name, rendered);
  }
}, 600000);

afterAll(() => {
  if (renders.size > 0) {
    const rows = [...renders.entries()].flatMap(([name, render]) => [...render.comparisons.entries()].map(([k, c]) =>
      `${`${name}#${k}`.padEnd(30)} mean ${c.meanAbs.map((value) => value.toFixed(4)).join('/')}  blurredMax ${c.blurredMax.toFixed(3)}  max ${c.maxAbs.toFixed(3)}${graphicsOnScreen(render.plan, k) ? '  (text/graphics)' : ''}`));
    console.log(`Plan render vs native goldens (encoded values, 0..1):\n${rows.join('\n')}`);
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** When the emoji sticker was left out, both pictures get its box blanked so the rest still compares. */
function maskSkippedEmoji(render: Rendered, k: number, factor: number, mine: Picture, theirs: Picture): void {
  for (const overlay of render.plan.overlays) {
    if (overlay.kind !== 'emoji' || !render.notes.some((note) => note.includes(overlay.id))) continue;
    if (!(overlay.start <= k / render.plan.fps && k / render.plan.fps < overlay.end)) continue;
    const half = Math.hypot(overlay.box.w, overlay.box.h) / 2;
    for (let y = Math.floor((overlay.box.y - half) / factor); y < Math.ceil((overlay.box.y + half) / factor); y += 1) {
      for (let x = Math.floor((overlay.box.x - half) / factor); x < Math.ceil((overlay.box.x + half) / factor); x += 1) {
        if (x < 0 || y < 0 || x >= mine.width || y >= mine.height) continue;
        for (let c = 0; c < 3; c += 1) mine.rgb[(y * mine.width + x) * 3 + c] = theirs.rgb[(y * theirs.width + x) * 3 + c]!;
      }
    }
  }
}

function graphicsOnScreen(plan: RenderPlan, k: number): boolean {
  const t = k / plan.fps;
  const on = (item: { start: number; end: number }): boolean => item.start <= t + 1e-6 && t < item.end - 1e-6;
  return plan.captions.some(on) || plan.overlays.some((item) => on(item) && item.kind !== 'broll' && item.kind !== 'image' && item.kind !== 'gif');
}

function render(name: string): Rendered {
  const found = renders.get(name);
  if (!found) throw new Error(`no render ${name}`);
  return found;
}
type Vec = [number, number, number];
function at(name: string, k: number, x: number, y: number, r = 2): { encoded: Vec; linear: Vec } {
  const rendered = render(name);
  const encoded = probe(rendered.frames.get(k)!, x, y, r);
  return { encoded, linear: rendered.plan.color === 'hlg' ? probe(rendered.linear.get(k)!, x, y, r) : sdrToLinear(encoded) };
}
function probeOf(name: string, k: number, id: string): { encoded: Vec; linear: Vec } {
  const spec = manifest.renders.find((item) => item.name === name)!.frames.find((frame) => frame.k === k)!.probes!.find((item) => item.name === id)!;
  return at(name, k, spec.x, spec.y, spec.r ?? 2);
}
function close(actual: readonly number[], expected: readonly number[], tolerance: number, label = ''): void {
  actual.forEach((value, index) => expect(Math.abs(value - expected[index]!), `${label} channel ${index}: ${value} vs ${expected[index]}`).toBeLessThanOrEqual(tolerance));
}
const grey = (value: number): Vec => [value, value, value];
const mix = (a: Vec, b: Vec, alpha: number): Vec => [0, 1, 2].map((c) => a[c]! * (1 - alpha) + b[c]! * alpha) as Vec;
const scale = (a: Vec, factor: number): Vec => a.map((value) => value * factor) as Vec;
const srgbLinear = (byte: number): number => {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** The harness's frame-index code strip: 8 blocks across the top 40 rows (at 360 wide), white = 1. */
function code(name: string, k: number): number {
  const picture = render(name).frames.get(k)!;
  const block = picture.width / 8;
  let value = 0;
  // Read in linear light, as the harness does: inside a blend the heavier layer wins.
  for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | (sdrToLinear(probe(picture, block * (bit + 0.5), 20 * (picture.width / 360), 1))[0] > 0.5 ? 1 : 0);
  return value;
}

/** Brightest pixel (by BT.2020 luma of the encoded values) in a rect of the full-size frame. */
function brightest(name: string, k: number, rect: string): Vec {
  const spec = manifest.renders.find((item) => item.name === name)!.frames.find((frame) => frame.k === k)!.rects!.find((item) => item.name === rect)!;
  const picture = render(name).frames.get(k)!;
  let best: Vec = [0, 0, 0];
  let luma = -1;
  for (let y = Math.floor(spec.y); y < spec.y + spec.h; y += 1) {
    for (let x = Math.floor(spec.x); x < spec.x + spec.w; x += 1) {
      const at3 = (y * picture.width + x) * 3;
      const pixel: Vec = [picture.rgb[at3]!, picture.rgb[at3 + 1]!, picture.rgb[at3 + 2]!];
      const l = 0.2627 * pixel[0] + 0.678 * pixel[1] + 0.0593 * pixel[2];
      if (l > luma) { luma = l; best = pixel; }
    }
  }
  return best;
}

/** Amplitude of a pure tone in a Hann-windowed stretch (Goertzel), as the native harness measures it. */
function tone(samples: Float32Array, from: number, to: number, hz: number): number {
  const start = Math.max(0, Math.floor(from * 48000));
  const end = Math.min(samples.length, Math.floor(to * 48000));
  const n = end - start;
  const w = (2 * Math.PI * hz) / 48000;
  let re = 0;
  let im = 0;
  let windowSum = 0;
  for (let offset = 0; offset < n; offset += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * offset) / (n - 1));
    windowSum += hann;
    re += samples[start + offset]! * hann * Math.cos(w * offset);
    im -= samples[start + offset]! * hann * Math.sin(w * offset);
  }
  return (2 * Math.hypot(re, im)) / windowSum;
}
/** The plan's audio master before loudness (the mix the native harness reads), mid of left and right. */
function master(name: string): Float32Array {
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', join(render(name).workDir, 'mix.wav'), '-af', 'pan=mono|c0=0.5*c0+0.5*c1', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30 }).stdout;
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

describe('plan render: ffmpeg capabilities', () => {
  it.runIf(inCi)('has every filter the plan render needs in CI', () => {
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!usable)('plan render vs the native goldens (RenderPlan v1 fixtures)', () => {
  it('renders exactly the fixtures the builder makes from their projects', () => {
    for (const scenario of FIXTURE_SCENARIOS) {
      expect(buildFixture(scenario).plan, scenario.name).toEqual(planFor(`packages/shared/fixtures/render-plans/${scenario.name}.json`));
    }
  });

  it('refuses an empty plan', async () => {
    const { renderPlan } = await import('../src/media/plan/render.js');
    await expect(renderPlan(render('empty-project').plan, () => undefined, { outputPath: join(scratch, 'empty.mp4'), workDir: join(scratch, 'empty') }))
      .rejects.toThrow(/nothing to render/);
  });

  it.each(RENDER_NAMES.filter((name) => name !== 'empty-project'))('%s: frame count, codec and colour tags, stereo 48 kHz audio of the plan length', (name) => {
    const { plan, path } = render(name);
    const streams = (JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
      'stream=codec_type,codec_name,profile,pix_fmt,color_transfer,color_primaries,color_space,color_range,nb_read_frames,sample_rate,channels,r_frame_rate',
      '-of', 'json', path], { encoding: 'utf8' }).stdout) as { streams: Array<Record<string, string | number>> }).streams;
    const video = streams.find((stream) => stream.codec_type === 'video')!;
    const audio = streams.find((stream) => stream.codec_type === 'audio')!;
    expect(Number(video.nb_read_frames)).toBe(planFrameCount(plan));
    expect(video.r_frame_rate).toBe(`${plan.fps}/1`);
    if (plan.color === 'hlg') {
      expect(video).toMatchObject({ codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', color_transfer: 'arib-std-b67', color_primaries: 'bt2020', color_space: 'bt2020nc', color_range: 'tv' });
    } else {
      expect(video).toMatchObject({ codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709', color_range: 'tv' });
    }
    expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
    const samples = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 30 }).stdout.length / 4;
    // AAC frames are 1024 samples; ffmpeg 5.1's mp4 muxer (Debian 12, production) also leaves the encoder
    // priming in the decoded length, so allow two frames. The PCM master below is exact.
    expect(Math.abs(samples - Math.round(plan.duration * 48000))).toBeLessThanOrEqual(2048);
    // The pre-loudness master is exact to the sample.
    expect(master(name).length).toBe(Math.round(plan.duration * 48000));
  });

  it('matches every native golden frame within tolerance (mean everywhere, local only where no text is on screen)', () => {
    let compared = 0;
    for (const [name, rendered] of renders) {
      for (const [k, comparison] of rendered.comparisons) {
        compared += 1;
        const label = `${name}#${k}`;
        for (const value of comparison.meanAbs) expect(value, `${label} mean abs`).toBeLessThanOrEqual(MEAN_ABS_MAX);
        if (!graphicsOnScreen(rendered.plan, k)) expect(comparison.blurredMax, `${label} blurred max`).toBeLessThanOrEqual(PICTURE_BLURRED_MAX);
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('samples the latest source frame at s + 1e-6: speed, crossfade sources, holds, track stacking', () => {
    expect([0, 15, 59].map((k) => code('speed-2x', k))).toEqual([30, 60, 148]);
    expect(code('crossfade', 30)).toBe(30);
    expect(code('crossfade', 80)).toBe(50);
    expect(code('crossfade-hold', 66)).toBe(65);
    expect(code('crossfade-hold', 67)).toBe(65);
    expect(code('crossfade-hold', 100)).toBe(40);
    expect([15, 45, 75].map((k) => code('overlapping-video-tracks', k))).toEqual([15, 135, 75]);
    expect(code('dip', 30)).toBe(30);
    expect(code('audio-duck-loudness', 90)).toBe(90);
  });

  it('crossfades and dips in linear light (an intended divergence from legacy)', () => {
    const solo = (name: string, k: number): Vec => probeOf(name, k, 'base').linear;
    const alpha = (67 / 30 - 2) / 0.5;
    close(probeOf('crossfade', 67, 'base').linear, mix(solo('crossfade', 30), solo('crossfade', 80), alpha), 0.01, 'crossfade 67');
    // A gamma-space blend (legacy's fade) lands far from it.
    const aEnc = probeOf('crossfade', 30, 'base').encoded;
    const bEnc = probeOf('crossfade', 80, 'base').encoded;
    expect(Math.abs(probeOf('crossfade', 67, 'base').encoded[0] - mix(aEnc, bEnc, alpha)[0])).toBeGreaterThan(0.05);
    const holdAlpha = 1 / 3 + ((70 / 30 - 2.2) / 0.4) * (2 / 3);
    close(probeOf('crossfade-hold', 70, 'base').linear, mix(solo('crossfade-hold', 30), solo('crossfade-hold', 100), holdAlpha), 0.01, 'hold 70');
    close(probeOf('dip', 55, 'base').linear, scale(solo('dip', 30), 1 - (55 / 30 - 1.7) / 0.3), 0.01, 'dip 55');
    close(probeOf('dip', 60, 'base').linear, grey(0), 0.002, 'dip 60');
    close(probeOf('dip', 65, 'base').linear, scale(solo('dip', 100), (65 / 30 - 2) / 0.3), 0.01, 'dip 65');
  });

  it('zooms with the crop-key convention', () => {
    close(probeOf('zoom', 89, 'white').linear, grey(1), 0.03);
  });

  it('keeps an HLG zoom at 16 bits: a smooth ramp has every code and no 8-bit steps or dither', async () => {
    const { renderPlan } = await import('../src/media/plan/render.js');
    const zoom = render('zoom').plan;
    const plan: RenderPlan = {
      ...zoom,
      color: 'hlg',
      video: { segments: zoom.video.segments.map((segment) => ({ ...segment, layers: segment.layers.map((layer) => ({ ...layer, assetRef: { id: 'asset-hlg-ramp', kind: 'video' as const } })) })) },
    };
    expect(plan.video.segments[0]!.layers[0]!.cropKeys.length).toBeGreaterThan(1);
    const path = join(scratch, 'zoom-hlg.mp4');
    await renderPlan(plan, (ref) => mediaPaths.get(ref.id), { outputPath: path, workDir: join(scratch, 'zoom-hlg') });
    for (const k of [0, 45, 89]) {
      // Y' codes of the 10-bit output, rows 200..439 (the ramp is grey, so luma carries it).
      const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `select='eq(n\\,${k})'`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', 'pipe:1'], { maxBuffer: 1 << 28 }).stdout;
      const code = (x: number, y: number): number => raw.readUInt16LE((y * plan.size.w + x) * 2);
      const codes = new Set<number>();
      let neighbours = 0;
      let pairs = 0;
      const columns: number[] = [];
      for (let x = 0; x < plan.size.w; x += 1) {
        let sum = 0;
        for (let y = 200; y < 440; y += 1) {
          codes.add(code(x, y));
          sum += code(x, y);
          if (x > 0) {
            neighbours += Math.abs(code(x, y) - code(x - 1, y));
            pairs += 1;
          }
        }
        columns.push(sum / 240);
      }
      const low = Math.min(...codes);
      const high = Math.max(...codes);
      const slope = (columns.at(-1)! - columns[0]!) / (plan.size.w - 1);
      const steepest = Math.max(...columns.slice(1).map((value, index) => Math.abs(value - columns[index]!)));
      // Measured (ffmpeg 9.0): 42-46 codes over 42-46 values, neighbours 0.11-0.13 apart (the ramp's own slope,
      // 0.12), column steps of 1 code. Through the 8-bit perspective path it was neighbours 0.59-1.91 apart
      // (dither) and column steps of up to 3.97 (an 8-bit step is 4 codes).
      expect(high - low, `frame ${k} ramp range`).toBeGreaterThan(30);
      expect(codes.size, `frame ${k} codes present`).toBeGreaterThanOrEqual(0.9 * (high - low + 1));
      expect(neighbours / pairs, `frame ${k} mean neighbour step`).toBeLessThanOrEqual(Math.abs(slope) + 0.1);
      expect(steepest, `frame ${k} steepest column step`).toBeLessThanOrEqual(1.5);
    }
  });

  it('zooms past one crop window in chunks, every frame where the static chain puts that pose', async () => {
    const { renderPlan } = await import('../src/media/plan/render.js');
    const zoom = render('zoom').plan;
    const segment = zoom.video.segments[0]!;
    const withKeys = (cropKeys: RenderPlan['video']['segments'][number]['layers'][number]['cropKeys']): RenderPlan => ({
      ...zoom,
      video: { segments: [{ ...segment, layers: segment.layers.map((layer) => ({ ...layer, cropKeys })) }] },
    });
    // 1x to 3x across the segment: three crop windows (ratio 1.5 each), with a pan.
    const end = segment.end;
    const animated = withKeys([{ t: 0, scale: 1, x: 0, y: 0 }, { t: end, scale: 3, x: 0.6, y: -0.5 }]);
    const path = join(scratch, 'zoom-3x.mp4');
    await renderPlan(animated, (ref) => mediaPaths.get(ref.id), { outputPath: path, workDir: join(scratch, 'zoom-3x') });
    // Frames on both sides of each chunk boundary (scale 1.5 at frame 22.5, 2.25 at 56.25) and the last, each
    // against the static chain (one key) at that frame's pose: the convention cross-checked frame by frame.
    for (const k of [10, 22, 23, 56, 57, 89]) {
      const p = (k / zoom.fps) / end;
      const still = withKeys([{ t: 0, scale: 1 + 2 * p, x: 0.6 * p, y: -0.5 * p }]);
      const stillPath = join(scratch, `zoom-3x-${k}.mp4`);
      await renderPlan(still, (ref) => mediaPaths.get(ref.id), { outputPath: stillPath, workDir: join(scratch, `zoom-3x-${k}`) });
      const comparison = compare(decodeFrame(path, k, zoom.size, false), decodeFrame(stillPath, k, zoom.size, false));
      // The still is the static chain, whole-pixel placed; the zoom is sub-pixel, so they differ by up to half a
      // pixel. Measured (9.0): mean 0.001-0.007, blurred max 0.08-0.165. A wrong window or chunk is far off (0.1+).
      for (const value of comparison.meanAbs) expect(value, `frame ${k} mean abs`).toBeLessThanOrEqual(0.009);
      expect(comparison.blurredMax, `frame ${k} blurred max`).toBeLessThanOrEqual(0.2);
    }
  }, 120000);

  it('draws overlays: EXIF-upright stills, GIF delays clamped, z order', () => {
    close(probeOf('overlays', 0, 'logoWhite').linear, grey(1), 0.03);
    const top = probeOf('overlays', 0, 'logoTop').encoded;
    expect(top[0]).toBeGreaterThan(0.9);
    expect(Math.max(top[1], top[2])).toBeLessThan(0.3);
    const bottom = probeOf('overlays', 0, 'logoBottom').encoded;
    expect(bottom[2]).toBeGreaterThan(0.9);
    expect(bottom[0]).toBeLessThan(0.2);
    const colour = (k: number): string => {
      const [r, g, b] = probeOf('overlays', k, 'gif').encoded;
      return `${r > 0.5 ? 'r' : ''}${g > 0.5 ? 'g' : ''}${b > 0.5 ? 'b' : ''}`;
    };
    // Delays 0, 5, 10, 1 cs play as 10, 5, 10, 10 cs from t = 0.5 s, looping every 0.35 s.
    expect([15, 17, 18, 20, 23, 26].map(colour)).toEqual(['r', 'r', 'g', 'b', 'rg', 'r']);
  });

  it('draws an emoji sticker the host cannot colour in monochrome, with a note, never dropping it', async () => {
    const notes = render('overlays').notes;
    if (process.platform === 'darwin') expect(notes).toEqual([]);
    else expect(notes.some((note) => note.includes('emoji-fire') && note.includes('monochrome'))).toBe(true);
    // The fallback path on every host: no rasterizer, no raster.
    const { renderPlan } = await import('../src/media/plan/render.js');
    const plan = render('overlays').plan;
    const path = join(scratch, 'overlays-mono.mp4');
    const result = await renderPlan(plan, (ref) => mediaPaths.get(ref.id),
      { outputPath: path, workDir: join(scratch, 'overlays-mono'), rasterizeEmoji: async () => null });
    expect(result.notes).toEqual([expect.stringContaining('Emoji sticker emoji-fire was drawn in monochrome')]);
    // Frame 40 (1.33 s, before the b-roll covers it): white glyph pixels inside the emoji's box, none there without it.
    const whiteIn = (file: string): number => {
      const picture = decodeFrame(file, 40, plan.size, false);
      let count = 0;
      for (let y = 250; y < 350; y += 1) {
        for (let x = 140; x < 220; x += 1) {
          const at3 = (y * picture.width + x) * 3;
          if (Math.min(picture.rgb[at3]!, picture.rgb[at3 + 1]!, picture.rgb[at3 + 2]!) > 0.9) count += 1;
        }
      }
      return count;
    };
    const withoutEmoji = join(scratch, 'overlays-no-emoji.mp4');
    await renderPlan({ ...plan, overlays: plan.overlays.filter((item) => item.kind !== 'emoji') }, (ref) => mediaPaths.get(ref.id),
      { outputPath: withoutEmoji, workDir: join(scratch, 'overlays-no-emoji') });
    expect(whiteIn(path)).toBeGreaterThan(whiteIn(withoutEmoji) + 50);
  });

  it('keeps one colour pipeline across SDR, HLG and PQ sources (HLG out: reference white at 75% HLG)', () => {
    for (const source of ['sdr', 'hlg', 'pq']) {
      const p = (id: string): { encoded: Vec; linear: Vec } => probeOf('mixed-color-hlg', 15, `${source}-${id}`);
      close(p('white').linear, grey(1), 0.02, `${source} white`);
      close(p('white').encoded, grey(0.75), 0.01, `${source} white encoded`);
      close(p('grey').linear, grey(0.18), 0.01, `${source} grey`);
      close(p('colour').linear, [0.6, 0.25, 0.05], 0.02, `${source} colour`);
      // HDR sources keep their highlights; SDR cannot exceed its white.
      close(p('highlight').linear, grey(source === 'sdr' ? 1 : 2), source === 'sdr' ? 0.02 : 0.06, `${source} highlight`);
    }
    close(probeOf('mixed-color-hlg', 50, 'captionBox').linear, grey(1), 0.02, 'caption box');
    close(probeOf('mixed-color-hlg', 50, 'captionBox').encoded, grey(0.75), 0.01, 'caption box encoded');
    close(probeOf('mixed-color-hlg', 50, 'background').linear, [srgbLinear(0x0b), srgbLinear(0x0b), srgbLinear(0x0f)], 0.0015, 'background');
  });

  it('tone maps HDR sources only, with the schema curve (SDR out: reference white to 0.9)', () => {
    for (const source of ['sdr', 'hlg', 'pq']) {
      const p = (id: string): { encoded: Vec; linear: Vec } => probeOf('mixed-color-sdr', 15, `${source}-${id}`);
      close(p('grey').linear, grey(0.18), 0.01, `${source} grey`);
      close(p('colour').linear, [0.6, 0.25, 0.05], 0.02, `${source} colour`);
      close(p('white').linear, grey(source === 'sdr' ? 1 : 0.9), 0.02, `${source} white`);
      // 2.0 maps to 0.8 + 0.2 * 1.2 / 1.4 = 0.9714.
      close(p('highlight').linear, grey(source === 'sdr' ? 1 : 0.9714), 0.02, `${source} highlight`);
    }
    close(probeOf('mixed-color-sdr', 15, 'sdr-white').encoded, grey(1), 0.01);
    close(probeOf('mixed-color-sdr', 50, 'captionBox').encoded, grey(1), 0.01);
    // #0B0B0F through linear light and the 1.961 SDR curve: 14/255, as the phone encodes it.
    close(probeOf('mixed-color-sdr', 50, 'background').linear, [srgbLinear(0x0b), srgbLinear(0x0b), srgbLinear(0x0f)], 0.0015);
  });

  it('draws captions at reference white in an HLG master and keeps HDR video', () => {
    const caption = brightest('hlg-color', 30, 'caption');
    expect((caption[0] + caption[1] + caption[2]) / 3).toBeCloseTo(0.75, 1);
    close(probeOf('hlg-color', 30, 'white').encoded, grey(0.75), 0.01);
    close(probeOf('hlg-color', 30, 'highlight').linear, grey(2), 0.06);
  });

  it('lights karaoke words at their absolute start times, where the plan puts them', () => {
    const yellow = (v: Vec): boolean => v[0] > 0.9 && v[1] > 0.65 && v[2] < 0.3;
    const white = (v: Vec): boolean => Math.min(...v) > 0.95;
    expect(Math.max(...sdrToLinear(brightest('caption-karaoke', 10, 'how')))).toBeLessThan(0.7); // before 0.5 s: no caption
    expect(yellow(brightest('caption-karaoke', 20, 'how'))).toBe(true);
    expect(white(brightest('caption-karaoke', 20, 'are'))).toBe(true);
    expect(yellow(brightest('caption-karaoke', 40, 'are'))).toBe(true);
    expect(yellow(brightest('caption-karaoke', 40, 'you'))).toBe(true);
    expect(white(brightest('caption-karaoke', 40, 'doing'))).toBe(true);
    expect(yellow(brightest('caption-karaoke', 75, 'doing'))).toBe(true);
    expect(yellow(brightest('caption-karaoke', 75, 'today'))).toBe(true);
  });

  it('shows caption lanes together and each caption only in its span', () => {
    const present = (k: number, lane: string): boolean => Math.min(...brightest('captions-multi-lane', k, lane)) > 0.95;
    expect([10, 30, 50, 80].map((k) => present(k, 'top'))).toEqual([false, true, true, false]);
    expect([10, 30, 50, 80].map((k) => present(k, 'bottom'))).toEqual([true, true, true, true]);
  });

  it('mixes audio with gain ramps, tri-fades and pitch-preserving speed (the pre-loudness master)', () => {
    const duck = master('audio-duck-loudness');
    const level = (name: Float32Array, from: number, to: number, hz: number): number => tone(name, from, to, hz);
    expect(level(duck, 2.3, 3.7, 220) / level(duck, 0.4, 1.6, 220)).toBeCloseTo(0.3, 2);
    expect(level(duck, 2.3, 3.7, 330) / level(duck, 0.4, 1.6, 330)).toBeCloseTo(0.3, 2);
    expect(level(duck, 0.4, 1.6, 330)).toBeCloseTo(0.125, 2); // bed at 0.5
    expect(level(duck, 2.3, 3.7, 440)).toBeCloseTo(0.25, 2);
    expect(level(duck, 0.4, 1.6, 440)).toBeLessThan(0.005);
    expect(level(duck, 4.4, 5.6, 220) / level(duck, 0.4, 1.6, 220)).toBeCloseTo(1, 2);
    const crossfade = master('crossfade');
    expect(level(crossfade, 2.2, 2.3, 262)).toBeCloseTo(0.125, 2);
    expect(level(crossfade, 2.2, 2.3, 392)).toBeCloseTo(0.125, 2);
    expect(level(crossfade, 3.0, 3.8, 262)).toBeLessThan(0.005);
    const fast = master('speed-2x');
    expect(level(fast, 0.2, 1.8, 220)).toBeCloseTo(0.25, 1);
    expect(level(fast, 0.2, 1.8, 440)).toBeLessThan(0.01);
    const tracks = master('overlapping-video-tracks');
    expect(level(tracks, 1.2, 1.8, 523)).toBeCloseTo(0.25, 2);
    expect(level(tracks, 0.2, 0.8, 523)).toBeLessThan(0.005);
  });
});
