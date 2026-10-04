import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_FLAGS, ADAPTER_RUNS, ADAPTER_SOURCES, type AdapterReport } from './helpers/engine-adapters.js';

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
 * apart), server copies through token refreshes and expiry (also over HTTP,
 * from a local server that checks the token's exp on every read), and the
 * preview's downloads and temp stills.
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
  adapters: AdapterReport;
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
  pausedDrag60: {
    sent: number; applied: number; refreshedFrames: number; refreshIntervalMs: Stats; stillAtTime: boolean; finalAtLast?: Vec;
    lastDrawn: boolean; lastDrawnAfterMs: number;
  };
  pausedSeekAhead: { rightWithinMs: number; seeksLanded: number; samples: string[] };
  transientLog: { paused: { sameItem: boolean; reconnects: number; stalls: number }; playing: { sameItem: boolean; reconnects: number; buffered: boolean; playing: boolean } };
  shortPicture: { pictureEnd: number; soundEnd: number; ended: boolean; reconnects: number; expired: number; errors: number };
  proxySwap: { first: string; second: string; proxyCode: number; reloaded: boolean; othersKept: boolean; originalCompare: Compare };
  renderCap: { scale4k: number; scale4kInView: number };
  serverCopies: {
    paused: { mode: string; newItem: boolean; reloaded: boolean; stale: string[]; timeKept: boolean };
    playing: { mode: string; sameItem: boolean; sameSource: boolean; stale: string[]; playing: boolean };
    staleRetry: { rebuilt: boolean; reloaded: boolean; stale: string[]; expired: number; errors: number };
    pauseSwap: { staleWhilePlaying: string[]; rebuilt: boolean; reloaded: boolean; stale: string[] };
    asked: { expired: number; errors: number; sameItem: boolean; applied: number; state: string };
    interleave: { mode: string; reloaded: boolean; state: string; expired: number; errors: number };
    retried: { mode: string; reloaded: boolean; state: string };
    fellBack: { expired: number; errors: number };
    structuralSwap: { staleBefore: string[]; mode: string; reloaded: boolean; staleAfter: string[] };
    loadFailure: { mode: string; expired: number; errors: number; state: string };
    loadRetried: { mode: string; state: string; errors: number };
  };
  http: {
    expiring: { reported: boolean; reportMs: number; expired: number; errors: number; retryMode: string; code: number; errorsAfter: number; refused: number };
    staleSwap: { mode: string; staleWhilePlaying: string[]; moved: boolean; expired: number; errors: number; refused: number; code: number };
  };
  skew: Record<'withoutOffset' | 'withOffset', { reported: boolean; expired: number; refusedBeforeReport: number }>;
  silentDrop: {
    backSoon: {
      detected: boolean; cutToDetectMs: number; starveToDetectMs: number; buffering: boolean; reconnects: number; failedRequests: number;
      recovered: boolean; expired: number; errors: number; code: number;
    };
    staysDown: { asked: boolean; expired: number; errors: number; reconnects: number; retryMode: string; code: number; errorsAfter: number };
  };
  errorLogKinds: string[];
  stickerAdd: Record<'onFrame' | 'roundedUp' | 'floored', { mode: string; changed: number; timeKept: boolean }> & { errors: string[] };
  previewFiles: { runs: number; ended: number; cancelled: number; keptDeleted: boolean; lateDeleted: boolean; lateThrew: boolean; held: number };
  /** False on a machine with no audio output device (CI VMs): muted players, no tap. */
  audioDevice: boolean;
  steps: Array<{ step: string; ms: number }>;
}

let dir: string | undefined;
/** Each adapter set's run (D24); the describe below runs once per set with `report` pointing at its run. */
const reports = {} as Record<AdapterReport['set'], Report>;
let report: Report;
// Async: the build and the playback take a while on a CI runner (see render-golden.test.ts).
const run = promisify(execFile);

