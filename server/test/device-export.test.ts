import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFrameCount, renderPlanSchema } from '@editify/shared';
import { buildRotatedPlan, PORTRAIT_CLIP, ROTATED_PLAN_FILE } from './helpers/rotated-plan.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Plan P4 (8A + OV8): the phone's on-device export. The macOS harness
 * (apps/mobile/modules/editify-engine/parity/export) runs PlanExporter, the
 * same Swift the app runs, on synthesized media and inspects every file it
 * writes with AVFoundation: frame count and duration against the plan, codec,
 * profile, bit depth and colour tags (H.264 High 8-bit BT.709 for SDR, HEVC
 * Main10 HLG BT.2020 for HLG), AAC stereo 48 kHz lasting what the video does,
 * moov before mdat, golden frames decoded back from the file, A/V sync on a
 * synthesized clap, and the loudness rules on the finished file.
 *
 * Loudness meter parity: the harness writes reference signals (pink noise at
 * -23 LUFS, a speech-like voiced signal, room tone at -65 LUFS, a 12 kHz sine
 * with inter-sample peaks) and meters them with LoudnessMeter; here ffmpeg's
 * ebur128 meters the same files. Integrated loudness must agree within 0.3 LU
 * and true peak within 0.3 dB. For the 12 kHz sine the true peak is checked
 * against its exact value (-6.02 dBTP) instead: ffmpeg's interpolator
 * overshoots that signal by about 0.6 dB.
 *
 * Needs swiftc (macOS); elsewhere it skips, except where REQUIRE_SWIFT=1 (the
 * macOS CI `engine` job), where a missing toolchain or ffmpeg fails.
 *
 * Tolerance on golden frames: the exported frames went through H.264 / HEVC at
 * the export bitrate (360x640 plans get the 1.5 Mbit/s floor), so they allow
 * more than render-golden's uncompressed frames: per-channel mean absolute
 * difference <= 0.015, blurred max <= 0.15.
 */
const root = resolve(fileURLToPath(import.meta.url), '../../..');
const engine = join(root, 'apps/mobile/modules/editify-engine');
const exportPlans = join(engine, 'parity/export/plans');
const swiftAvailable = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;
const ffmpegAvailable = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
const required = process.env.REQUIRE_SWIFT === '1';
const MEAN_ABS_MAX = 0.015;
const BLURRED_MAX = 0.15;
const AAC_FRAME = 1024 / 48000;

type Nullable = number | null;
interface FileReport {
  duration: number;
  boxes: string[];
  videoDuration: number;
  videoStart: number;
  codec: string;
  size: [number, number];
  primaries: string;
  transfer: string;
  matrix: string;
  profileIdc: number;
  bitDepth: number;
  frames: number;
  lastPTS: number;
  keyframes: number;
  audioDuration: number;
  audioStart: number;
  audioFormat: string;
  audioChannels: number;
  audioRate: number;
  audioBitrate: number;
  decodedAudioFrames: number;
  lufs: Nullable;
  truePeak: Nullable;
  goldenFrames?: Array<{ k: number; golden: string; compare: { meanAbs?: number[]; blurredMax?: number; missingGolden?: boolean; sizeMismatch?: boolean } }>;
  clap?: { expected: number; video: Nullable; audio: Nullable };
  probes?: Record<string, [number, number, number]>;
}
interface Stats {
  seconds: number;
  xRealtime: number;
  peakMemMB: number;
  lufsIn: Nullable;
  lufsOut: Nullable;
  /** Measured before AAC encoding. */
  truePeakPreEncode: Nullable;
  gainDb: number;
  limiterOn: boolean;
  limiterMaxReductionDb: number;
  limiterLatencyFrames: number;
  frames: number;
  audioFrames: number;
  videoBitrate: number;
  codec: string;
}
interface ExportReport {
  name: string;
  planFrames: number;
  planDuration: number;
  color: 'sdr' | 'hlg';
  /** The plan normalizes (so it has a measuring pass and a limiter). */
  measured?: boolean;
  targetLufs?: number | null;
  error?: string;
  stats?: Stats;
  progress?: { phases: string[]; backwards: number; final: Record<string, number> };
  file?: FileReport;
}
interface Report {
  meter: Record<string, { file: string; integrated: Nullable; truePeak: Nullable; samplePeak: Nullable }>;
  rules: Record<string, number | boolean>;
  exports: ExportReport[];
  failures: {
    cancel: { outcome: string; fileRemoved: boolean };
    noSpace: { outcome: string; needed: number; fileAbsent: boolean; message: string };
    empty: string;
    thermal: { outcome: string; fileRemoved: boolean };
  };
  defaults: { bitrate1080pSdr: number };
  throttle: { sent: number; seconds: number };
}

