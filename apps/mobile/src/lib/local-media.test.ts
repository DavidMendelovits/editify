import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPY_FREE_RESERVE, LOCAL_MEDIA_MIGRATIONS, ORPHAN_AGE_MS, isLeased, leaseMedia, PHOTOS_ASKED_KEY, analyzeMedia, applyProxyEvent, askForPhotosAccessOnce, copyBudget,
  createLocalMediaStore, downloadMedia, enforceCopyBudget, envelopeDistance, fingerprintsMatch, forgetMedia, maintainMedia,
  mediaKindOf, migrate, releaseProjectMedia, resolveMedia, setCopyBudget, stageImport, sweepOrphanCopies,
  type MediaDeps, type MediaFingerprint, type MediaNative, type MediaProbe, type PhotosAccess, type SqlDb,
} from './local-media';
import { memoryDb } from './test-sqlite';

const ROOT = 'file:///container/Library/Application%20Support/Editify/';
const HASH = 'e1:9f3c5a7e9f3c5a7e9f3c5a7e9f3c5a7e';
const PRINT: MediaFingerprint = { duration: 12.5, bytes: 4_000_000, audio: HASH, color: 'hlg' };

const GB = 1024 ** 3;

interface Fake {
  native: MediaNative;
  /** URI → size and modification time. */
  files: Map<string, { bytes: number; modified: number }>;
  available: { value: number };
  asked: { value: number };
  removedProxies: string[];
  analyzed: Array<[string, string]>;
  probes: Map<string, MediaProbe>;
  downloads: Map<string, MediaProbe | Error>;
  access: { value: PhotosAccess };
  ensured: Array<[string, string]>;
  touched: string[];
  cancelled: string[];
  copies: string[];
  failCopy: { value: boolean };
}

