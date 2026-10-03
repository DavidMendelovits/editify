import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetMetadata, Project, RenderPlan } from '@editify/shared';
import type { ExportProjectOptions, ExportStateEvent } from '../../modules/editify-engine';
import {
  assetInfoOf, buildExportPlan, DEVICE_EXPORT_RESOLUTIONS, exportOnDevice, exportReducer, exportStateLabel, isTerminal, missingClipsLine,
  planAssetRefs, routeExport, serverRouteLine, STARTING, type DeviceExportView, type ExportNative, type GeometryMap,
} from './device-export';
import {
  createLocalMediaStore, isLeased, migrate, type MediaDeps, type MediaFingerprint, type MediaGeometry, type MediaNative, type MediaProbe,
} from './local-media';
import { memoryDb } from './test-sqlite';

const ROOT = 'file:///container/Library/Application%20Support/Editify/';
const PRINT: MediaFingerprint = { duration: 8, bytes: 4_000_000, audio: 'e1:9f3c5a7e9f3c5a7e9f3c5a7e9f3c5a7e', color: 'sdr' };

function fixture(name: string): RenderPlan {
  const path = decodeURIComponent(new URL(`../../../../packages/shared/fixtures/render-plans/${name}.json`, import.meta.url).pathname);
  return (JSON.parse(readFileSync(path, 'utf8')) as { plan: RenderPlan }).plan;
}

const open: Array<{ close(): void }> = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

/** A registry where `files` exist under the media root and `probes` answer PHAsset ids. */
async function registry(probes: Record<string, MediaProbe> = {}, files: string[] = [], geometries: Record<string, MediaGeometry> = {}, geometryCalls: string[] = []): Promise<MediaDeps> {
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
    geometry: async (ref) => { geometryCalls.push(ref); return geometries[ref] ?? null; },
    ensureProxy: async () => undefined,
    touchProxy: () => false,
    removeProxy: () => undefined,
    analyze: async () => undefined,
  };
  return { store: createLocalMediaStore(db), native };
}

/** crossfade.json uses asset-a and asset-b: a as an app copy, b as a Photos original. */
async function bothLocal(): Promise<MediaDeps> {
  const deps = await registry({ 'PH-b': { status: 'ok', fingerprint: PRINT } }, ['media/a.mov']);
  await deps.store.record({ assetId: 'asset-a', fileUri: 'media/a.mov', fileBytes: 1000 });
  await deps.store.record({ assetId: 'asset-b', phLocalId: 'PH-b', fingerprint: PRINT });
  return deps;
}

const names: Record<string, string> = { 'asset-a': 'Intro', 'asset-b': 'Interview', 'asset-talk': 'Talk', 'asset-music': 'Bed', 'asset-voice': 'Voiceover' };
const nameOf = (id: string): string => names[id] ?? id;