let dir: string | undefined;
let report: Report;
const run = promisify(execFile);

beforeAll(async () => {
  if (!swiftAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'editify-device-export-'));
  const binary = join(dir, 'export-harness');
  const sources = ['RenderPlan', 'PlanBuilder', 'EditifyCompositor', 'CaptionRenderer', 'OverlayGraphics', 'AnalysisMath', 'Loudness', 'PlanExporter']
    .map((name) => join(engine, 'ios', `${name}.swift`));
  const harness = [join(engine, 'parity/render-golden/HarnessMedia.swift'), join(engine, 'parity/export/main.swift')];
  // Async: the build and the exports take a while on a CI runner (see render-golden.test.ts).
  await run('xcrun', ['swiftc', '-O', '-swift-version', '5', ...sources, ...harness, '-o', binary], { maxBuffer: 64 << 20 });
  const args = [join(engine, 'parity/goldens/manifest.json'), join(engine, 'parity/export/manifest.json'), root, join(dir, 'work'), join(dir, 'out')];
  report = JSON.parse((await run(binary, args, { encoding: 'utf8', maxBuffer: 64 << 20 })).stdout) as Report;
}, 600000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function exported(name: string): ExportReport & { stats: Stats; file: FileReport } {
  const found = report.exports.find((item) => item.name === name);
  if (!found) throw new Error(`no export ${name}`);
  expect(found.error, `${name} failed`).toBeUndefined();
  return found as ExportReport & { stats: Stats; file: FileReport };
}

interface Ebur128 { integrated: number | null; truePeak: number | null }
async function ffmpegLoudness(path: string): Promise<Ebur128> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { maxBuffer: 16 << 20 });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const value = (pattern: RegExp): number | null => {
    const match = summary.match(pattern);
    return match && match[1] !== '-inf' ? Number(match[1]) : null;
  };
  return { integrated: value(/\bI:\s*(-?[0-9.]+|-inf)\s*LUFS/), truePeak: value(/\bPeak:\s*(-?[0-9.]+|-inf)\s*dBFS/) };
}

const LOUDNESS = { targetLufs: -16, deadbandLu: 0.5, silentBelowLufs: -60, truePeakLimitDb: -1 };

describe('device export: harness availability', () => {
  it.runIf(required)('has swiftc and ffmpeg where REQUIRE_SWIFT=1', () => {
    expect(swiftAvailable).toBe(true);
    expect(ffmpegAvailable).toBe(true);
  });

  it('export-only plans are valid RenderPlans', () => {
    for (const file of readdirSync(exportPlans)) {
      const { plan } = JSON.parse(readFileSync(join(exportPlans, file), 'utf8')) as { plan: unknown };
      expect(() => renderPlanSchema.parse(plan), file).not.toThrow();
    }
  });
});