function fakeNative(): Fake {
  const fake: Omit<Fake, 'native'> = {
    files: new Map(), available: { value: 100 * GB }, asked: { value: 0 }, removedProxies: [], analyzed: [],
    probes: new Map(), downloads: new Map(), access: { value: 'all' },
    ensured: [], touched: [], cancelled: [], copies: [], failCopy: { value: false },
  };
  let copyCount = 0;
  const pendingDownloads = new Map<string, (error: Error) => void>();
  const native: MediaNative = {
    probe: async (ref) => fake.probes.get(ref) ?? { status: 'missing', access: fake.access.value },
    download: async (ref, requestId, onProgress) => {
      const outcome = fake.downloads.get(ref);
      if (outcome === undefined) {
        // Never finishes on its own: only a cancel ends it.
        return await new Promise<MediaProbe>((_resolve, reject) => { pendingDownloads.set(requestId, reject); });
      }
      onProgress?.(0.5);
      onProgress?.(1);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    cancelDownload: (requestId) => {
      fake.cancelled.push(requestId);
      pendingDownloads.get(requestId)?.(new Error('cancelled'));
    },
    photosAccess: () => fake.access.value,
    requestPhotosAccess: async () => {
      fake.asked.value += 1;
      fake.access.value = 'all';
      return 'all';
    },
    mediaRoot: () => ROOT,
    durableCopy: async (uri, name) => {
      if (fake.failCopy.value) throw new Error('No space left on device');
      copyCount += 1;
      const path = `media/copy-${copyCount}-${name}`;
      const bytes = fake.files.get(uri)?.bytes ?? 1000;
      fake.files.set(`${ROOT}${path}`, { bytes, modified: 0 });
      fake.copies.push(path);
      return { path, uri: `${ROOT}${path}`, bytes };
    },
    availableBytes: () => fake.available.value,
    mediaFiles: () => [...fake.files.entries()]
      .filter(([uri]) => uri.startsWith(`${ROOT}media/`))
      .map(([uri, file]) => ({ path: uri.slice(ROOT.length), bytes: file.bytes, modified: file.modified })),
    removeMedia: (path) => { fake.files.delete(`${ROOT}${path}`); },
    fileExists: (uri) => fake.files.has(uri),
    fileSize: (uri) => fake.files.get(uri)?.bytes ?? 0,
    removeFile: (uri) => { fake.files.delete(uri); },
    geometry: async () => null,
    ensureProxy: async (assetId, ref) => { fake.ensured.push([assetId, ref]); },
    touchProxy: (assetId) => { fake.touched.push(assetId); return true; },
    removeProxy: (assetId) => { fake.removedProxies.push(assetId); },
    analyze: async (assetId, ref) => { fake.analyzed.push([assetId, ref]); },
  };
  return { ...fake, native };
}

const open: Array<{ close(): void }> = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

async function setup(): Promise<{ deps: MediaDeps; fake: Fake; db: SqlDb; clock: { value: number } }> {
  const db = memoryDb();
  open.push(db);
  await migrate(db);
  const fake = fakeNative();
  const clock = { value: 1000 };
  const now = () => clock.value;
  return { deps: { store: createLocalMediaStore(db, now), native: fake.native, now }, fake, db, clock };
}

const add = (fake: Fake, uri: string, bytes = 1000, modified = 0): void => { fake.files.set(uri, { bytes, modified }); };

const video = (id: string) => ({ id, kind: 'video' as const });

describe('migrate', () => {
  it('creates the table once and is idempotent', async () => {
    const db = memoryDb();
    open.push(db);
    expect(await migrate(db)).toBe(LOCAL_MEDIA_MIGRATIONS.length);
    const store = createLocalMediaStore(db);
    await store.record({ assetId: 'a1', phLocalId: 'PH-1' });
    expect(await migrate(db)).toBe(LOCAL_MEDIA_MIGRATIONS.length);
    expect(await migrate(db)).toBe(LOCAL_MEDIA_MIGRATIONS.length);
    expect((await store.lookup('a1'))?.phLocalId).toBe('PH-1');
    const columns = (await db.getAllAsync<{ name: string }>('PRAGMA table_info(local_media)')).map((column) => column.name);
    expect(columns).toEqual([
      'asset_id', 'ph_local_id', 'file_uri', 'proxy_uri', 'proxy_status', 'fingerprint',
      'duration', 'bytes', 'color', 'server_only', 'updated_at', 'file_bytes', 'last_used', 'server_reason', 'geometry',
    ]);
    expect(await db.getAllAsync('SELECT * FROM local_media_meta')).toEqual([]);
  });

  it('applies only the steps a database has not seen, in order', async () => {
    const db = memoryDb();
    open.push(db);
    await migrate(db, LOCAL_MEDIA_MIGRATIONS);
    const next = [...LOCAL_MEDIA_MIGRATIONS, 'ALTER TABLE local_media ADD COLUMN label TEXT'];
    expect(await migrate(db, next)).toBe(LOCAL_MEDIA_MIGRATIONS.length + 1);
    expect(await migrate(db, next)).toBe(LOCAL_MEDIA_MIGRATIONS.length + 1);
    const columns = (await db.getAllAsync<{ name: string }>('PRAGMA table_info(local_media)')).map((column) => column.name);
    expect(columns.filter((name) => name === 'label')).toHaveLength(1);
  });

  it('rolls back a failed step and leaves the version where it was', async () => {
    const db = memoryDb();
    open.push(db);
    await expect(migrate(db, ['CREATE TABLE t (x INTEGER)', 'NOT SQL'])).rejects.toThrow();
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(version?.user_version).toBe(1);
  });
});

describe('fingerprints', () => {
  it('compares envelope hashes bit by bit over their common prefix, within one algorithm version', () => {
    expect(envelopeDistance('e1:ff', 'e1:ff')).toBe(0);
    expect(envelopeDistance('e1:f0', 'e1:ff')).toBe(0.5);
    // A shorter clip hashes fewer cells; the duration check is what tells them apart.
    expect(envelopeDistance('e1:ff', 'e1:ff00')).toBe(0);
    expect(envelopeDistance('e1:ff', 'e2:ff')).toBeNull();
  });

  it('matches the same file, a re-wrapped copy, and nothing trimmed', () => {
    const stored = { fingerprint: HASH, duration: 12.5, bytes: 4_000_000 };
    expect(fingerprintsMatch(stored, PRINT)).toBe(true);
    // Re-wrapped by the picker: other bytes, same audio.
    expect(fingerprintsMatch(stored, { ...PRINT, bytes: 3_900_000, duration: 12.52 })).toBe(true);
    // One flipped nibble of 32 is within tolerance.
    expect(fingerprintsMatch(stored, { ...PRINT, bytes: 1, audio: `e1:0${HASH.slice(4)}` })).toBe(true);
    // Trimmed at the end in Photos: the duration moves.
    expect(fingerprintsMatch(stored, { ...PRINT, duration: 10 })).toBe(false);
    // Trimmed at the front: the envelope shifts.
    expect(fingerprintsMatch(stored, { ...PRINT, bytes: 1, audio: 'e1:00000000000000000000000000000000' })).toBe(false);
    // Lost or gained an audio track.
    expect(fingerprintsMatch(stored, { ...PRINT, bytes: 1, audio: null })).toBe(false);
  });
});

describe('resolveMedia', () => {
  it('sends an asset with no row (an old project) to the server', async () => {
    const { deps } = await setup();
    expect(await resolveMedia(video('old'), deps)).toEqual({ assetId: 'old', kind: 'video', state: 'server', reason: 'no-row' });
  });

  it('sends a server-only asset to the server', async () => {
    const { deps } = await setup();
    await deps.store.markServerOnly('s1');
    expect(await resolveMedia(video('s1'), deps)).toMatchObject({ state: 'server', reason: 'server-only' });
  });

  it('uses a local Photos original whose fingerprint matches, and queues its proxy', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fingerprint: PRINT });
    fake.probes.set('PH-1', { status: 'ok', fingerprint: PRINT });
    expect(await resolveMedia(video('a1'), deps)).toEqual({ assetId: 'a1', kind: 'video', state: 'local', ref: 'PH-1', fingerprint: PRINT });
    expect(fake.ensured).toEqual([['a1', 'PH-1']]);
  });

  it('flags a Photos original that no longer matches as changed', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fingerprint: PRINT });
    const trimmed = { ...PRINT, duration: 8, bytes: 2_000_000 };
    fake.probes.set('PH-1', { status: 'ok', fingerprint: trimmed });
    const resolved = await resolveMedia(video('a1'), deps);
    expect(resolved).toMatchObject({ state: 'changed', ref: 'PH-1', actual: trimmed, expected: { duration: 12.5, bytes: 4_000_000, fingerprint: HASH } });
    expect(fake.ensured).toEqual([]);
  });

  it('takes the first fingerprint it sees when the import could not read one', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fingerprint: null });
    fake.probes.set('PH-1', { status: 'ok', fingerprint: PRINT });
    expect(await resolveMedia(video('a1'), deps)).toMatchObject({ state: 'local' });
    expect(await deps.store.lookup('a1')).toMatchObject({ fingerprint: HASH, duration: 12.5, bytes: 4_000_000, color: 'hlg' });
  });

  it('reports an offloaded original as icloud, and downloads it with progress', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fingerprint: PRINT });
    fake.probes.set('PH-1', { status: 'icloud' });
    const resolved = await resolveMedia(video('a1'), deps);
    expect(resolved).toEqual({ assetId: 'a1', kind: 'video', state: 'icloud', ref: 'PH-1' });
    if (resolved.state !== 'icloud') throw new Error('expected icloud');

    fake.downloads.set('PH-1', { status: 'ok', fingerprint: PRINT });
    const progress: number[] = [];
    expect(await downloadMedia(resolved, deps, { onProgress: (fraction) => progress.push(fraction) })).toMatchObject({ state: 'local', ref: 'PH-1' });
    expect(progress).toEqual([0.5, 1]);
  });

  it('cancels an iCloud download and stays icloud', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fingerprint: PRINT });
    const controller = new AbortController();
    const pending = downloadMedia({ assetId: 'a1', kind: 'video', state: 'icloud', ref: 'PH-1' }, deps, { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ assetId: 'a1', kind: 'video', state: 'icloud', ref: 'PH-1' });
    expect(fake.cancelled).toHaveLength(1);
  });

  it('keeps an offline download failure as icloud with the reason, for a retry', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fingerprint: PRINT });
    fake.downloads.set('PH-1', { status: 'unreachable', error: 'The Internet connection appears to be offline.' });
    expect(await downloadMedia({ assetId: 'a1', kind: 'video', state: 'icloud', ref: 'PH-1' }, deps))
      .toEqual({ assetId: 'a1', kind: 'video', state: 'icloud', ref: 'PH-1', unreachable: 'The Internet connection appears to be offline.' });
  });

  it('uses the app copy, with its proxy when that is on disk', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'f1', fileUri: 'media/clip.mov', fingerprint: PRINT });
    await deps.store.setProxy('f1', 'ready', 'proxies/f1.mov');
    add(fake, `${ROOT}media/clip.mov`);
    add(fake, `${ROOT}proxies/f1.mov`);
    expect(await resolveMedia(video('f1'), deps)).toEqual({
      assetId: 'f1', kind: 'video', state: 'file', ref: `${ROOT}media/clip.mov`, proxyUri: `${ROOT}proxies/f1.mov`,
    });
    expect(fake.touched).toEqual(['f1']);
    expect(fake.ensured).toEqual([]);
  });

  it('regenerates a proxy the registry thinks is ready but is gone', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'f1', fileUri: 'media/clip.mov' });
    await deps.store.setProxy('f1', 'ready', 'proxies/f1.mov');
    add(fake, `${ROOT}media/clip.mov`);
    const resolved = await resolveMedia(video('f1'), deps);
    expect(resolved).toEqual({ assetId: 'f1', kind: 'video', state: 'file', ref: `${ROOT}media/clip.mov` });
    expect(await deps.store.lookup('f1')).toMatchObject({ proxyStatus: 'missing', proxyUri: null });
    expect(fake.ensured).toEqual([['f1', `${ROOT}media/clip.mov`]]);
  });

  it('leaves the proxy alone for an export', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'f1', fileUri: 'media/clip.mov' });
    add(fake, `${ROOT}media/clip.mov`);
    expect(await resolveMedia(video('f1'), deps, { purpose: 'export' })).toEqual({ assetId: 'f1', kind: 'video', state: 'file', ref: `${ROOT}media/clip.mov` });
    expect(fake.ensured).toEqual([]);
  });

  it('resolves audio and images to their app copies without a proxy', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'm1', fileUri: 'media/memo.m4a' });
    await deps.store.record({ assetId: 'i1', fileUri: 'media/sticker.png' });
    add(fake, `${ROOT}media/memo.m4a`);
    add(fake, `${ROOT}media/sticker.png`);
    expect(await resolveMedia({ id: 'm1', kind: 'audio' }, deps)).toMatchObject({ state: 'file', kind: 'audio' });
    expect(await resolveMedia({ id: 'i1', kind: 'image' }, deps)).toMatchObject({ state: 'file', kind: 'image' });
    expect(fake.ensured).toEqual([]);
  });

  it('falls back to the server when the app copy was removed', async () => {
    const { deps } = await setup();
    await deps.store.record({ assetId: 'f1', fileUri: 'media/clip.mov' });
    expect(await resolveMedia(video('f1'), deps)).toMatchObject({ state: 'server', reason: 'file-missing' });
  });

  it('falls back from a removed app copy to the Photos original', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fileUri: 'media/clip.mov', fingerprint: PRINT });
    fake.probes.set('PH-1', { status: 'ok', fingerprint: PRINT });
    expect(await resolveMedia(video('a1'), deps)).toMatchObject({ state: 'local', ref: 'PH-1' });
  });

  it.each([
    ['all', 'deleted'],
    ['limited', 'limited'],
    ['denied', 'denied'],
    ['undetermined', 'denied'],
  ] as const)('sends a PHAsset it cannot load with %s access to the server as %s', async (access, reason) => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fingerprint: PRINT });
    fake.probes.set('PH-1', { status: 'missing', access });
    expect(await resolveMedia(video('a1'), deps)).toEqual({ assetId: 'a1', kind: 'video', state: 'server', reason });
  });

  it('prefers the app copy kept under limited access over the PHAsset', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fileUri: 'media/clip.mov', fingerprint: PRINT });
    add(fake, `${ROOT}media/clip.mov`);
    fake.probes.set('PH-1', { status: 'missing', access: 'limited' });
    expect(await resolveMedia(video('a1'), deps)).toMatchObject({ state: 'file', ref: `${ROOT}media/clip.mov` });
  });

  it('sends an unreadable source to the server', async () => {
    const { deps, fake } = await setup();
    await deps.store.record({ assetId: 'a1', phLocalId: 'PH-1', fingerprint: PRINT });
    fake.probes.set('PH-1', { status: 'failed', error: 'Cannot Open' });
    expect(await resolveMedia(video('a1'), deps)).toMatchObject({ state: 'server', reason: 'unreadable' });
  });
});

