import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Plan P5 (D1, OV10): the phone's native preview. The macOS harness
 * (apps/mobile/modules/editify-engine/parity/preview) drives PlanPlayer, the
 * AVPlayer behind EditifyPlayerView, with an AVPlayerItemVideoOutput in place
 * of the AVPlayerLayer: frames at exact seeks against the render goldens,
 * parameter-only updates swapping the video composition on the same item
 * (and the paused frame redrawing), structural updates rebuilding the item
 * at the same time, (revision, buildSeq) ordering, 60 Hz box updates while
 * playing and while paused, audio continuity through an audio tap, and a
 * proxy replaced by its original.
 *
 * Needs swiftc (macOS). Elsewhere it skips, except where REQUIRE_SWIFT=1 (the
 * macOS CI `engine` job): there a missing toolchain fails. The golden
 * tolerance is render-golden.test.ts's (uncompressed frames): per-channel mean
 * absolute difference <= 0.01, blurred max <= 0.1.
 *
 * Timing numbers (update latency, frame intervals) are reported and bounded
 * loosely: a CI VM renders on the CPU, a phone is the real measure (P7).
 */
const root = resolve(fileURLToPath(import.meta.url), '../../..');
const engine = join(root, 'apps/mobile/modules/editify-engine');
const swiftAvailable = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;
const required = process.env.REQUIRE_SWIFT === '1';
const MEAN_ABS_MAX = 0.01;
const BLURRED_MAX = 0.1;

type Vec = [number, number, number];
interface Stats { count: number; p50: number; p95: number; max: number }
interface Compare { meanAbs?: Vec; blurredMax?: number; missingGolden?: boolean; sizeMismatch?: boolean }
interface Continuity { callbacks: number; seconds: number; maxWallGapMs: number; sourceJumps: number; largestSourceJumpMs: number; sampleRate: number }
interface Report {
  goldens: Array<{ name: string; mode: string; errors: string[]; frames: Array<{ k: number; golden: string; seekMs: number; compare: Compare }> }>;
  seekToFrameMs: Stats;
  paramUpdate: {
    mode: string; sameComposition: boolean; sameItem: boolean; audioSwapped: boolean; pausedFrameRefreshed: boolean; timeKept: boolean;
    refreshMs: number; beforeOld: Vec; beforeNew: Vec; afterOld?: Vec; afterNew?: Vec;
  };
  captionStyle: { mode: string; sameComposition: boolean; doingBefore: { white: number; red: number }; doingAfter?: { white: number; red: number } };
  structural: {
    paused: { mode: string; newComposition: boolean; time: number; expectedTime: number; code?: number; expectedCode?: number };
    playing: { mode: string; timeBefore: number; timeAfter: number; playingAfter: boolean; movingMs: number; advanced300ms: number };
  };
  ordering: { accepted: boolean[]; appliedAfter: number; newPlayerAcceptsOlder: boolean };
  drag60: {
    sent: number; applied: number; modes: string[]; audioSwaps: number; latencyMs: Stats; decodeMs: Stats; stalls: number;
    wallSeconds: number; playedSeconds: number; frames: number; frameIntervalMs: Stats; playingAfter: boolean; audio: Continuity;
  };
  audioSwap: { mode: string; audioSwapped: boolean; playingAfter: boolean; audio: Continuity };
  pausedDrag60: { sent: number; applied: number; refreshedFrames: number; refreshIntervalMs: Stats; stillAtTime: boolean; finalAtLast?: Vec };
  proxySwap: { first: string; second: string; proxyCode: number; reloaded: boolean; othersKept: boolean; originalCompare: Compare };
  renderCap: { scale4k: number; scale4kInView: number };
}

let dir: string | undefined;
let report: Report;
// Async: the build and the playback take a while on a CI runner (see render-golden.test.ts).
const run = promisify(execFile);

beforeAll(async () => {
  if (!swiftAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'editify-native-preview-'));
  const binary = join(dir, 'preview-harness');
  const sources = ['RenderPlan', 'PlanBuilder', 'EditifyCompositor', 'CaptionRenderer', 'OverlayGraphics', 'AnalysisMath', 'PlanPlayer']
    .map((name) => join(engine, 'ios', `${name}.swift`));
  const harness = [join(engine, 'parity/render-golden/HarnessMedia.swift'), join(engine, 'parity/preview/main.swift')];
  await run('xcrun', ['swiftc', '-O', '-swift-version', '5', ...sources, ...harness, '-o', binary], { maxBuffer: 64 << 20 });
  const args = [join(engine, 'parity/goldens/manifest.json'), root, join(dir, 'work'), join(dir, 'out')];
  report = JSON.parse((await run(binary, args, { encoding: 'utf8', maxBuffer: 64 << 20 })).stdout) as Report;
  // The numbers a phone run is compared against (P7).
  console.info('native preview on this Mac:', JSON.stringify({
    seekToFrameMs: report.seekToFrameMs,
    updateLatencyMs: report.drag60.latencyMs,
    decodeMs: report.drag60.decodeMs,
    frameIntervalMs: report.drag60.frameIntervalMs,
    pausedRefreshIntervalMs: report.pausedDrag60.refreshIntervalMs,
    structuralResumeMs: report.structural.playing.movingMs,
    audioSwapJumpMs: report.audioSwap.audio.largestSourceJumpMs,
  }));
}, 600000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('native preview: harness availability', () => {
  it.runIf(required)('has swiftc where REQUIRE_SWIFT=1', () => {
    expect(swiftAvailable).toBe(true);
  });
});