beforeAll(async () => {
  if (!swiftAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'editify-native-preview-'));
  const binary = join(dir, 'preview-harness');
  // As render-golden.test.ts, plus the player and its preview files.
  const sources = ['Core/RenderPlan', 'Engine/PlanBuilder', 'Engine/EditifyCompositor', 'Core/CaptionRenderer', 'Core/OverlayGraphics', 'Core/AnalysisMath',
    'Engine/PlanPlayer', 'Core/PreviewFiles', ...ADAPTER_SOURCES]
    .map((name) => join(engine, 'ios', `${name}.swift`));
  const harness = ['render-golden/HarnessMedia.swift', 'preview/MediaServer.swift', 'preview/main.swift'].map((name) => join(engine, 'parity', name));
  await run('xcrun', ['swiftc', '-O', '-swift-version', '5', ...ADAPTER_FLAGS, ...sources, ...harness, '-o', binary], { maxBuffer: 64 << 20 });
  // One set after the other: the runs measure playback timing.
  for (const { set, env } of ADAPTER_RUNS) {
    const args = [join(engine, 'parity/goldens/manifest.json'), root, join(dir, `work-${set}`), join(dir, `out-${set}`)];
    // The harness bounds itself (a watchdog exits with the stuck step within 300 s and prints a
    // line per step to stderr); this timeout is the backstop.
    let current: Report;
    try {
      current = JSON.parse((await run(binary, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 420_000, killSignal: 'SIGKILL', env })).stdout) as Report;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      throw new Error(`preview harness (${set} adapters) failed:\n${stderr.split('\n').slice(-25).join('\n')}\n${String(error)}`);
    }
    reports[set] = current;
    console.info(`native preview steps (${set}):`, current.steps.map((step) => `${step.step} ${step.ms} ms`).join(', '), `| audio device: ${current.audioDevice}`);
    // The numbers a phone run is compared against (P7).
    console.info(`native preview on this Mac (${set}):`, JSON.stringify({
      seekToFrameMs: current.seekToFrameMs,
      updateLatencyMs: current.drag60.latencyMs,
      decodeMs: current.drag60.decodeMs,
      frameIntervalMs: current.drag60.frameIntervalMs,
      pausedRefreshIntervalMs: current.pausedDrag60.refreshIntervalMs,
      structuralResumeMs: current.structural.playing.movingMs,
      audioSwapJumpMs: current.audioSwap.audio.largestSourceJumpMs,
      audioSwapLandedMs: current.audioSwap.swapLandedMs,
      tapCallbacks: current.drag60.audio.callbacks,
    }));
  }
}, 1200000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('native preview: harness availability', () => {
  it.runIf(required)('has swiftc where REQUIRE_SWIFT=1', () => {
    expect(swiftAvailable).toBe(true);
  });
});