describe('stageImport', () => {
  it('references a Photos video by its PHAsset id under full access, without copying', async () => {
    const { deps, fake } = await setup();
    fake.probes.set('file:///cache/ImagePicker/IMG_1.mov', { status: 'ok', fingerprint: PRINT });
    // The original, re-wrapped by the picker: other bytes, same audio and duration.
    fake.probes.set('PH-1', { status: 'ok', fingerprint: { ...PRINT, bytes: 4_100_000 } });
    const staged = await stageImport({ uri: 'file:///cache/ImagePicker/IMG_1.mov', name: 'IMG_1.mov', kind: 'video', origin: 'photos', phLocalId: 'PH-1' }, deps);
    expect(staged).toMatchObject({ uploadUri: 'file:///cache/ImagePicker/IMG_1.mov', durable: false });
    await staged.commit('a1');
    expect(fake.copies).toEqual([]);
    expect(await deps.store.lookup('a1')).toEqual({
      assetId: 'a1', phLocalId: 'PH-1', fileUri: null, fileBytes: null, proxyUri: null, proxyStatus: null,
      fingerprint: HASH, duration: 12.5, bytes: 4_000_000, color: 'hlg', geometry: null, serverOnly: false, serverReason: null,
      lastUsed: 1000, updatedAt: 1000,
    });
    expect(fake.ensured).toEqual([['a1', 'PH-1']]);
  });

  it('copies a Photos video edited in Photos before import (the picker uploads the edit), keeping the id', async () => {
    const { deps, fake } = await setup();
    add(fake, 'file:///cache/ImagePicker/IMG_1.mov');
    fake.probes.set('file:///cache/ImagePicker/IMG_1.mov', { status: 'ok', fingerprint: { ...PRINT, duration: 8 } });
    fake.probes.set('PH-1', { status: 'ok', fingerprint: PRINT });
    const staged = await stageImport({ uri: 'file:///cache/ImagePicker/IMG_1.mov', name: 'IMG_1.mov', kind: 'video', origin: 'photos', phLocalId: 'PH-1' }, deps);
    expect(staged).toMatchObject({ uploadUri: `${ROOT}media/copy-1-IMG_1.mov`, durable: true });
    await staged.commit('a1');
    expect(await deps.store.lookup('a1')).toMatchObject({ phLocalId: 'PH-1', fileUri: 'media/copy-1-IMG_1.mov', duration: 8 });
    expect(await resolveMedia(video('a1'), deps)).toMatchObject({ state: 'file' });
  });

  it('copies a Photos video whose original is only in iCloud, under full access', async () => {
    const { deps, fake } = await setup();
    fake.probes.set('file:///cache/ImagePicker/IMG_1.mov', { status: 'ok', fingerprint: PRINT });
    fake.probes.set('PH-1', { status: 'icloud' });
    const staged = await stageImport({ uri: 'file:///cache/ImagePicker/IMG_1.mov', name: 'IMG_1.mov', kind: 'video', origin: 'photos', phLocalId: 'PH-1' }, deps);
    expect(staged.durable).toBe(true);
  });

  it('skips the copy and marks the asset server-only when the phone is short of space', async () => {
    const { deps, fake } = await setup();
    add(fake, 'file:///cache/DocumentPicker/take.mov', 2 * GB);
    fake.available.value = 2.5 * GB;
    const staged = await stageImport({ uri: 'file:///cache/DocumentPicker/take.mov', name: 'take.mov', kind: 'video', origin: 'files' }, deps);
    expect(staged).toMatchObject({ uploadUri: 'file:///cache/DocumentPicker/take.mov', durable: false });
    expect(fake.copies).toEqual([]);
    await staged.commit('f1');
    expect(await resolveMedia(video('f1'), deps)).toMatchObject({ state: 'server', reason: 'no-space' });
  });

  it('copies a Photos video under limited access and keeps the PHAsset id next to it', async () => {
    const { deps, fake } = await setup();
    fake.access.value = 'limited';
    const staged = await stageImport({ uri: 'file:///cache/ImagePicker/IMG_1.mov', name: 'IMG_1.mov', kind: 'video', origin: 'photos', phLocalId: 'PH-1' }, deps);
    expect(staged).toMatchObject({ uploadUri: `${ROOT}media/copy-1-IMG_1.mov`, durable: true });
    fake.probes.set(staged.uploadUri, { status: 'ok', fingerprint: PRINT });
    await staged.commit('a1');
    expect(await deps.store.lookup('a1')).toMatchObject({ phLocalId: 'PH-1', fileUri: 'media/copy-1-IMG_1.mov', fingerprint: HASH, serverOnly: false });
    expect(fake.ensured).toEqual([['a1', `${ROOT}media/copy-1-IMG_1.mov`]]);
  });

  it('copies a Photos video the picker gave no asset id for', async () => {
    const { deps, fake } = await setup();
    fake.access.value = 'denied';
    const staged = await stageImport({ uri: 'file:///cache/ImagePicker/IMG_2.mov', name: 'IMG_2.mov', kind: 'video', origin: 'photos', phLocalId: null }, deps);
    await staged.commit('a2');
    expect(await deps.store.lookup('a2')).toMatchObject({ phLocalId: null, fileUri: 'media/copy-1-IMG_2.mov', serverOnly: false });
  });

  it('marks a Photos pick with neither an asset id nor a file server-only', async () => {
    const { deps, fake } = await setup();
    fake.access.value = 'undetermined';
    const staged = await stageImport({ uri: '', name: 'clip.mov', kind: 'video', origin: 'photos', phLocalId: null }, deps);
    expect(staged).toMatchObject({ uploadUri: '', durable: false });
    await staged.commit('a3');
    expect(await deps.store.lookup('a3')).toMatchObject({ serverOnly: true, phLocalId: null, fileUri: null });
    expect(await resolveMedia(video('a3'), deps)).toMatchObject({ state: 'server', reason: 'server-only' });
  });

  it('copies a Files import into Application Support before the upload', async () => {
    const { deps, fake } = await setup();
    const staged = await stageImport({ uri: 'file:///cache/DocumentPicker/take.mov', name: 'take.mov', kind: 'video', origin: 'files' }, deps);
    expect(staged.uploadUri).toBe(`${ROOT}media/copy-1-take.mov`);
    fake.probes.set(staged.uploadUri, { status: 'ok', fingerprint: PRINT });
    await staged.commit('f1');
    expect(await deps.store.lookup('f1')).toMatchObject({ fileUri: 'media/copy-1-take.mov', fingerprint: HASH, duration: 12.5, phLocalId: null });
    expect(await resolveMedia(video('f1'), deps)).toMatchObject({ state: 'file', ref: `${ROOT}media/copy-1-take.mov` });
  });

  it('keeps a share import in Application Support (the share copy is no longer the only one)', async () => {
    const { deps, fake } = await setup();
    const staged = await stageImport({ uri: 'file:///group/share/memo.m4a', name: 'memo.m4a', kind: 'audio', origin: 'share' }, deps);
    expect(staged.durable).toBe(true);
    await staged.commit('s1');
    expect(fake.files.has(`${ROOT}media/copy-1-memo.m4a`)).toBe(true);
    expect(await deps.store.lookup('s1')).toMatchObject({ fileUri: 'media/copy-1-memo.m4a' });
    // Audio gets no preview proxy.
    expect(fake.ensured).toEqual([]);
  });

  it('copies a sticker image without fingerprinting it', async () => {
    const { deps, fake } = await setup();
    const probe = vi.spyOn(fake.native, 'probe');
    const staged = await stageImport({ uri: 'file:///cache/ImagePicker/sticker.png', name: 'sticker.png', kind: 'image', origin: 'photos', phLocalId: 'PH-9' }, deps);
    await staged.commit('i1');
    expect(probe).not.toHaveBeenCalled();
    expect(await deps.store.lookup('i1')).toMatchObject({ fileUri: 'media/copy-1-sticker.png', phLocalId: 'PH-9', fingerprint: null });
    expect(fake.ensured).toEqual([]);
  });

  it('records a voice-over take from its copy', async () => {
    const { deps, fake } = await setup();
    const staged = await stageImport({ uri: 'file:///tmp/recording.m4a', name: 'voiceover.m4a', kind: 'audio', origin: 'capture' }, deps);
    fake.probes.set(staged.uploadUri, { status: 'ok', fingerprint: { ...PRINT, color: null } });
    await staged.commit('v1');
    expect(await deps.store.lookup('v1')).toMatchObject({ fileUri: 'media/copy-1-voiceover.m4a', color: null, fingerprint: HASH });
  });

  it('removes its copy when the upload fails', async () => {
    const { deps, fake } = await setup();
    const staged = await stageImport({ uri: 'file:///cache/DocumentPicker/take.mov', name: 'take.mov', kind: 'video', origin: 'files' }, deps);
    staged.abort();
    expect(fake.files.size).toBe(0);
    expect(await deps.store.lookup('f1')).toBeNull();
  });

  it('uploads from the picked file and marks it server-only when the copy fails', async () => {
    const { deps, fake } = await setup();
    fake.failCopy.value = true;
    const staged = await stageImport({ uri: 'file:///cache/DocumentPicker/take.mov', name: 'take.mov', kind: 'video', origin: 'files' }, deps);
    expect(staged).toMatchObject({ uploadUri: 'file:///cache/DocumentPicker/take.mov', durable: false });
    await staged.commit('f1');
    expect(await deps.store.lookup('f1')).toMatchObject({ serverOnly: true });
  });
});

