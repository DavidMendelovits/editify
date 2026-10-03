import { afterEach, describe, expect, it } from 'vitest';
import { applyBatch, type AssetMetadata, type Clip, type OverlayPlacement, type Project, type RenderPlan } from '@editify/shared';
import { HandleDrag } from './preview-handles';
import {
  buildPreviewPlan, createPlanStore, followsNativeTime, isExternalSeek, MediaRecovery, NATIVE_PREVIEW_FLAG, redactMediaToken, urlOrigin, patchOverlayPlacement, PlanFeeder, previewAssetInfo,
  previewPlanSize, previewRoute, projectAssetRefs, resolvePreviewMedia, serverPreviewMedia, type FeedInput,
} from './native-preview';
import { createLocalMediaStore, migrate, type MediaDeps, type MediaFingerprint, type MediaGeometry, type MediaNative, type MediaProbe } from './local-media';
import { memoryDb } from './test-sqlite';

const asset = (overrides: Partial<AssetMetadata>): AssetMetadata => ({
  id: 'asset-talk', originalName: 'talk.mov', mimeType: 'video/quicktime', duration: 8, width: 1080, height: 1920, fps: 30, hasAudio: true,
  status: 'ready', originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: '', ...overrides,
});

const ASSETS: Record<string, AssetMetadata> = {
  'asset-talk': asset({}),
  'asset-logo': asset({ id: 'asset-logo', originalName: 'logo.png', mimeType: 'image/png', width: 100, height: 160, duration: 0, fps: 0, hasAudio: false }),
  'asset-bed': asset({ id: 'asset-bed', originalName: 'bed.m4a', mimeType: 'audio/mp4', width: 0, height: 0, fps: 0 }),
};

const PROJECT: Project = {
  id: 'p', title: 'Preview', format: '9:16', fps: 30, duration: 4, version: 12,
  tracks: [
    { id: 'video', kind: 'video', clips: [{ id: 'talk', assetId: 'asset-talk', start: 0, in: 0, out: 4 }] },
    { id: 'audio', kind: 'audio', clips: [{ id: 'bed', assetId: 'asset-bed', start: 0, in: 0, out: 4, volume: 0.5 }] },
    {
      id: 'overlays', kind: 'overlay', clips: [
        { id: 'logo', assetId: 'asset-logo', start: 0, in: 0, out: 4, overlay: { x: 0.25, y: 0.2, width: 0.3, rotation: 0 } },
        { id: 'fire', text: '🔥', start: 1, in: 0, out: 2, overlay: { x: 0.5, y: 0.5, width: 0.2, rotation: 15 } },
        { id: 'check', text: 'Nailed it', callout: { variant: 'check' }, start: 1.5, in: 0, out: 2.5, overlay: { x: 0.5, y: 0.75, width: 0.6, rotation: -4 } },
      ],
    },
    { id: 'captions', kind: 'caption', clips: [{ id: 'cap', text: 'how are you doing today', start: 0.5, in: 0, out: 2 }] },
  ],
};

const SIZE = { w: 540, h: 960 };
const clipOf = (project: Project, id: string): Clip => project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!;
const withPlacement = (project: Project, id: string, overlay: OverlayPlacement): Project => ({
  ...project,
  tracks: project.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => (clip.id === id ? { ...clip, overlay } : clip)) })),
});

describe('routing (the nativePreview flag)', () => {
  it('is off unless EXPO_PUBLIC_NATIVE_PREVIEW=1', () => {
    expect(process.env.EXPO_PUBLIC_NATIVE_PREVIEW).toBeUndefined();
    expect(NATIVE_PREVIEW_FLAG).toBe(false);
  });

  it('shows the native preview only on iOS, with the flag and the view, until it falls back', () => {
    const on = { platform: 'ios', flag: true, hasView: true, fellBack: false };
    expect(previewRoute(on)).toBe('native');
    expect(previewRoute({ ...on, platform: 'web' })).toBe('rn');
    expect(previewRoute({ ...on, platform: 'android' })).toBe('rn');
    expect(previewRoute({ ...on, flag: false })).toBe('rn');
    expect(previewRoute({ ...on, hasView: false })).toBe('rn');
    expect(previewRoute({ ...on, fellBack: true })).toBe('rn');
  });
});

