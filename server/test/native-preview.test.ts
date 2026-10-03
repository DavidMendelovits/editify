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
 * playing and while paused, audio continuity through an audio tap, a proxy
 * replaced by its original, the lifecycle holds (backgrounded and parked kept
 * apart), server copies through token refreshes and expiry, and the preview's
 * downloads and temp stills.
 *
 * Needs swiftc (macOS). Elsewhere it skips, except where REQUIRE_SWIFT=1 (the
 * macOS CI `engine` job): there a missing toolchain fails. The golden
 * tolerance is render-golden.test.ts's (uncompressed frames): per-channel mean
 * absolute difference <= 0.01, blurred max <= 0.1.
 *
 * Timing numbers (update latency, frame intervals) are reported and bounded
 * loosely, as ratios where they can be: a CI VM may render at ~20 fps on the
 * CPU, and a phone is the real measure (P7). The audio checks skip, saying so,
 * on a runner whose audio tap gets no callbacks (no output device).
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
    stickerRedraws: number; fps: number;
  };
  audioSwap: {
    modes: string[]; edits: number; deferred: number; swapsDuringBurst: number; swaps: number; swapLandedMs: number; playingAfter: boolean; audio: Continuity;
  };
  lifecycle: {
    suspend: { accepted: boolean; appliedWhileSuspended: number; frameWhileSuspended: boolean; appliedAfterResume: number; movedAfterResume?: Vec };
    failure: { rebuilt: boolean; errorsAfterFirst: number; errorsAfterSecond: number; timeAfterRetry: number };
    parked: { item: boolean; stickerBitmaps: number };
    unparked: { item: boolean; timeKept: boolean };
    backgroundPark: { accepted: boolean; itemWhileBackgrounded: boolean; appliedWhileBackgrounded: number; item: boolean; timeKept: boolean; appliedAfterResume: number };
    teardown: { applied: number; item: boolean };
  };
  pausedDrag60: { sent: number; applied: number; refreshedFrames: number; refreshIntervalMs: Stats; stillAtTime: boolean; finalAtLast?: Vec };
  proxySwap: { first: string; second: string; proxyCode: number; reloaded: boolean; othersKept: boolean; originalCompare: Compare };
  renderCap: { scale4k: number; scale4kInView: number };
  serverCopies: {
    tokenRefresh: { mode: string; sameItem: boolean; sameSource: boolean; stale: string[] };
    staleRetry: { rebuilt: boolean; reloaded: boolean; stale: string[]; expired: number; errors: number; timeKept: boolean };
    asked: { expired: number; errors: number; sameItem: boolean; applied: number; state: string };
    retried: { mode: string; reloaded: boolean; state: string; timeKept: boolean };
    fellBack: { expired: number; errors: number };
    structuralSwap: { staleBefore: string[]; mode: string; reloaded: boolean; staleAfter: string[] };
  };
  previewFiles: { runs: number; ended: number; cancelled: number; keptDeleted: boolean; lateDeleted: boolean; lateThrew: boolean; held: number };
  /** False on a machine with no audio output device (CI VMs): muted players, no tap. */
  audioDevice: boolean;
  steps: Array<{ step: string; ms: number }>;
}

let dir: string | undefined;
let report: Report;
// Async: the build and the playback take a while on a CI runner (see render-golden.test.ts).
const run = promisify(execFile);