describe('applyProxyEvent', () => {
  it('mirrors the native proxy part into the row', async () => {
    const { deps } = await setup();
    await deps.store.record({ assetId: 'f1', fileUri: 'media/clip.mov' });
    const read = async () => 'proxies/f1.mov';
    await applyProxyEvent(deps.store, { assetId: 'f1', part: 'proxy', status: 'pending' }, read);
    expect(await deps.store.lookup('f1')).toMatchObject({ proxyStatus: 'pending', proxyUri: null });
    await applyProxyEvent(deps.store, { assetId: 'f1', part: 'proxy', status: 'ready' }, read);
    expect(await deps.store.lookup('f1')).toMatchObject({ proxyStatus: 'ready', proxyUri: 'proxies/f1.mov' });
    await applyProxyEvent(deps.store, { assetId: 'f1', part: 'words', status: 'failed' }, read);
    expect(await deps.store.lookup('f1')).toMatchObject({ proxyStatus: 'ready' });
    await applyProxyEvent(deps.store, { assetId: 'f1', part: 'proxy', removed: true }, read);
    expect(await deps.store.lookup('f1')).toMatchObject({ proxyStatus: 'evicted', proxyUri: null });
  });

  it('does not create rows for assets the registry never saw', async () => {
    const { deps } = await setup();
    await applyProxyEvent(deps.store, { assetId: 'nope', part: 'proxy', status: 'ready' }, async () => 'proxies/nope.mov');
    expect(await deps.store.lookup('nope')).toBeNull();
  });
});