describe('the export plan', () => {
  it('lists each plan asset once, video, overlays, then audio', () => {
    expect(planAssetRefs(fixture('crossfade'))).toEqual([{ id: 'asset-a', kind: 'video' }, { id: 'asset-b', kind: 'video' }]);
    expect(planAssetRefs(fixture('audio-duck-loudness')).map((ref) => ref.id)).toEqual(['asset-talk', 'asset-music', 'asset-voice']);
    expect(planAssetRefs(fixture('overlays')).map((ref) => ref.kind)).toContain('image');
  });

  const asset = (overrides: Partial<AssetMetadata>): AssetMetadata => ({
    id: 'asset-talk', originalName: 'talk.mov', mimeType: 'video/quicktime', duration: 8, width: 1080, height: 1920, fps: 30, hasAudio: true,
    status: 'ready', originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: '', ...overrides,
  });

  it('describes assets for the builder from the server records', () => {
    expect(assetInfoOf(asset({}))).toEqual({ kind: 'video', width: 1080, height: 1920, duration: 8, hasAudio: true, animated: false, fps: 30 });
    expect(assetInfoOf(asset({ mimeType: 'image/gif', originalName: 'x.gif', duration: 2, fps: 0 }))).toEqual({ kind: 'image', width: 1080, height: 1920, duration: 0, hasAudio: true, animated: true });
    expect(assetInfoOf(asset({ mimeType: 'audio/mp4', originalName: 'bed.m4a' })).kind).toBe('audio');
  });

  const project: Project = {
    id: 'p', title: 'Plan', format: '9:16', fps: 30, duration: 3, version: 7,
    tracks: [{ id: 'v', kind: 'video', clips: [{ id: 'main', assetId: 'asset-talk', start: 0, in: 0, out: 3 }] }],
  };

  it('builds with the plan owning size, colour and loudness', () => {
    const sdr = buildExportPlan(project, [asset({})], { resolution: '1080p', hdr: 'sdr', loudness: 'normalize' })!;
    expect(sdr).toMatchObject({ revision: 7, size: { w: 1080, h: 1920 }, color: 'sdr', duration: 3 });
    expect(sdr.loudness.targetLufs).toBe(-16);
    const hdr = buildExportPlan(project, [asset({})], { resolution: '4k', hdr: 'hdr', loudness: 'off' })!;
    expect(hdr).toMatchObject({ size: { w: 2160, h: 3840 }, color: 'hlg' });
    expect(hdr.loudness.targetLufs).toBeNull();
    expect(hdr.buildSeq).toBeGreaterThan(sdr.buildSeq);
  });

  it('lays a rotated phone clip out upright from the device geometry, not the server record', () => {
    // The server keeps the coded size (1920 x 1080) and no rotation; the phone knows it is turned 90 degrees.
    const landscape = asset({ id: 'asset-broll', width: 1920, height: 1080 });
    expect(assetInfoOf(landscape, { width: 1920, height: 1080, rotation: 90 })).toMatchObject({ width: 1920, height: 1080, rotation: 90 });
    expect(assetInfoOf(landscape, { width: 1920, height: 1080, rotation: 0 })).not.toHaveProperty('rotation');
    const withBroll: Project = {
      ...project,
      tracks: [...project.tracks, { id: 'o', kind: 'overlay', clips: [{ id: 'b', assetId: 'asset-broll', start: 0, in: 0, out: 2, overlay: { x: 0.5, y: 0.5, width: 0.5, rotation: 0 } }] }],
    };
    const choices = { resolution: '1080p', hdr: 'sdr', loudness: 'normalize' } as const;
    const box = (geometry: GeometryMap) => buildExportPlan(withBroll, [asset({}), landscape], choices, geometry)!.overlays.find((item) => item.kind === 'broll')!.box;
    const sideways = box({});
    const upright = box({ 'asset-broll': { width: 1920, height: 1080, rotation: 90 } });
    expect(sideways.h / sideways.w).toBeCloseTo(1080 / 1920, 2);
    expect(upright.h / upright.w).toBeCloseTo(1920 / 1080, 2);
  });

  it('answers null (the server path) when the project cannot become a plan', () => {
    expect(buildExportPlan(project, [], { resolution: '1080p', hdr: 'sdr', loudness: 'normalize' })).toBeNull();
  });
});