beforeAll(async () => {
  if (!swiftAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'editify-native-preview-'));
  const binary = join(dir, 'preview-harness');
  const sources = ['RenderPlan', 'PlanBuilder', 'EditifyCompositor', 'CaptionRenderer', 'OverlayGraphics', 'AnalysisMath', 'PlanPlayer', 'PreviewFiles']
    .map((name) => join(engine, 'ios', `${name}.swift`));
  const harness = [join(engine, 'parity/render-golden/HarnessMedia.swift'), join(engine, 'parity/preview/main.swift')];
  await run('xcrun', ['swiftc', '-O', '-swift-version', '5', ...sources, ...harness, '-o', binary], { maxBuffer: 64 << 20 });
  const args = [join(engine, 'parity/goldens/manifest.json'), root, join(dir, 'work'), join(dir, 'out')];
  // The harness bounds itself (a watchdog exits with the stuck step within 300 s and prints a
  // line per step to stderr); this timeout is the backstop under the 600 s hook.
  try {
    report = JSON.parse((await run(binary, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 420_000, killSignal: 'SIGKILL' })).stdout) as Report;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`preview harness failed:\n${stderr.split('\n').slice(-25).join('\n')}\n${String(error)}`);
  }
  console.info('native preview steps:', report.steps.map((step) => `${step.step} ${step.ms} ms`).join(', '), `| audio device: ${report.audioDevice}`);
  // The numbers a phone run is compared against (P7).
  console.info('native preview on this Mac:', JSON.stringify({
    seekToFrameMs: report.seekToFrameMs,
    updateLatencyMs: report.drag60.latencyMs,
    decodeMs: report.drag60.decodeMs,
    frameIntervalMs: report.drag60.frameIntervalMs,
    pausedRefreshIntervalMs: report.pausedDrag60.refreshIntervalMs,
    structuralResumeMs: report.structural.playing.movingMs,
    audioSwapJumpMs: report.audioSwap.audio.largestSourceJumpMs,
    audioSwapLandedMs: report.audioSwap.swapLandedMs,
    tapCallbacks: report.drag60.audio.callbacks,
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
    expect(drag.sent).toBeGreaterThanOrEqual(drag.wallSeconds * 50);
    // Coalesced at most: never more applied than sent, and the last one always lands.
    expect(drag.applied).toBeGreaterThan(0);
    expect(drag.applied).toBeLessThanOrEqual(drag.sent);
    expect(drag.modes).toEqual(['update']);
    expect(drag.audioSwaps).toBe(0);
    expect(drag.stalls).toBe(0);
    expect(drag.playingAfter).toBe(true);
    // Playback kept pace with the wall clock, and frames kept coming (at least 15 fps on a slow VM).
    expect(drag.playedSeconds / drag.wallSeconds).toBeGreaterThan(0.85);
    expect(drag.frames / drag.wallSeconds).toBeGreaterThan(15);
    expect(drag.latencyMs.p95).toBeLessThan(1000 / 60 * 3);
    // Only the logo moved: the emoji and callout bitmaps came from the cache.
    expect(drag.stickerRedraws).toBe(0);
  });

  it('keeps the sound continuous while the video composition swaps 60 times a second', (ctx) => {
    const audio = report.drag60.audio;
    if (audio.callbacks === 0) {
      console.info('native preview: the audio tap got no callbacks on this runner (no output device); continuity unchecked');
      ctx.skip();
    }
    expect(audio.sourceJumps).toBe(0);
    expect(audio.seconds / report.drag60.wallSeconds).toBeGreaterThan(0.85);
    expect(audio.maxWallGapMs).toBeLessThan(250);
  });

  it('swaps the mix once after a burst of sound edits while playing, and keeps playing', (ctx) => {
    const swap = report.audioSwap;
    expect(swap.modes).toEqual(['update']);
    expect(swap.deferred).toBe(swap.edits);
    expect(swap.swapsDuringBurst).toBe(0);
    expect(swap.swaps).toBe(1);
    expect(swap.playingAfter).toBe(true);
    if (swap.audio.callbacks === 0) {
      console.info('native preview: the audio tap got no callbacks on this runner; the swap skip is unmeasured');
      ctx.skip();
    }
    // Replacing a mix restarts the audio chain: a skip, bounded.
    expect(Math.abs(swap.audio.largestSourceJumpMs)).toBeLessThan(300);
  });

  it('waits out the background, retries a failed item once, parks and tears down cleanly', () => {
    const { suspend, failure, parked, unparked, teardown } = report.lifecycle;
    expect(suspend).toMatchObject({ accepted: true, appliedWhileSuspended: 0, frameWhileSuspended: false, appliedAfterResume: 1 });
    expect(Math.min(...suspend.movedAfterResume!)).toBeGreaterThan(0.95);
    expect(failure).toMatchObject({ rebuilt: true, errorsAfterFirst: 0, errorsAfterSecond: 1 });
    expect(failure.timeAfterRetry).toBeCloseTo(40 / 30, 6);
    expect(parked).toEqual({ item: false, stickerBitmaps: 0 });
    expect(unparked).toEqual({ item: true, timeKept: true });
    expect(teardown).toEqual({ applied: 0, item: false });
  });

  it('keeps background and park apart: unparked while backgrounded, nothing runs until the app returns', () => {
    expect(report.lifecycle.backgroundPark).toEqual({
      accepted: true, itemWhileBackgrounded: false, appliedWhileBackgrounded: 0, item: true, timeKept: true, appliedAfterResume: 1,
    });
  });

  it('keeps the item and its source through a token-only refresh, and swaps the URL at the next rebuild', () => {
    const { tokenRefresh, staleRetry, structuralSwap } = report.serverCopies;
    expect(tokenRefresh).toEqual({ mode: 'update', sameItem: true, sameSource: true, stale: ['asset-talk'] });
    // The old token expiring under it: rebuilt on the URL already held, with no request for media.
    expect(staleRetry).toEqual({ rebuilt: true, reloaded: true, stale: [], expired: 0, errors: 0, timeKept: true });
    expect(structuralSwap).toEqual({ staleBefore: ['asset-talk'], mode: 'rebuild', reloaded: true, staleAfter: [] });
  });

  it('asks for fresh media when server copies fail, retries on them, and reports a failure after that', () => {
    const { asked, retried, fellBack } = report.serverCopies;
    // No retry on the same URLs: one mediaExpired, the failed item left as is.
    expect(asked).toEqual({ expired: 1, errors: 0, sameItem: true, applied: 0, state: 'awaiting' });
    expect(retried).toEqual({ mode: 'rebuild', reloaded: true, state: 'retried', timeKept: true });
    expect(fellBack).toEqual({ expired: 1, errors: 1 });
  });

  it('never starts a download on an invalidated session, and deletes a still that lands after teardown', () => {
    const files = report.previewFiles;
    expect(files.ended).toBe(files.runs);
    expect(files.cancelled).toBeGreaterThan(0);
    expect(files).toMatchObject({ keptDeleted: true, lateDeleted: true, lateThrew: true, held: 0 });
  });

  it('redraws the paused frame through 60 Hz box updates', () => {
    const paused = report.pausedDrag60;
    expect(paused.stillAtTime).toBe(true);
    expect(paused.applied).toBeGreaterThan(0);
    expect(paused.refreshedFrames).toBeGreaterThan(paused.sent / 6);
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