describe.skipIf(!swiftAvailable)('native preview (PlanPlayer on macOS)', () => {
  it('shows the golden frames at exact seeks', () => {
    const frames = report.goldens.flatMap((render) => render.frames.map((frame) => ({ name: render.name, frame })));
    expect(frames.length).toBeGreaterThanOrEqual(13);
    for (const render of report.goldens) expect(render.errors, render.name).toEqual([]);
    for (const { name, frame } of frames) {
      const label = `${name}#${frame.k} (${frame.golden})`;
      expect(frame.compare.missingGolden, label).toBeUndefined();
      expect(frame.compare.sizeMismatch, label).toBeUndefined();
      for (const value of frame.compare.meanAbs!) expect(value, `${label} mean abs`).toBeLessThanOrEqual(MEAN_ABS_MAX);
      expect(frame.compare.blurredMax!, `${label} blurred max`).toBeLessThanOrEqual(BLURRED_MAX);
    }
  });

  it('moves an overlay with a parameter-only update: same item and composition, the paused frame redraws', () => {
    const update = report.paramUpdate;
    expect(update).toMatchObject({ mode: 'update', sameComposition: true, sameItem: true, audioSwapped: false, pausedFrameRefreshed: true, timeKept: true });
    // The logo's white patch was at the old place and is now at the new one.
    expect(Math.min(...update.beforeOld)).toBeGreaterThan(0.95);
    expect(Math.max(...update.beforeNew)).toBeLessThan(0.2);
    expect(Math.min(...update.afterNew!)).toBeGreaterThan(0.95);
    expect(Math.min(...update.afterOld!)).toBeLessThan(0.9);
  });

  it('restyles a caption in place and redraws the paused frame', () => {
    const style = report.captionStyle;
    expect(style).toMatchObject({ mode: 'update', sameComposition: true });
    expect(style.doingBefore.white).toBeGreaterThan(1000);
    expect(style.doingBefore.red).toBe(0);
    expect(style.doingAfter!.red).toBeGreaterThan(1000);
    expect(style.doingAfter!.white).toBe(0);
  });

  it('rebuilds a structural edit at the same time, paused and playing', () => {
    const { paused, playing } = report.structural;
    expect(paused).toMatchObject({ mode: 'rebuild', newComposition: true });
    expect(paused.time).toBeCloseTo(paused.expectedTime, 6);
    // The trimmed clip shows source frame k + 15 (srcStart 0.5 s at 30 fps).
    expect(paused.code).toBe(paused.expectedCode);
    expect(playing.mode).toBe('rebuild');
    expect(Math.abs(playing.timeAfter - playing.timeBefore)).toBeLessThan(0.1);
    expect(playing.playingAfter).toBe(true);
    expect(playing.advanced300ms).toBeGreaterThan(0.2);
  });

  it('drops plans that are not strictly newer, and a new player orders afresh (OV10)', () => {
    // Offered after (5, 10): (5, 10) (5, 9) (4, 99) (5, 11) (6, 0).
    expect(report.ordering).toEqual({ accepted: [false, false, false, true, true], appliedAfter: 2, newPlayerAcceptsOlder: true });
  });

  it('takes 60 Hz box updates while playing without stalling', () => {
    const drag = report.drag60;
    expect(drag.sent).toBeGreaterThanOrEqual(110);
    // Coalesced at most: never more applied than sent, and the last one always lands.
    expect(drag.applied).toBeGreaterThan(0);
    expect(drag.applied).toBeLessThanOrEqual(drag.sent);
    expect(drag.modes).toEqual(['update']);
    expect(drag.audioSwaps).toBe(0);
    expect(drag.stalls).toBe(0);
    expect(drag.playingAfter).toBe(true);
    expect(drag.playedSeconds).toBeGreaterThan(1.7);
    expect(drag.frames).toBeGreaterThan(40);
    expect(drag.latencyMs.p95).toBeLessThan(50);
  });

  it('keeps the sound continuous while the video composition swaps 60 times a second', () => {
    const audio = report.drag60.audio;
    if (audio.callbacks === 0) return; // no audio device on this runner: nothing to tap
    expect(audio.sourceJumps).toBe(0);
    expect(audio.seconds).toBeGreaterThan(1.7);
    expect(audio.maxWallGapMs).toBeLessThan(250);
  });

  it('keeps playing through an audio-parameter swap', () => {
    // Replacing the item's audio mix restarts its render chain: the tap shows how far the
    // sound jumps (about 170 ms on a Mac), reported for the phone check rather than bounded.
    expect(report.audioSwap).toMatchObject({ mode: 'update', audioSwapped: true, playingAfter: true });
  });

  it('redraws the paused frame through 60 Hz box updates', () => {
    const paused = report.pausedDrag60;
    expect(paused.stillAtTime).toBe(true);
    expect(paused.applied).toBeGreaterThan(0);
    expect(paused.refreshedFrames).toBeGreaterThan(paused.sent / 4);
    expect(Math.min(...paused.finalAtLast!)).toBeGreaterThan(0.95);
  });

  it('reloads only the asset whose proxy was replaced by its original', () => {
    const swap = report.proxySwap;
    expect(swap).toMatchObject({ first: 'rebuild', second: 'rebuild', reloaded: true, othersKept: true, proxyCode: 40 });
    for (const value of swap.originalCompare.meanAbs!) expect(value).toBeLessThanOrEqual(MEAN_ABS_MAX);
    expect(swap.originalCompare.blurredMax!).toBeLessThanOrEqual(BLURRED_MAX);
  });

  it('caps the preview render at 1080 x 1920', () => {
    expect(report.renderCap).toEqual({ scale4k: 0.5, scale4kInView: 0.5 });
  });
});