describe('mediaKindOf', () => {
  it('reads the MIME type, then the extension', () => {
    expect(mediaKindOf('audio/x-m4a', 'memo.m4a')).toBe('audio');
    expect(mediaKindOf('image/png', 'a.png')).toBe('image');
    expect(mediaKindOf('application/octet-stream', 'memo.m4a')).toBe('audio');
    expect(mediaKindOf(undefined, 'IMG_1.MOV')).toBe('video');
  });
});

/** Committed copies, one second apart (oldest first). */
async function seed(deps: MediaDeps, fake: Fake, clock: { value: number }, ids: string[], bytes: number): Promise<void> {
  for (const id of ids) {
    clock.value += 1000;
    add(fake, `${ROOT}media/${id}.mov`, bytes);
    await deps.store.record({ assetId: id, fileUri: `media/${id}.mov`, fileBytes: bytes });
  }
}

describe('copy cache', () => {

  it('counts what the cache holds toward its own budget', async () => {
    const { deps, fake, clock } = await setup();
    fake.available.value = 4 * GB;
    await seed(deps, fake, clock, ['a', 'b'], 2 * GB);
    expect(await copyBudget(deps)).toBe(2 * GB); // a quarter of (4 GB free + 4 GB cached)
  });

  it('budgets min(20 GB, a quarter of free space) unless set', async () => {
    const { deps, fake } = await setup();
    fake.available.value = 200 * GB;
    expect(await copyBudget(deps)).toBe(20 * GB);
    fake.available.value = 40 * GB;
    expect(await copyBudget(deps)).toBe(10 * GB);
    await setCopyBudget(deps, 3 * GB);
    expect(await copyBudget(deps)).toBe(3 * GB);
    await setCopyBudget(deps, Number.NaN);
    expect(await copyBudget(deps)).toBe(10 * GB);
  });

  it('evicts the least recently used copies first, keeps a protected one, and falls back to the server', async () => {
    const { deps, fake, clock } = await setup();
    await setCopyBudget(deps, 2500);
    await seed(deps, fake, clock, ['a', 'b', 'c'], 1000);
    clock.value += 1000;
    await resolveMedia({ id: 'a', kind: 'audio' }, deps); // a is used again: b is now the oldest
    expect(await enforceCopyBudget(deps)).toEqual(['b']);
    expect(fake.files.has(`${ROOT}media/b.mov`)).toBe(false);
    expect(await resolveMedia(video('b'), deps)).toMatchObject({ state: 'server', reason: 'evicted' });
    await setCopyBudget(deps, 500);
    expect(await enforceCopyBudget(deps, { protect: 'c' })).toEqual(['a']);
  });

  it('keeps the PHAsset id of an evicted copy', async () => {
    const { deps, fake } = await setup();
    await setCopyBudget(deps, 10);
    add(fake, `${ROOT}media/a.mov`, 1000);
    await deps.store.record({ assetId: 'a', phLocalId: 'PH-1', fileUri: 'media/a.mov', fileBytes: 1000, fingerprint: PRINT });
    await enforceCopyBudget(deps);
    expect(await deps.store.lookup('a')).toMatchObject({ fileUri: null, phLocalId: 'PH-1', serverOnly: false });
    fake.probes.set('PH-1', { status: 'missing', access: 'limited' });
    expect(await resolveMedia(video('a'), deps)).toMatchObject({ state: 'server', reason: 'limited' });
  });

  it('makes room for a new copy, counting images too', async () => {
    const { deps, fake, clock } = await setup();
    await setCopyBudget(deps, 2500);
    await seed(deps, fake, clock, ['old'], 1000);
    clock.value += 1000;
    add(fake, `${ROOT}media/sticker.png`, 1000);
    await deps.store.record({ assetId: 'img', fileUri: 'media/sticker.png', fileBytes: 1000 });
    add(fake, 'file:///cache/new.mov', 1000);
    const staged = await stageImport({ uri: 'file:///cache/new.mov', name: 'new.mov', kind: 'video', origin: 'files' }, deps);
    await staged.commit('new');
    expect(await deps.store.lookup('old')).toMatchObject({ fileUri: null, serverOnly: true });
    expect(await deps.store.lookup('img')).toMatchObject({ fileUri: 'media/sticker.png' });
    expect(await deps.store.lookup('new')).toMatchObject({ fileBytes: 1000 });
  });

  it('sweeps media files no row points at once they are a day old', async () => {
    const { deps, fake, clock } = await setup();
    clock.value = 10 * ORPHAN_AGE_MS;
    add(fake, `${ROOT}media/kept.mov`, 10, 0);
    await deps.store.record({ assetId: 'k', fileUri: 'media/kept.mov', fileBytes: 10 });
    add(fake, `${ROOT}media/orphan-old.mov`, 10, clock.value - ORPHAN_AGE_MS - 1);
    add(fake, `${ROOT}media/orphan-new.mov`, 10, clock.value - 1000);
    expect(await sweepOrphanCopies(deps)).toEqual(['media/orphan-old.mov']);
    await maintainMedia(deps);
    expect([...fake.files.keys()].sort()).toEqual([`${ROOT}media/kept.mov`, `${ROOT}media/orphan-new.mov`]);
  });

  it('forgets a deleted project\'s media unless another project uses it', async () => {
    const { deps, fake, clock } = await setup();
    await seed(deps, fake, clock, ['only-here', 'shared'], 10);
    expect(await releaseProjectMedia(deps, ['only-here', 'shared'], new Set(['shared']))).toEqual(['only-here']);
    expect(await deps.store.lookup('only-here')).toBeNull();
    expect(fake.files.has(`${ROOT}media/only-here.mov`)).toBe(false);
    expect(fake.removedProxies).toEqual(['only-here']);
    expect(await deps.store.lookup('shared')).not.toBeNull();
    await forgetMedia(deps, ['never-seen']);
  });
});