describe('routing', () => {
  it('renders on the device when every clip resolves locally', async () => {
    const route = await routeExport(fixture('crossfade'), await bothLocal(), nameOf);
    expect(route).toEqual({ kind: 'device', media: { 'asset-a': `${ROOT}media/a.mov`, 'asset-b': 'PH-b' }, geometry: {} });
  });

  it('goes to the server naming every clip that is not on this iPhone', async () => {
    const deps = await registry({ 'PH-b': { status: 'icloud' } });
    await deps.store.record({ assetId: 'asset-b', phLocalId: 'PH-b', fingerprint: PRINT });
    const route = await routeExport(fixture('crossfade'), deps, nameOf);
    expect(route).toEqual({
      kind: 'server', why: 'missing',
      missing: [{ assetId: 'asset-a', name: 'Intro', reason: 'not on this iPhone' }, { assetId: 'asset-b', name: 'Interview', reason: 'in iCloud' }],
    });
    expect(missingClipsLine(route)).toBe("Renders on the server: Intro and Interview aren't on this iPhone.");
  });

  it('treats a clip changed in Photos as missing', async () => {
    const deps = await registry({ 'PH-b': { status: 'ok', fingerprint: { ...PRINT, duration: 3 } } }, ['media/a.mov']);
    await deps.store.record({ assetId: 'asset-a', fileUri: 'media/a.mov' });
    await deps.store.record({ assetId: 'asset-b', phLocalId: 'PH-b', fingerprint: PRINT });
    const route = await routeExport(fixture('crossfade'), deps, nameOf);
    expect(route).toMatchObject({ kind: 'server', missing: [{ assetId: 'asset-b', reason: 'changed in Photos' }] });
    expect(missingClipsLine(route)).toBe("Renders on the server: Interview isn't on this iPhone.");
  });

  it('reads each local picture asset\'s geometry once and keeps it in the registry', async () => {
    const calls: string[] = [];
    const deps = await registry({ 'PH-b': { status: 'ok', fingerprint: { ...PRINT, geometry: { width: 1920, height: 1080, rotation: 90 } } } },
      ['media/a.mov'], { [`${ROOT}media/a.mov`]: { width: 1080, height: 1920, rotation: 0 } }, calls);
    await deps.store.record({ assetId: 'asset-a', fileUri: 'media/a.mov' });
    await deps.store.record({ assetId: 'asset-b', phLocalId: 'PH-b', fingerprint: PRINT });
    const route = await routeExport(fixture('crossfade'), deps, nameOf);
    expect(route).toMatchObject({ kind: 'device', geometry: { 'asset-a': { width: 1080, height: 1920, rotation: 0 }, 'asset-b': { width: 1920, height: 1080, rotation: 90 } } });
    // The app copy was read by the engine, the Photos original came with its probe; both are cached now.
    expect(calls).toEqual([`${ROOT}media/a.mov`]);
    expect((await deps.store.lookup('asset-b'))?.geometry).toEqual({ width: 1920, height: 1080, rotation: 90 });
    await routeExport(fixture('crossfade'), deps, nameOf);
    expect(calls).toHaveLength(1);
  });

  it('sends 4K to the server for now, with its own line', async () => {
    expect(DEVICE_EXPORT_RESOLUTIONS.has('4k')).toBe(false);
    expect(DEVICE_EXPORT_RESOLUTIONS.has('1080p')).toBe(true);
    const route = await routeExport(fixture('crossfade'), await bothLocal(), nameOf, '4k');
    expect(route).toEqual({ kind: 'server', why: 'resolution', missing: [] });
    expect(serverRouteLine(route)).toBe('4K exports render on the server for now.');
    expect((await routeExport(fixture('crossfade'), await bothLocal(), nameOf, '720p')).kind).toBe('device');
  });

  it('goes to the server without the engine or without a plan, with no clip line', async () => {
    const noEngine = await routeExport(fixture('crossfade'), null, nameOf);
    expect(noEngine).toEqual({ kind: 'server', why: 'no-engine', missing: [] });
    expect(missingClipsLine(noEngine)).toBeNull();
    expect(await routeExport(null, await bothLocal(), nameOf)).toEqual({ kind: 'server', why: 'plan', missing: [] });
  });

  it('shortens a long list of missing clips', () => {
    const missing = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ assetId: name, name, reason: 'not on this iPhone' }));
    expect(missingClipsLine({ kind: 'server', why: 'missing', missing })).toBe("Renders on the server: A, B and 3 more aren't on this iPhone.");
    expect(missingClipsLine({ kind: 'server', why: 'missing', missing: missing.slice(0, 3) })).toBe("Renders on the server: A, B and C aren't on this iPhone.");
  });
});

describe('exportReducer', () => {
  const event = (state: ExportStateEvent['state'], progress: number, extra: Partial<ExportStateEvent> = {}): ExportStateEvent => ({ id: 'x', state, progress, ...extra });
  const fold = (events: ExportStateEvent[], from: DeviceExportView = STARTING): DeviceExportView => events.reduce(exportReducer, from);

  it('follows the states with per-state progress that never moves back', () => {
    const view = fold([event('resolving', 0), event('measuring', 0.5), event('writing', 0.4), event('writing', 0.3), event('writing', 0.6)]);
    expect(view).toMatchObject({ id: 'x', state: 'writing', progress: 0.6 });
    expect(exportStateLabel(view)).toBe('Rendering 60%');
  });

  it('keeps the mode and the keep-open notice', () => {
    const view = fold([event('queued', 0, { mode: 'background' }), event('resolving', 0, { mode: 'foreground', notice: 'Keep Editify open until the export finishes.' }), event('writing', 0.1)]);
    expect(view).toMatchObject({ mode: 'foreground', notice: 'Keep Editify open until the export finishes.' });
    expect(exportStateLabel(fold([event('queued', 0)]))).toBe('Waiting to start');
  });

  it('records the result and drops anything after a terminal state', () => {
    const stats = { seconds: 2, xRealtime: 3 } as NonNullable<ExportStateEvent['stats']>;
    const done = fold([event('writing', 0.9), event('saving', 0), event('done', 1, { fileUri: 'file:///tmp/x.mp4', savedToPhotos: true, stats }), event('failed', 0, { error: 'late' })]);
    expect(done).toMatchObject({ state: 'done', progress: 1, fileUri: 'file:///tmp/x.mp4', savedToPhotos: true, stats });
    expect(exportStateLabel(done)).toBe('Saved to Photos');
    const failed = fold([event('writing', 0.2), event('failed', 0, { error: 'Not enough space' }), event('writing', 0.5)]);
    expect(failed).toMatchObject({ state: 'failed', error: 'Not enough space' });
    expect(fold([event('cancelled', 0), event('done', 1)]).state).toBe('cancelled');
    expect(isTerminal('saving')).toBe(false);
  });

  it('ignores events for another export and clamps odd progress', () => {
    const view = fold([event('writing', 0.5)]);
    expect(exportReducer(view, { id: 'other', state: 'failed', progress: 0, error: 'no' })).toBe(view);
    expect(fold([event('writing', Number.NaN)]).progress).toBe(0);
    expect(fold([event('writing', 7)]).progress).toBe(1);
  });
});