describe('the preview plan', () => {
  it('renders at the stage size in pixels, even, capped at 1080 x 1920', () => {
    expect(previewPlanSize('9:16', { width: 270, height: 480 }, 3)).toEqual({ w: 810, h: 1440 });
    // The stage is measured, so it can be a hair off the aspect: the width decides.
    expect(previewPlanSize('9:16', { width: 270.4, height: 481 }, 2)).toEqual({ w: 540, h: 960 });
    expect(previewPlanSize('9:16', { width: 430, height: 765 }, 3)).toEqual({ w: 1080, h: 1920 });
    expect(previewPlanSize('16:9', { width: 1366, height: 768 }, 2)).toEqual({ w: 1920, h: 1080 });
    expect(previewPlanSize('1:1', { width: 400, height: 300 }, 3)).toEqual({ w: 900, h: 900 });
    expect(previewPlanSize('9:16', { width: 0, height: 480 }, 3)).toBeNull();
  });

  it('is a preview target: revision from the project, SDR, no loudness pass', () => {
    const plan = buildPreviewPlan(PROJECT, ASSETS, SIZE, {}, { revision: PROJECT.version, buildSeq: 3 })!;
    expect(plan).toMatchObject({ revision: 12, buildSeq: 3, size: SIZE, color: 'sdr', duration: 4 });
    expect(plan.loudness.targetLufs).toBeNull();
    expect(plan.overlays.map((overlay) => overlay.kind)).toEqual(['image', 'emoji', 'callout']);
    // An asset still loading: no plan yet.
    expect(buildPreviewPlan(PROJECT, { ...ASSETS, 'asset-logo': undefined }, SIZE, {}, { revision: 12, buildSeq: 4 })).toBeNull();
  });

  it('patches a moved, resized or turned overlay exactly as the next full build lays it out', () => {
    const plan = buildPreviewPlan(PROJECT, ASSETS, SIZE, {}, { revision: 12, buildSeq: 1 })!;
    const info = previewAssetInfo(ASSETS, {});
    const placements: Record<string, OverlayPlacement> = {
      logo: { x: 0.61, y: 0.33, width: 0.45, rotation: 30 },
      fire: { x: 0.2, y: 0.8, width: 0.35, rotation: -60 },
      check: { x: 0.5, y: 0.5, width: 0.9, rotation: 0 },
    };
    for (const [id, placement] of Object.entries(placements)) {
      const clip = clipOf(PROJECT, id);
      const patched = patchOverlayPlacement(plan, clip, placement, clip.assetId ? info(clip.assetId) : undefined, 2)!;
      const rebuilt = buildPreviewPlan(withPlacement(PROJECT, id, placement), ASSETS, SIZE, {}, { revision: 12, buildSeq: 2 })!;
      expect(patched, id).toEqual(rebuilt);
      // Only that overlay changed; the rest of the plan is the same objects (cheap to send and to diff).
      expect(patched.video).toBe(plan.video);
      expect(patched.captions).toBe(plan.captions);
      expect(patched.overlays.filter((overlay) => overlay.id !== id)).toEqual(plan.overlays.filter((overlay) => overlay.id !== id));
    }
    expect(patchOverlayPlacement(plan, { ...clipOf(PROJECT, 'logo'), id: 'nope' }, placements.logo!, undefined, 2)).toBeNull();
  });

  it('names every clip asset with its media kind before a plan exists', () => {
    expect(projectAssetRefs(PROJECT, ASSETS)).toEqual([
      { id: 'asset-talk', kind: 'video' }, { id: 'asset-bed', kind: 'audio' }, { id: 'asset-logo', kind: 'image' },
    ]);
    expect(projectAssetRefs(PROJECT, { 'asset-talk': ASSETS['asset-talk'] })).toBeNull();
  });
});