describe('askForPhotosAccessOnce', () => {
  it('explains, then asks iOS, once', async () => {
    const { deps, fake } = await setup();
    fake.access.value = 'undetermined';
    const explain = vi.fn(async () => true);
    expect(await askForPhotosAccessOnce(deps, explain)).toBe('all');
    expect(explain).toHaveBeenCalledTimes(1);
    expect(fake.asked.value).toBe(1);
    expect(await deps.store.getMeta(PHOTOS_ASKED_KEY)).not.toBeNull();
  });

  it('does not ask again after "Not now"', async () => {
    const { deps, fake } = await setup();
    fake.access.value = 'undetermined';
    const explain = vi.fn(async () => false);
    expect(await askForPhotosAccessOnce(deps, explain)).toBe('undetermined');
    expect(await askForPhotosAccessOnce(deps, explain)).toBe('undetermined');
    expect(explain).toHaveBeenCalledTimes(1);
    expect(fake.asked.value).toBe(0);
  });

  it('never asks once iOS has an answer (granted, limited or declined)', async () => {
    for (const access of ['all', 'limited', 'denied'] as const) {
      const { deps, fake } = await setup();
      fake.access.value = access;
      const explain = vi.fn(async () => true);
      expect(await askForPhotosAccessOnce(deps, explain)).toBe(access);
      expect(explain).not.toHaveBeenCalled();
    }
  });
});