/** An engine that answers an id, then replays `script` (or waits for cancelExport). */
function fakeEngine(script: (id: string, emit: (event: ExportStateEvent) => void) => void, options: { reject?: string; earlyEvents?: boolean } = {}) {
  const listeners = new Set<(event: ExportStateEvent) => void>();
  const calls: Array<{ planJson: string; options: ExportProjectOptions }> = [];
  const cancelled: string[] = [];
  const leasedDuringRun: boolean[] = [];
  const emit = (event: ExportStateEvent): void => { for (const listener of [...listeners]) listener(event); };
  let deps: MediaDeps | undefined;
  const native: ExportNative = {
    exportProject: async (planJson, exportOptions) => {
      calls.push({ planJson, options: exportOptions });
      if (deps) leasedDuringRun.push(isLeased(deps, 'asset-a') && isLeased(deps, 'asset-b'));
      if (options.reject) throw new Error(options.reject);
      const id = 'exp-1';
      if (options.earlyEvents) emit({ id, state: 'resolving', progress: 0 });
      setTimeout(() => script(id, emit), 0);
      return id;
    },
    cancelExport: (id) => {
      cancelled.push(id);
      setTimeout(() => emit({ id, state: 'cancelled', progress: 0 }), 0);
    },
    addListener: (_event, listener) => {
      listeners.add(listener);
      return { remove: () => { listeners.delete(listener); } };
    },
  };
  return { native, calls, cancelled, leasedDuringRun, listeners, attach: (value: MediaDeps) => { deps = value; } };
}