describe('PlanFeeder', () => {
  /** Manual timers: run() fires the pending one. */
  function clock() {
    let pending: (() => void) | undefined;
    return {
      setTimer: (run: () => void) => { pending = run; return 1; },
      clearTimer: () => { pending = undefined; },
      run: () => { const fire = pending; pending = undefined; fire?.(); },
      get armed() { return pending !== undefined; },
    };
  }
  const input = (project: Project, media: Record<string, string> = { 'asset-talk': 'PH-1' }): FeedInput => ({ project, assets: ASSETS, size: SIZE, media, geometry: {} });

  it('sends the first change at once and coalesces a burst into one more send', () => {
    const timers = clock();
    const sent: RenderPlan[] = [];
    const feeder = new PlanFeeder({ send: (plan) => sent.push(plan), ...timers });
    feeder.update(input(PROJECT));
    expect(sent.map((plan) => [plan.revision, plan.buildSeq])).toEqual([[12, 1]]);
    // Stepper taps inside the window: held.
    for (let tap = 1; tap <= 5; tap += 1) feeder.update(input({ ...withPlacement(PROJECT, 'logo', { x: 0.25, y: 0.2 + tap / 100, width: 0.3, rotation: 0 }), version: 12 + tap }));
    expect(sent).toHaveLength(1);
    timers.run();
    expect(sent.map((plan) => [plan.revision, plan.buildSeq])).toEqual([[12, 1], [17, 2]]);
    expect(sent[1]!.overlays[0]!.box.y).toBe(Math.round(0.25 * SIZE.h));
    // A quiet window sends nothing and disarms.
    timers.run();
    expect(sent).toHaveLength(2);
    expect(timers.armed).toBe(false);
    // A rebuild with nothing new for native (the server confirming a painted edit) sends nothing.
    feeder.update(input({ ...withPlacement(PROJECT, 'logo', { x: 0.25, y: 0.25, width: 0.3, rotation: 0 }), version: 18 }));
    expect(sent).toHaveLength(2);
    // New media under the same plan does go (a proxy finished).
    timers.run();
    feeder.update(input({ ...withPlacement(PROJECT, 'logo', { x: 0.25, y: 0.25, width: 0.3, rotation: 0 }), version: 18 }, { 'asset-talk': 'file:///proxy.mov' }));
    expect(sent.map((plan) => plan.buildSeq)).toEqual([1, 2, 3]);
  });

  it('patches drags in place, holds project rebuilds until release, and keeps buildSeq increasing', () => {
    const timers = clock();
    const sent: Array<{ plan: RenderPlan; media: Record<string, string> }> = [];
    const feeder = new PlanFeeder({ send: (plan, media) => sent.push({ plan, media }), ...timers });
    feeder.update(input(PROJECT));
    timers.run();
    const logo = clipOf(PROJECT, 'logo');
    feeder.drag(logo, { ...logo.overlay!, x: 0.3 });
    feeder.drag(logo, { ...logo.overlay!, x: 0.35 });
    // An agent edit lands mid-drag: it waits for the release.
    feeder.update(input({ ...withPlacement(PROJECT, 'fire', { x: 0.1, y: 0.1, width: 0.2, rotation: 0 }), version: 13 }));
    timers.run();
    expect(sent).toHaveLength(3);
    expect(sent[2]!.plan.overlays[0]!.box.x).toBe(Math.round(0.35 * SIZE.w));
    expect(sent[2]!.plan.revision).toBe(12);
    expect(sent[2]!.media).toEqual({ 'asset-talk': 'PH-1' });
    feeder.endDrag(false);
    expect(sent).toHaveLength(4);
    expect(sent[3]!.plan.revision).toBe(13);
    const order = sent.map((item) => item.plan.buildSeq);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('reports a project that cannot become a plan, without spending a buildSeq', () => {
    const timers = clock();
    let unbuildable = 0;
    const sent: RenderPlan[] = [];
    const feeder = new PlanFeeder({ send: (plan) => sent.push(plan), onUnbuildable: () => { unbuildable += 1; }, ...timers });
    feeder.update(input({ ...PROJECT, fps: 29.97 }));
    expect(unbuildable).toBe(1);
    expect(sent).toHaveLength(0);
    timers.run();
    feeder.update(input(PROJECT));
    expect(sent[0]!.buildSeq).toBe(1);
    feeder.dispose();
    feeder.update(input({ ...PROJECT, version: 99 }));
    expect(sent).toHaveLength(1);
  });

  it('turns a handle drag into a stream of box updates and one set_overlay, which the next build agrees with', () => {
    const timers = clock();
    const sent: RenderPlan[] = [];
    const feeder = new PlanFeeder({ send: (plan) => sent.push(plan), ...timers });
    let project = PROJECT;
    feeder.update(input(project));
    timers.run();
    const logo = clipOf(project, 'logo');
    const stage = { width: 270, height: 480 };
    const drag = new HandleDrag({
      clipId: 'logo', start: logo.overlay!, stage, mode: 'move',
      onPreview: (placement) => feeder.drag(logo, placement),
      onEnd: (committed) => feeder.endDrag(committed),
      onCommit: (ops) => {
        // The editor paints the op (same version until the server answers) and the preview rebuilds from it.
        project = applyBatch(project, ops);
        feeder.update(input(project));
      },
    });
    for (let step = 1; step <= 4; step += 1) drag.move(step * 10, step * 20);
    const dragged = sent.slice(1).map((plan) => plan.overlays[0]!.box);
    expect(dragged).toHaveLength(4);
    expect(dragged.map((box) => box.x)).toEqual([1, 2, 3, 4].map((step) => Math.round((0.25 + Math.round(step * 10 / 270 * 1000) / 1000) * SIZE.w)));
    const ops = drag.release(40, 80)!;
    expect(ops).toEqual([{ type: 'set_overlay', params: { clipId: 'logo', overlay: { ...logo.overlay!, x: 0.398, y: 0.367 } } }]);
    timers.run();
    const final = sent.at(-1)!;
    expect(final.overlays[0]!.box).toEqual(dragged.at(-1));
    expect(final.buildSeq).toBe(sent.length);
    expect(sent.map((plan) => plan.buildSeq)).toEqual(sent.map((_, index) => index + 1));
  });
});

describe('a drag that ends without a commit', () => {
  // The reviewer's probe: native must not keep a position the project never got.
  const timersOf = () => {
    let pending: (() => void) | undefined;
    return { setTimer: (run: () => void) => { pending = run; return 1; }, clearTimer: () => { pending = undefined; }, run: () => { const fire = pending; pending = undefined; fire?.(); } };
  };
  const input = (project: Project): FeedInput => ({ project, assets: ASSETS, size: SIZE, media: { 'asset-talk': 'PH-1' }, geometry: {} });
  const fire = clipOf(PROJECT, 'fire');
  const projectX = Math.round(fire.overlay!.x * SIZE.w);

  for (const finish of ['cancel', 'tap-release', 'release-on-start'] as const) {
    it(`sends the project's plan again after a ${finish}`, () => {
      const timers = timersOf();
      const sent: RenderPlan[] = [];
      const commits: unknown[] = [];
      const feeder = new PlanFeeder({ send: (plan) => sent.push(plan), ...timers });
      feeder.update(input(PROJECT));
      timers.run();
      const drag = new HandleDrag({
        clipId: 'fire', start: fire.overlay!, stage: { width: 270, height: 480 }, mode: 'move',
        onPreview: (placement) => feeder.drag(fire, placement),
        onCommit: (ops) => commits.push(ops),
        onEnd: (committed) => feeder.endDrag(committed),
      });
      drag.move(2, 0);
      drag.move(40, 30);
      const box = (plan: RenderPlan): number => plan.overlays.find((overlay) => overlay.id === 'fire')!.box.x;
      expect(box(sent.at(-1)!)).not.toBe(projectX);
      if (finish === 'cancel') drag.cancel();
      else if (finish === 'tap-release') { drag.move(2, 0); drag.release(2, 0); }
      else { drag.move(0, 0); drag.release(0, 0); }
      expect(commits).toEqual([]);
      // At once, not after a window: nothing is coming to replace the dragged position.
      expect(box(sent.at(-1)!)).toBe(projectX);
      const count = sent.length;
      timers.run();
      feeder.update(input(PROJECT));
      timers.run();
      expect(sent).toHaveLength(count);
      expect(sent.map((plan) => plan.buildSeq)).toEqual(sent.map((_, index) => index + 1));
    });
  }

  it('lets a commit painted inside the window win over the pre-drag project', () => {
    const timers = timersOf();
    const sent: RenderPlan[] = [];
    const feeder = new PlanFeeder({ send: (plan) => sent.push(plan), ...timers });
    feeder.update(input(PROJECT));
    timers.run();
    let project = PROJECT;
    const drag = new HandleDrag({
      clipId: 'fire', start: fire.overlay!, stage: { width: 270, height: 480 }, mode: 'move',
      onPreview: (placement) => feeder.drag(fire, placement),
      // The editor's paint lands after the release (a React render later), inside the window.
      onCommit: (ops) => { project = applyBatch(project, ops); },
      onEnd: (committed) => feeder.endDrag(committed),
    });
    drag.move(54, 0);
    drag.release(54, 0);
    const dragged = sent.at(-1)!.overlays.find((overlay) => overlay.id === 'fire')!.box.x;
    feeder.update(input(project));
    timers.run();
    const final = sent.at(-1)!.overlays.find((overlay) => overlay.id === 'fire')!.box.x;
    expect(final).toBe(dragged);
    // Never back to the old position in between.
    expect(sent.slice(-2).map((plan) => plan.overlays.find((overlay) => overlay.id === 'fire')!.box.x)).not.toContain(projectX);
  });
});

describe('native failures (MediaRecovery)', () => {
  function rig(options: { timeoutMs?: number; minIntervalMs?: number } = {}) {
    let now = 0;
    let pending: (() => void) | undefined;
    const calls: string[] = [];
    const recovery = new MediaRecovery({
      reresolve: () => calls.push('reresolve'),
      fallback: (reason) => calls.push(`fallback: ${reason}`),
      now: () => now,
      setTimer: (run) => { pending = run; return 1; },
      clearTimer: () => { pending = undefined; },
      ...options,
    });
    return {
      recovery, calls,
      advance: (ms: number) => { now += ms; },
      fire: () => { const run = pending; pending = undefined; run?.(); },
      get armed() { return pending !== undefined; },
    };
  }
  const expired = { message: 'The operation could not be completed', code: 'mediaExpired' };

  it('resolves expired server media again instead of falling back, and is done once a plan lands', () => {
    const r = rig();
    r.recovery.onError(expired, true);
    expect(r.calls).toEqual(['reresolve']);
    expect(r.recovery.isRecovering).toBe(true);
    expect(r.armed).toBe(true);
    // A plan that failed to apply doesn't end it; the re-resolved one does (native retries on it).
    r.recovery.onPlan('failed');
    expect(r.recovery.isRecovering).toBe(true);
    r.recovery.onPlan('rebuild');
    expect(r.recovery.isRecovering).toBe(false);
    expect(r.armed).toBe(false);
    r.fire();
    expect(r.calls).toEqual(['reresolve']);
  });

  it('falls back when the retry fails too (a plain error), or its plan never lands', () => {
    const failed = rig();
    failed.recovery.onError(expired, true);
    failed.recovery.onPlan('rebuild');
    failed.recovery.onError({ message: 'Playback failed' }, true);
    expect(failed.calls).toEqual(['reresolve', 'fallback: native: Playback failed']);

    const silent = rig();
    silent.recovery.onError(expired, true);
    silent.fire();
    expect(silent.calls).toEqual(['reresolve', 'fallback: native: media expired, and no plan with new media landed (The operation could not be completed)']);
    expect(silent.recovery.isRecovering).toBe(false);
  });

  it('falls back on any other error, without server media, or on an expiry soon after a recovery', () => {
    const other = rig();
    other.recovery.onError({ message: 'compositor' }, true);
    expect(other.calls).toEqual(['fallback: native: compositor']);

    const local = rig();
    local.recovery.onError(expired, false);
    expect(local.calls).toEqual(['fallback: native: The operation could not be completed']);

    // Recovered, then expired again within the interval: no loop.
    const again = rig({ minIntervalMs: 30_000 });
    again.recovery.onError(expired, true);
    again.recovery.onPlan('rebuild');
    again.advance(10_000);
    again.recovery.onError(expired, true);
    expect(again.calls).toEqual(['reresolve', 'fallback: native: The operation could not be completed']);

    // An hour later (the next background trip) it recovers again.
    const later = rig({ minIntervalMs: 30_000 });
    later.recovery.onError(expired, true);
    later.recovery.onPlan('update');
    later.advance(3_600_000);
    later.recovery.onError(expired, true);
    expect(later.calls).toEqual(['reresolve', 'reresolve']);
  });

  it('sends the re-resolved media to native even when its URLs did not change (forced)', () => {
    let pending: (() => void) | undefined;
    const sent: Array<{ plan: RenderPlan; media: Record<string, string> }> = [];
    const feeder = new PlanFeeder({
      send: (plan, media) => sent.push({ plan, media }),
      setTimer: (run) => { pending = run; return 1; },
      clearTimer: () => { pending = undefined; },
    });
    const server = { 'asset-talk': 'https://api.test/assets/asset-talk/proxy.mp4?k=t1', 'asset-logo': 'PH-logo', 'asset-bed': 'PH-bed' };
    const feed = (media: Record<string, string>): FeedInput => ({ project: PROJECT, assets: ASSETS, size: SIZE, media, geometry: {} });
    feeder.update(feed(server));
    pending?.();
    expect(sent).toHaveLength(1);
    // The same media again: nothing for native.
    feeder.update(feed({ ...server }));
    pending?.();
    expect(sent).toHaveLength(1);
    // Native asked for media and the token had not changed: the same URLs go anyway, as a newer plan.
    feeder.update(feed({ ...server }), true);
    pending?.();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.plan.buildSeq).toBeGreaterThan(sent[0]!.plan.buildSeq);
    expect(sent[1]!.media).toEqual(server);
    // A refreshed token goes without forcing (new URLs).
    feeder.update(feed({ ...server, 'asset-talk': 'https://api.test/assets/asset-talk/proxy.mp4?k=t2' }));
    pending?.();
    expect(sent).toHaveLength(3);
  });
});

describe('logging', () => {
  it('never logs a media token', () => {
    expect(redactMediaToken('setPlan: could not open https://api.test/assets/a/proxy.mp4?k=eyJhbGciOi.x.y failed'))
      .toBe('setPlan: could not open https://api.test/assets/a/proxy.mp4?k=[redacted] failed');
    expect(redactMediaToken('https://h/x?a=1&k=abc&b=2')).toBe('https://h/x?a=1&k=[redacted]&b=2');
    expect(urlOrigin('https://api.editify.app/v1')).toBe('https://api.editify.app');
    expect(urlOrigin('http://192.168.1.4:3001')).toBe('http://192.168.1.4:3001');
    expect(urlOrigin('file:///x')).toBeNull();
  });

  it('keeps the last plan in a store only its subscribers hear', () => {
    const store = createPlanStore();
    let heard = 0;
    const stop = store.subscribe(() => { heard += 1; });
    const plan = buildPreviewPlan(PROJECT, ASSETS, SIZE, {}, { revision: 1, buildSeq: 1 })!;
    store.set(plan);
    expect(store.get()).toBe(plan);
    stop();
    store.set(plan);
    expect(heard).toBe(1);
  });
});

describe('the clock', () => {
  it('follows native time only while both sides are playing', () => {
    expect(followsNativeTime({ playing: true }, true)).toBe(true);
    // A seek landing while paused must not pull the user's playhead back.
    expect(followsNativeTime({ playing: false }, false)).toBe(false);
    expect(followsNativeTime({ playing: true }, false)).toBe(false);
    expect(followsNativeTime({ playing: false }, true)).toBe(false);
  });

  it('treats any playhead native didn\'t report as a user seek', () => {
    expect(isExternalSeek(1.5, undefined)).toBe(true);
    expect(isExternalSeek(1.5, 1.5)).toBe(false);
    expect(isExternalSeek(1.6, 1.5)).toBe(true);
  });
});

// ─── Media ───

const ROOT = 'file:///container/Library/Application%20Support/Editify/';
const PRINT: MediaFingerprint = { duration: 8, bytes: 4_000_000, audio: 'e1:9f3c5a7e9f3c5a7e9f3c5a7e9f3c5a7e', color: 'sdr' };
const open: Array<{ close(): void }> = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

async function registry(probes: Record<string, MediaProbe>, files: string[], geometries: Record<string, MediaGeometry>, ensured: string[]): Promise<MediaDeps> {
  const db = memoryDb();
  open.push(db);
  await migrate(db);
  const existing = new Set(files.map((path) => `${ROOT}${path}`));
  const native: MediaNative = {
    probe: async (ref) => probes[ref] ?? { status: 'missing', access: 'all' },
    download: async () => ({ status: 'icloud' }),
    cancelDownload: () => undefined,
    photosAccess: () => 'all',
    requestPhotosAccess: async () => 'all',
    mediaRoot: () => ROOT,
    durableCopy: async () => { throw new Error('unused'); },
    availableBytes: () => 1e12,
    mediaFiles: () => [],
    removeMedia: () => undefined,
    fileExists: (uri) => existing.has(uri),
    fileSize: () => 1000,
    removeFile: () => undefined,
    geometry: async (ref) => geometries[ref] ?? null,
    ensureProxy: async (assetId) => { ensured.push(assetId); },
    touchProxy: () => true,
    removeProxy: () => undefined,
    analyze: async () => undefined,
  };
  return { store: createLocalMediaStore(db), native };
}

describe('preview media', () => {
  const server = { proxy: (id: string) => `https://api.test/assets/${id}/proxy.mp4?k=t`, original: (id: string) => `https://api.test/assets/${id}/original?k=t` };

  it('plays the proxy when ready, the original until then, and the server copy for anything not on this iPhone', async () => {
    const ensured: string[] = [];
    const deps = await registry(
      { 'PH-talk': { status: 'ok', fingerprint: PRINT } },
      ['media/logo.png', 'proxies/broll.mov', 'media/broll.mov'],
      { 'PH-talk': { width: 1920, height: 1080, rotation: 90 }, [`${ROOT}media/logo.png`]: { width: 100, height: 160, rotation: 0 } },
      ensured,
    );
    await deps.store.record({ assetId: 'asset-talk', phLocalId: 'PH-talk', fingerprint: PRINT });
    await deps.store.record({ assetId: 'asset-logo', fileUri: 'media/logo.png', fileBytes: 10 });
    await deps.store.record({ assetId: 'asset-broll', fileUri: 'media/broll.mov', fileBytes: 10 });
    await deps.store.setProxy('asset-broll', 'ready', 'proxies/broll.mov');
    const refs = [
      { id: 'asset-talk', kind: 'video' }, { id: 'asset-broll', kind: 'video' }, { id: 'asset-logo', kind: 'image' },
      { id: 'asset-bed', kind: 'audio' }, { id: 'asset-old', kind: 'video' },
    ] as const;
    const resolved = await resolvePreviewMedia(refs, deps, server);
    expect(resolved.media).toEqual({
      'asset-talk': 'PH-talk', // its proxy is queued; the original plays meanwhile
      'asset-broll': `${ROOT}proxies/broll.mov`,
      'asset-logo': `${ROOT}media/logo.png`,
      'asset-bed': 'https://api.test/assets/asset-bed/original?k=t',
      'asset-old': 'https://api.test/assets/asset-old/proxy.mp4?k=t',
    });
    expect(ensured).toEqual(['asset-talk']);
    expect(resolved.local).toEqual(['asset-talk', 'asset-broll', 'asset-logo']);
    expect(resolved.remote).toEqual(['asset-bed', 'asset-old']);
    // The layout uses the original's stored size and rotation.
    expect(resolved.geometry).toEqual({ 'asset-talk': { width: 1920, height: 1080, rotation: 90 }, 'asset-logo': { width: 100, height: 160, rotation: 0 } });
  });

  it('plays everything from the server without a registry', () => {
    expect(serverPreviewMedia([{ id: 'a', kind: 'video' }, { id: 'b', kind: 'image' }], server)).toEqual({
      media: { a: 'https://api.test/assets/a/proxy.mp4?k=t', b: 'https://api.test/assets/b/original?k=t' }, geometry: {}, local: [], remote: ['a', 'b'],
    });
  });
});