describe('analyzeMedia', () => {
  it('analyzes only a resolved app copy or a matching original, by its resolved ref', async () => {
    const { deps, fake } = await setup();
    add(fake, `${ROOT}media/copy.mov`);
    await deps.store.record({ assetId: 'f1', phLocalId: 'PH-F', fileUri: 'media/copy.mov' });
    await deps.store.record({ assetId: 'l1', phLocalId: 'PH-L', fingerprint: PRINT });
    await deps.store.record({ assetId: 'c1', phLocalId: 'PH-C', fingerprint: PRINT });
    fake.probes.set('PH-L', { status: 'ok', fingerprint: PRINT });
    fake.probes.set('PH-C', { status: 'ok', fingerprint: { ...PRINT, duration: 3 } });
    await analyzeMedia(video('f1'), deps);
    await analyzeMedia(video('l1'), deps);
    expect(await analyzeMedia(video('c1'), deps)).toMatchObject({ state: 'changed' });
    expect(await analyzeMedia(video('none'), deps)).toMatchObject({ state: 'server' });
    expect(fake.analyzed).toEqual([['f1', `${ROOT}media/copy.mov`], ['l1', 'PH-L']]);
    // Analysis wants the original, not a proxy.
    expect(fake.ensured).toEqual([]);
  });
});