describe('exportOnDevice', () => {
  it('leases the media for the whole run, exports with the resolved refs, and releases after done', async () => {
    const deps = await bothLocal();
    const engine = fakeEngine((id, emit) => {
      emit({ id: 'someone-else', state: 'failed', progress: 0 });
      emit({ id, state: 'writing', progress: 0.5 });
      emit({ id, state: 'done', progress: 1, fileUri: 'file:///tmp/out.mp4', savedToPhotos: true });
    }, { earlyEvents: true });
    engine.attach(deps);
    const updates: DeviceExportView[] = [];
    const outcome = await exportOnDevice({ build: () => fixture('crossfade'), deps, native: engine.native, nameOf, onUpdate: (view) => updates.push(view) });
    expect(outcome).toMatchObject({ kind: 'device', view: { id: 'exp-1', state: 'done', fileUri: 'file:///tmp/out.mp4', savedToPhotos: true } });
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.options).toEqual({ media: { 'asset-a': `${ROOT}media/a.mov`, 'asset-b': 'PH-b' }, destination: 'photos' });
    expect(JSON.parse(engine.calls[0]!.planJson)).toEqual(fixture('crossfade'));
    expect(engine.leasedDuringRun).toEqual([true]);
    expect(isLeased(deps, 'asset-a') || isLeased(deps, 'asset-b')).toBe(false);
    // The early event (before the id came back) was applied; the stranger's was not.
    expect(updates.map((view) => view.state)).toEqual(['starting', 'resolving', 'writing', 'done']);
    expect(engine.listeners.size).toBe(0);
  });

  it('rebuilds the plan with the geometry it found before exporting', async () => {
    const deps = await registry({ 'PH-b': { status: 'ok', fingerprint: { ...PRINT, geometry: { width: 1920, height: 1080, rotation: 90 } } } }, ['media/a.mov']);
    await deps.store.record({ assetId: 'asset-a', fileUri: 'media/a.mov' });
    await deps.store.record({ assetId: 'asset-b', phLocalId: 'PH-b', fingerprint: PRINT });
    const engine = fakeEngine((id, emit) => emit({ id, state: 'done', progress: 1 }));
    const seen: GeometryMap[] = [];
    const rebuilt = { ...fixture('crossfade'), buildSeq: 99 };
    await exportOnDevice({
      build: (geometry) => { seen.push(geometry); return Object.keys(geometry).length > 0 ? rebuilt : fixture('crossfade'); },
      deps, native: engine.native, nameOf, onUpdate: () => undefined,
    });
    expect(seen).toEqual([{}, { 'asset-b': { width: 1920, height: 1080, rotation: 90 } }]);
    expect(JSON.parse(engine.calls[0]!.planJson).buildSeq).toBe(99);
  });

  it('never leases or starts for 4K or a project that cannot become a plan', async () => {
    const deps = await bothLocal();
    const engine = fakeEngine(() => undefined);
    const fourK = await exportOnDevice({ build: () => fixture('crossfade'), resolution: '4k', deps, native: engine.native, nameOf, onUpdate: () => undefined });
    expect(fourK).toEqual({ kind: 'server', route: { kind: 'server', why: 'resolution', missing: [] } });
    const none = await exportOnDevice({ build: () => null, deps, native: engine.native, nameOf, onUpdate: () => undefined });
    expect(none).toEqual({ kind: 'server', route: { kind: 'server', why: 'plan', missing: [] } });
    expect(engine.calls).toHaveLength(0);
    expect(isLeased(deps, 'asset-a')).toBe(false);
  });

  it('releases the lease when the export fails', async () => {
    const deps = await bothLocal();
    const engine = fakeEngine((id, emit) => emit({ id, state: 'failed', progress: 0, error: 'Not enough space' }));
    const outcome = await exportOnDevice({ build: () => fixture('crossfade'), deps, native: engine.native, nameOf, onUpdate: () => undefined });
    expect(outcome).toMatchObject({ kind: 'device', view: { state: 'failed', error: 'Not enough space' } });
    expect(isLeased(deps, 'asset-a')).toBe(false);
  });

  it('releases the lease when the engine refuses to start', async () => {
    const deps = await bothLocal();
    const engine = fakeEngine(() => undefined, { reject: 'Another export is running' });
    const outcome = await exportOnDevice({ build: () => fixture('crossfade'), deps, native: engine.native, nameOf, onUpdate: () => undefined });
    expect(outcome).toMatchObject({ kind: 'device', view: { state: 'failed', error: 'Another export is running' } });
    expect(isLeased(deps, 'asset-a')).toBe(false);
    expect(engine.listeners.size).toBe(0);
  });

  it('cancels through the abort signal and releases the lease', async () => {
    const deps = await bothLocal();
    const controller = new AbortController();
    const engine = fakeEngine((id, emit) => {
      emit({ id, state: 'writing', progress: 0.2 });
      controller.abort();
    });
    engine.attach(deps);
    const outcome = await exportOnDevice({ build: () => fixture('crossfade'), deps, native: engine.native, nameOf, onUpdate: () => undefined, signal: controller.signal });
    expect(engine.cancelled).toEqual(['exp-1']);
    expect(outcome).toMatchObject({ kind: 'device', view: { state: 'cancelled' } });
    expect(isLeased(deps, 'asset-b')).toBe(false);
  });

  it('cancels at once when aborted before the engine answered the id', async () => {
    const deps = await bothLocal();
    const controller = new AbortController();
    controller.abort();
    const engine = fakeEngine(() => undefined);
    const outcome = await exportOnDevice({ build: () => fixture('crossfade'), deps, native: engine.native, nameOf, onUpdate: () => undefined, signal: controller.signal });
    expect(engine.cancelled).toEqual(['exp-1']);
    expect(outcome).toMatchObject({ kind: 'device', view: { state: 'cancelled' } });
  });

  it('answers the server route without touching the engine when a clip is missing, and releases the lease', async () => {
    const deps = await registry({}, ['media/a.mov']);
    await deps.store.record({ assetId: 'asset-a', fileUri: 'media/a.mov' });
    const engine = fakeEngine(() => undefined);
    const outcome = await exportOnDevice({ build: () => fixture('crossfade'), deps, native: engine.native, nameOf, onUpdate: () => undefined });
    expect(outcome).toEqual({ kind: 'server', route: { kind: 'server', why: 'missing', missing: [{ assetId: 'asset-b', name: 'Interview', reason: 'not on this iPhone' }] } });
    expect(engine.calls).toHaveLength(0);
    expect(isLeased(deps, 'asset-a')).toBe(false);
  });
});