describe.skipIf(!swiftAvailable)('device export (PlanExporter on macOS)', () => {
  it('writes every plan: exact frames and duration, A/V lengths matched, moov first, no fragments', () => {
    expect(report.exports.length).toBeGreaterThanOrEqual(15);
    for (const item of report.exports) {
      const { file, stats } = exported(item.name);
      const plan = { duration: item.planDuration, fps: 30 };
      expect(item.planFrames, item.name).toBe(planFrameCount(plan));
      expect(file.frames, `${item.name} frames`).toBe(item.planFrames);
      expect(stats.frames, item.name).toBe(item.planFrames);
      expect(file.videoStart, item.name).toBeCloseTo(0, 6);
      expect(file.videoDuration, item.name).toBeCloseTo(item.planDuration, 3);
      expect(file.duration, item.name).toBeCloseTo(item.planDuration, 3);
      expect(Math.abs(file.audioDuration - file.videoDuration), `${item.name} audio vs video`).toBeLessThanOrEqual(AAC_FRAME);
      expect(Math.abs(file.decodedAudioFrames - item.planDuration * 48000), `${item.name} decoded audio`).toBeLessThanOrEqual(1024);
      expect(stats.audioFrames, item.name).toBe(Math.round(item.planDuration * 48000));
      // Faststart: moov before mdat; fragment-free.
      expect(file.boxes.indexOf('moov'), item.name).toBeGreaterThanOrEqual(0);
      expect(file.boxes.indexOf('moov'), item.name).toBeLessThan(file.boxes.indexOf('mdat'));
      expect(file.boxes, item.name).not.toContain('moof');
      // Progress: resolving, measuring (only when the plan normalizes), writing; never backwards; ends at 1.
      expect(item.progress?.phases, item.name).toEqual(item.measured ? ['resolving', 'measuring', 'writing'] : ['resolving', 'writing']);
      expect(item.progress?.backwards, item.name).toBe(0);
      expect(item.progress?.final.writing, item.name).toBeCloseTo(1, 6);
    }
  });

  it('encodes SDR as H.264 High 8-bit BT.709 and HLG as HEVC Main10 BT.2020 HLG', () => {
    for (const item of report.exports) {
      const { file, stats } = exported(item.name);
      if (item.color === 'hlg') {
        expect(file.codec, item.name).toBe('hvc1');
        expect(file.profileIdc, item.name).toBe(2); // Main 10
        expect(file.bitDepth, item.name).toBe(10);
        expect([file.primaries, file.transfer, file.matrix], item.name).toEqual(['ITU_R_2020', 'ITU_R_2100_HLG', 'ITU_R_2020']);
        expect(stats.codec).toBe('hevc-main10');
      } else {
        expect(file.codec, item.name).toBe('avc1');
        expect(file.profileIdc, item.name).toBe(100); // High
        expect(file.bitDepth, item.name).toBe(8);
        expect([file.primaries, file.transfer, file.matrix], item.name).toEqual(['ITU_R_709_2', 'ITU_R_709_2', 'ITU_R_709_2']);
        expect(stats.codec).toBe('h264-high');
      }
      expect(file.keyframes, item.name).toBeGreaterThanOrEqual(1);
    }
    expect(exported('hlg-color').color).toBe('hlg');
    // 0.2 bit per pixel at 1080x1920 x 30 fps.
    expect(report.defaults.bitrate1080pSdr).toBe(12_441_600);
    expect(exported('caption-karaoke').file.size).toEqual([1080, 1920]);
  });

  it('writes AAC stereo at 48 kHz, at most 192 kbit/s', () => {
    for (const item of report.exports) {
      const { file } = exported(item.name);
      expect(file.audioFormat, item.name).toBe('aac ');
      expect(file.audioChannels, item.name).toBe(2);
      expect(file.audioRate, item.name).toBe(48000);
      // AAC at 192 kbit/s is a ceiling: pure test tones take far less, silence almost nothing.
      expect(file.audioBitrate, item.name).toBeGreaterThanOrEqual(0);
      expect(file.audioBitrate, item.name).toBeLessThanOrEqual(200_000);
    }
  });

  it('decodes back to the golden frames', () => {
    const checked = report.exports.flatMap((item) => (item.file?.goldenFrames ?? []).map((frame) => ({ name: item.name, frame })));
    expect(checked.length).toBeGreaterThanOrEqual(7);
    for (const { name, frame } of checked) {
      const label = `${name}#${frame.k} (${frame.golden})`;
      expect(frame.compare.missingGolden, label).toBeUndefined();
      expect(frame.compare.sizeMismatch, label).toBeUndefined();
      for (const value of frame.compare.meanAbs!) expect(value, `${label} mean abs`).toBeLessThanOrEqual(MEAN_ABS_MAX);
      expect(frame.compare.blurredMax!, `${label} blurred max`).toBeLessThanOrEqual(BLURRED_MAX);
    }
  });

  it('keeps A/V in sync through the limiter: the clap lands within one frame', () => {
    const { file, stats } = exported('clap-sync');
    // The click is limited hard (it is far over the ceiling after +10 dB of gain), so latency compensation is exercised.
    expect(stats.limiterMaxReductionDb).toBeGreaterThan(3);
    expect(stats.limiterLatencyFrames).toBeGreaterThan(0);
    const clap = file.clap!;
    expect(clap.video).not.toBeNull();
    expect(clap.audio).not.toBeNull();
    expect(Math.abs(clap.video! - clap.expected)).toBeLessThanOrEqual(1 / 30 + 1e-6);
    expect(Math.abs(clap.audio! - clap.expected)).toBeLessThanOrEqual(1 / 30);
    expect(Math.abs(clap.audio! - clap.video!)).toBeLessThanOrEqual(1 / 30);
  });

  it('applies the plan loudness rules (gain, deadband, silence, limiter)', () => {
    expect(report.rules).toEqual({
      inDeadband: 0, edgeOfDeadband: 0, quiet: 10, loud: -6, silent: 0, belowSilentGate: 0, off: 0, limiterOn: true, limiterOff: false,
    });
    // A mix inside the deadband: no gain, nothing to limit.
    const plain = exported('loud-deadband').stats;
    expect(Math.abs(plain.lufsIn! - LOUDNESS.targetLufs)).toBeLessThanOrEqual(LOUDNESS.deadbandLu);
    expect(plain.gainDb).toBe(0);
    expect(plain.limiterMaxReductionDb).toBe(0);
    // Silence: no gain.
    const silent = exported('loud-silent');
    expect(silent.stats.lufsIn).toBeNull();
    expect(silent.stats.gainDb).toBe(0);
    expect(silent.file.lufs).toBeNull();
    // A hot mix inside the deadband: no gain, but the limiter always runs and engages.
    const hot = exported('loud-hot');
    expect(Math.abs(hot.stats.lufsIn! - LOUDNESS.targetLufs)).toBeLessThanOrEqual(LOUDNESS.deadbandLu);
    expect(hot.stats.gainDb).toBe(0);
    expect(hot.stats.limiterOn).toBe(true);
    expect(hot.stats.limiterMaxReductionDb).toBeGreaterThan(0.5);
    // A quiet mix: one gain, rounded to 0.1 dB.
    const quiet = exported('loud-quiet').stats;
    expect(quiet.gainDb).toBeCloseTo(Math.round((LOUDNESS.targetLufs - quiet.lufsIn!) * 10) / 10, 9);
    expect(quiet.gainDb).toBeGreaterThan(9);
  });

  it('lands the finished file on target with its true peak under the limit', () => {
    for (const item of report.exports) {
      const { file, stats } = exported(item.name);
      if (!item.measured) continue;
      if (file.truePeak !== null) expect(file.truePeak, `${item.name} true peak`).toBeLessThanOrEqual(LOUDNESS.truePeakLimitDb);
      // Where the limiter barely touched it, one gain lands the file within 0.5 LU of target
      // (heavy limiting, like the clap's, takes loudness off by design: the gain is measured once).
      if (stats.lufsIn !== null && stats.lufsIn > LOUDNESS.silentBelowLufs && stats.limiterMaxReductionDb < 2) {
        expect(Math.abs(file.lufs! - item.targetLufs!), `${item.name} final LUFS ${file.lufs}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('holds a dense, hot, broadband mix under the true-peak limit after AAC (8x limiter detector)', () => {
    const dense = exported('loud-dense-hot');
    expect(dense.stats.gainDb).toBeGreaterThan(4);
    expect(dense.stats.limiterMaxReductionDb).toBeGreaterThan(4);
    expect(dense.file.truePeak!).toBeLessThanOrEqual(LOUDNESS.truePeakLimitDb);
    expect(exported('loud-dense').file.truePeak!).toBeLessThanOrEqual(LOUDNESS.truePeakLimitDb);
  });

  it('lays a rotated phone clip out upright: the plan from its geometry, the pixels from its transform', () => {
    // The committed plan is what the builder makes from the phone's geometry (stored 640 x 360, rotated 90).
    const { plan } = JSON.parse(readFileSync(ROTATED_PLAN_FILE, 'utf8')) as { plan: unknown };
    expect(plan).toEqual(buildRotatedPlan());
    const rotated = buildRotatedPlan();
    const box = rotated.overlays.find((item) => item.kind === 'broll')!.box;
    expect(box.h / box.w).toBeCloseTo(640 / 360, 1);
    // Upright and frame-shaped, the punch-in is exactly two keys.
    expect(rotated.video.segments[0]!.layers[0]!.cropKeys).toHaveLength(2);
    // The server's record alone (no rotation) lays it out sideways: a landscape box, other zoom keys.
    const sideways = buildRotatedPlan({ ...PORTRAIT_CLIP, rotation: 0 });
    const flat = sideways.overlays.find((item) => item.kind === 'broll')!.box;
    expect(flat.h / flat.w).toBeCloseTo(360 / 640, 1); // boxes round to whole pixels
    expect(sideways.video.segments[0]!.layers[0]!.cropKeys).not.toEqual(rotated.video.segments[0]!.layers[0]!.cropKeys);
    // Decoded from the exported file: the clip's white and grey patches where an upright clip puts them,
    // full frame at the start, zoomed 1.5x into the top-left corner at the end, and inside the b-roll box.
    const probes = exported('rotated-broll').file.probes!;
    const grey = (value: number): [number, number, number] => [value, value, value];
    const close = (name: string, expected: [number, number, number], tolerance: number): void => {
      probes[name]!.forEach((value, index) => expect(Math.abs(value - expected[index]!), `${name}[${index}] ${value}`).toBeLessThanOrEqual(tolerance));
    };
    close('mainWhite', grey(1), 0.05);
    close('mainGrey', grey(0.18), 0.02);
    close('zoomedWhite', grey(1), 0.05);
    close('zoomedBase', [0.1, 0.15, 0.1], 0.02);
    close('pipWhite', grey(1), 0.05);
    close('pipGrey', grey(0.18), 0.02);
  });

  it.runIf(ffmpegAvailable)('holds the finished files to ffmpeg too', async () => {
    for (const name of ['audio-duck-loudness', 'loud-quiet', 'loud-hot', 'loud-dense']) {
      const measured = await ffmpegLoudness(join(dir!, 'out', `${name}.mp4`));
      expect(Math.abs(measured.integrated! - LOUDNESS.targetLufs), `${name} ffmpeg I ${measured.integrated}`).toBeLessThanOrEqual(0.5);
      expect(measured.truePeak!, `${name} ffmpeg true peak`).toBeLessThanOrEqual(LOUDNESS.truePeakLimitDb);
    }
    // The hot dense mix: limited hard, the decoded AAC still reads under the limit by ffmpeg's 4x meter.
    const hot = await ffmpegLoudness(join(dir!, 'out', 'loud-dense-hot.mp4'));
    expect(hot.truePeak!, `loud-dense-hot ffmpeg true peak ${hot.truePeak}`).toBeLessThanOrEqual(LOUDNESS.truePeakLimitDb);
  });

  it.runIf(ffmpegAvailable || required)('meters like ffmpeg ebur128 (BS.1770-4)', async () => {
    expect(ffmpegAvailable, 'ffmpeg is required where REQUIRE_SWIFT=1').toBe(true);
    const expected: Record<string, number> = { 'pink-23': -23, 'speech-18': -18, 'near-silence-65': -65 };
    for (const [name, mine] of Object.entries(report.meter)) {
      const theirs = await ffmpegLoudness(mine.file);
      expect(Math.abs(mine.integrated! - theirs.integrated!), `${name}: ${mine.integrated} vs ffmpeg ${theirs.integrated}`).toBeLessThanOrEqual(0.3);
      if (name === 'intersample-12k') {
        // A 0.5 sine at fs/4 sampled 45 degrees off its peaks: samples at -9.03 dBFS, true peak exactly -6.02 dBTP.
        expect(mine.samplePeak!).toBeCloseTo(-9.03, 1);
        expect(Math.abs(mine.truePeak! - 20 * Math.log10(0.5)), `${name} true peak ${mine.truePeak}`).toBeLessThanOrEqual(0.3);
      } else {
        expect(Math.abs(mine.truePeak! - theirs.truePeak!), `${name}: peak ${mine.truePeak} vs ffmpeg ${theirs.truePeak}`).toBeLessThanOrEqual(0.3);
        expect(Math.abs(mine.integrated! - expected[name]!), name).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it('cancels, refuses a full disk and the empty plan, stops when too hot, and removes the temp file', () => {
    expect(report.failures.cancel).toMatchObject({ outcome: 'cancelled', fileRemoved: true });
    expect(report.failures.noSpace).toMatchObject({ outcome: 'notEnoughSpace', fileAbsent: true, message: 'Not enough space' });
    expect(report.failures.noSpace.needed).toBeGreaterThan(50 << 20);
    expect(report.failures.empty).toBe('emptyPlan');
    expect(report.failures.thermal).toMatchObject({ outcome: 'tooHot', fileRemoved: true });
  });

  it('throttles progress events to state changes, 1% steps and 10 Hz', () => {
    // 3 states x 1801 frame reports in 10.8 s: at most 10 a second plus the state changes.
    expect(report.throttle.sent).toBeGreaterThanOrEqual(3);
    expect(report.throttle.sent).toBeLessThanOrEqual(Math.ceil(report.throttle.seconds * 10) + 3);
  });

  it('reports speed and memory for every export', () => {
    const rows = report.exports.map((item) => {
      const { stats } = exported(item.name);
      expect(stats.xRealtime, item.name).toBeGreaterThan(0);
      expect(stats.peakMemMB, item.name).toBeGreaterThan(0);
      return `${item.name}: ${stats.xRealtime.toFixed(1)}x realtime, ${stats.seconds.toFixed(2)} s, peak ${Math.round(stats.peakMemMB)} MB`;
    });
    console.info(`device export speed (this machine):\n${rows.join('\n')}`);
  });
});