describe('copy cache under concurrency', () => {
  it('keeps four concurrent imports\' copies until each upload lands, then fits the budget', async () => {
    const { deps, fake, clock } = await setup();
    await setCopyBudget(deps, 1800);
    clock.value += 1000;
    add(fake, `${ROOT}media/old.mov`, 1000);
    await deps.store.record({ assetId: 'old', fileUri: 'media/old.mov', fileBytes: 1000 });
    const names = ['a', 'b', 'c', 'd'];
    for (const name of names) add(fake, `file:///cache/${name}.mov`, 500);
    const staged = await Promise.all(names.map(async (name) =>
      await stageImport({ uri: `file:///cache/${name}.mov`, name: `${name}.mov`, kind: 'audio', origin: 'files' }, deps)));
    // Staging never evicts: the old copy is still there with four uploads in flight.
    expect(fake.files.has(`${ROOT}media/old.mov`)).toBe(true);
    for (const [index, name] of names.entries()) {
      clock.value += 1000;
      // Every copy still uploading is on disk when its upload "lands".
      for (const later of staged.slice(index)) expect(fake.files.has(later.uploadUri)).toBe(true);
      await staged[index]?.commit(name);
    }
    const copies = await deps.store.copies();
    expect(copies.reduce((sum, row) => sum + (row.fileBytes ?? 0), 0)).toBeLessThanOrEqual(1800);
    expect(await deps.store.lookup('old')).toMatchObject({ fileUri: null, serverReason: 'evicted' });
    expect(copies.map((row) => row.assetId)).toContain('d');
  });

  it('evicts nothing for a failed upload', async () => {
    const { deps, fake, clock } = await setup();
    await setCopyBudget(deps, 1500);
    clock.value += 1000;
    add(fake, `${ROOT}media/old.mov`, 1000);
    await deps.store.record({ assetId: 'old', fileUri: 'media/old.mov', fileBytes: 1000 });
    add(fake, 'file:///cache/new.mov', 1000);
    const staged = await stageImport({ uri: 'file:///cache/new.mov', name: 'new.mov', kind: 'video', origin: 'files' }, deps);
    staged.abort();
    expect(fake.files.has(`${ROOT}media/old.mov`)).toBe(true);
    expect(fake.files.has(staged.uploadUri)).toBe(false);
    expect(await deps.store.lookup('old')).toMatchObject({ fileUri: 'media/old.mov' });
    // And it no longer counts: a later import fits next to the old copy.
    add(fake, 'file:///cache/next.mov', 400);
    const next = await stageImport({ uri: 'file:///cache/next.mov', name: 'next.mov', kind: 'video', origin: 'files' }, deps);
    await next.commit('next');
    expect(await deps.store.lookup('old')).toMatchObject({ fileUri: 'media/old.mov' });
  });

  it('never sweeps a copy whose upload is still in flight', async () => {
    const { deps, fake, clock } = await setup();
    clock.value = 10 * ORPHAN_AGE_MS;
    add(fake, 'file:///cache/clip.mov', 10);
    const staged = await stageImport({ uri: 'file:///cache/clip.mov', name: 'clip.mov', kind: 'video', origin: 'files' }, deps);
    // Even if its file looked old (the native side sets it to now), it is in flight.
    const copy = fake.files.get(staged.uploadUri);
    if (copy) copy.modified = 0;
    expect(await sweepOrphanCopies(deps)).toEqual([]);
  });

  it('shrinks the cache at launch only when the phone is below the free-space reserve', async () => {
    const { deps, fake, clock } = await setup();
    await setCopyBudget(deps, 1000);
    await seed(deps, fake, clock, ['a', 'b', 'c'], 1000);
    fake.available.value = 10 * GB;
    await maintainMedia(deps);
    expect((await deps.store.copies()).length).toBe(3);
    await setCopyBudget(deps, null);
    fake.available.value = COPY_FREE_RESERVE - 1500;
    await maintainMedia(deps);
    // Two oldest copies go to get back above the reserve.
    expect((await deps.store.copies()).map((row) => row.assetId)).toEqual(['c']);
  });
});

describe('leases', () => {
  it('pin assets against eviction and forgetting until every lease is released', async () => {
    const { deps, fake, clock } = await setup();
    await seed(deps, fake, clock, ['a', 'b'], 1000);
    await setCopyBudget(deps, 10);
    const exportLease = leaseMedia(deps, ['a', 'b']);
    const previewLease = leaseMedia(deps, ['a']);
    expect(await enforceCopyBudget(deps)).toEqual([]);
    expect(await forgetMedia(deps, ['a', 'b'])).toEqual([]);
    exportLease.release();
    exportLease.release(); // idempotent
    expect(isLeased(deps, 'a')).toBe(true);
    expect(isLeased(deps, 'b')).toBe(false);
    expect(await enforceCopyBudget(deps)).toEqual(['b']);
    previewLease.release();
    expect(await forgetMedia(deps, ['a'])).toEqual(['a']);
  });
});