(swiftAvailable ? describe : describe.skip).each(ADAPTER_RUNS)('native preview (PlanPlayer on macOS, $set adapters)', ({ set, expected }) => {
  beforeAll(() => {
    report = reports[set];
  });

  it('built the adapters it was asked for (D24)', () => {
    expect(report.adapters).toEqual(expected);
  });

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

  it('moves a token-only refresh to the new URL at once when paused, and at the next pause or rebuild when playing', () => {
    const { paused, playing, staleRetry, pauseSwap, structuralSwap } = report.serverCopies;
    expect(paused).toEqual({ mode: 'rebuild', newItem: true, reloaded: true, stale: [], timeKept: true });
    // Playing: no rebuild (no clock freeze); the source is token-stale until a pause or rebuild.
    expect(playing).toEqual({ mode: 'update', sameItem: true, sameSource: true, stale: ['asset-talk'], playing: true });
    // The old token failing under it: rebuilt on the URL already held, with no request for media.
    expect(staleRetry).toEqual({ rebuilt: true, reloaded: true, stale: [], expired: 0, errors: 0 });
    expect(pauseSwap).toEqual({ staleWhilePlaying: ['asset-talk'], rebuilt: true, reloaded: true, stale: [] });
    expect(structuralSwap).toEqual({ staleBefore: ['asset-talk'], mode: 'rebuild', reloaded: true, staleAfter: [] });
  });

  it('asks for fresh media when server copies fail, retries only on the tagged plan, and reports a failure after that', () => {
    const { asked, interleave, retried, fellBack } = report.serverCopies;
    // No retry on the same URLs: one mediaExpired, the failed item left as is.
    expect(asked).toEqual({ expired: 1, errors: 0, sameItem: true, applied: 0, state: 'awaiting' });
    // An untagged edit landing meanwhile applies on the old URLs and doesn't spend the retry,
    // and its item failing too is neither a second request nor an error.
    expect(interleave).toEqual({ mode: 'rebuild', reloaded: false, state: 'awaiting', expired: 1, errors: 0 });
    expect(retried).toEqual({ mode: 'rebuild', reloaded: true, state: 'retried' });
    expect(fellBack).toEqual({ expired: 1, errors: 1 });
  });

  it('treats a server copy that fails to load like a failed item: one request for media, then the retry', () => {
    const { loadFailure, loadRetried } = report.serverCopies;
    expect(loadFailure).toEqual({ mode: 'failed', expired: 1, errors: 0, state: 'awaiting' });
    expect(loadRetried).toEqual({ mode: 'rebuild', state: 'retried', errors: 0 });
  });

  it('acts before a media token expires mid-play over HTTP, instead of playing on over refused reads', () => {
    const { expiring, staleSwap } = report.http;
    // No newer URL held: mediaExpired before the 5 s token runs out, then the fresh URL plays
    // real frames from the server (the embedded code is the source frame).
    expect(expiring).toMatchObject({ reported: true, expired: 1, errors: 0, retryMode: 'rebuild', code: 60, errorsAfter: 0, refused: 0 });
    expect(expiring.reportMs).toBeLessThan(8000);
    // A refreshed token held while playing: moved to it before the old one expired, no read refused.
    expect(staleSwap).toEqual({ mode: 'update', staleWhilePlaying: ['asset-talk'], moved: true, expired: 0, errors: 0, refused: 0, code: 75 });
  });

  it('moves token deadlines to the device clock: a phone 20 s behind gets no read refused', () => {
    const { withoutOffset, withOffset } = report.skew;
    // Without the offset the deadline comes 20 s late and the server refuses reads first.
    expect(withoutOffset.refusedBeforeReport).toBeGreaterThan(0);
    expect(withOffset).toEqual({ reported: true, expired: 1, refusedBeforeReport: 0 });
  });

  it('catches a silent drop within a second of starving and reconnects natively, or asks for media if the server stays down', () => {
    const { backSoon, staysDown } = report.silentDrop;
    console.info('native preview silent drop:', JSON.stringify({ cutToDetectMs: backSoon.cutToDetectMs, starveToDetectMs: backSoon.starveToDetectMs }));
    expect(backSoon).toMatchObject({ detected: true, buffering: true, recovered: true, expired: 0, errors: 0, code: 100 });
    expect(backSoon.starveToDetectMs).toBeGreaterThan(0);
    expect(backSoon.starveToDetectMs).toBeLessThan(2000);
    // The buffer ahead (about a second at this rate) plays out first; a CI VM is slower.
    expect(backSoon.cutToDetectMs).toBeLessThan(8000);
    expect(staysDown).toMatchObject({ asked: true, expired: 1, errors: 0, reconnects: 3, retryMode: 'rebuild', code: 100, errorsAfter: 0 });
  });

  it('reads token refusals and transient failures from error-log entries, whatever the code', () => {
    expect(report.errorLogKinds).toEqual([
      'tokenRefused', 'tokenRefused', 'tokenRefused', 'tokenRefused', // 401/403 as status, or in a CoreMedia comment
      'other', 'other', // 404, and a 401 that is really 4013
      'transient', 'transient', 'transient', 'transient', // 503 in a comment, 500, offline, connection lost
      'other',
    ]);
  });

  it('draws a sticker added while paused at the frame on screen at once', () => {
    const { onFrame, roundedUp, floored, errors } = report.stickerAdd;
    expect(onFrame).toMatchObject({ mode: 'update', timeKept: true });
    expect(onFrame.changed).toBeGreaterThan(500);
    expect(floored).toEqual(onFrame);
    // The old stamp (rounded up to the ms) starts on the next frame: [start, end) is right not to draw it.
    expect(roundedUp).toMatchObject({ mode: 'update', changed: 0, timeKept: true });
    expect(errors).toEqual([]);
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
    // The last coalesced update is drawn with no settling plan (a lenient bound for a slow VM).
    expect(paused.lastDrawn).toBe(true);
    expect(paused.lastDrawnAfterMs).toBeLessThan(5000);
  });

  it('shows the right frame after a paused exact seek into remote bytes still arriving, with no re-seek from outside', () => {
    const ahead = report.pausedSeekAhead;
    expect(ahead.rightWithinMs, ahead.samples.join(' | ')).toBeGreaterThan(0);
    expect(ahead.rightWithinMs).toBeLessThan(10_000);
  });

  it('takes one transient error-log entry as a reason to watch, not to reload', () => {
    const { paused, playing } = report.transientLog;
    expect(paused).toEqual({ sameItem: true, reconnects: 0, stalls: 0 });
    expect(playing).toEqual({ sameItem: true, reconnects: 0, buffered: true, playing: true });
  });

  it('plays a remote clip whose picture ends before its sound at a quarter speed without a reconnect', () => {
    const short = report.shortPicture;
    expect(short.pictureEnd).toBeLessThan(short.soundEnd);
    expect(short).toMatchObject({ ended: true, reconnects: 0, expired: 0, errors: 0 });
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
