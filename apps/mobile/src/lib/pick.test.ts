import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalMediaStore, migrate, type MediaDeps, type MediaNative, type MediaProbe } from './local-media';
import { memoryDb } from './test-sqlite';

/*
 * The import entry points (pick.ts) around the registry: what gets uploaded, what
 * row lands, and which local copies survive. The registry itself is local-media.test.ts.
 */
const ROOT = 'file:///support/Editify/';
const PRINT = { duration: 3, bytes: 900, audio: 'e1:abcd', color: 'sdr' as const };

const state = vi.hoisted(() => ({
  deps: null as MediaDeps | null,
  uploads: [] as Array<{ uri: string; name: string }>,
  failNames: new Set<string>(),
  discarded: [] as string[],
  picked: undefined as unknown,
  documents: undefined as unknown,
  alerts: [] as string[],
  alertChoice: 'Continue',
  pickerOpenedAfterAlert: false,
  /** POST /assets/register answers (an older server 404s and the import uploads first). */
  register: false,
  registered: [] as Array<{ projectId: string; name: string; mimeType: string; duration: number; width: number; height: number; hasAudio: boolean }>,
  originals: [] as Array<{ assetId: string; projectId: string; uri: string }>,
  /** Holds every PUT /assets/:id/original until released. */
  hold: null as Promise<void> | null,
}));

vi.mock('react-native', () => ({
  Alert: {
    alert: (title: string, _message: string, buttons: Array<{ text: string; onPress?: () => void }>) => {
      state.alerts.push(title);
      buttons.find((button) => button.text === state.alertChoice)?.onPress?.();
    },
  },
}));

vi.mock('./local-media-native', () => ({ localMedia: async () => state.deps }));
vi.mock('./api', () => ({
  uploadAsset: async (asset: { uri: string; name: string }) => {
    if (state.failNames.has(asset.name)) throw new Error('500');
    state.uploads.push({ uri: asset.uri, name: asset.name });
    return { id: `asset-${asset.name}`, originalName: asset.name };
  },
  api: {
    registerAsset: async (projectId: string, probe: (typeof state.registered)[number]) => {
      if (!state.register) throw Object.assign(new Error('Not found'), { status: 404 });
      state.registered.push({ ...probe, projectId });
      return { id: `asset-${probe.name}`, originalName: probe.name, mimeType: probe.mimeType, duration: probe.duration, hasAudio: probe.hasAudio };
    },
  },
  uploadOriginal: async (assetId: string, projectId: string, file: { uri: string }) => {
    state.originals.push({ assetId, projectId, uri: file.uri });
    await state.hold;
  },
}));
vi.mock('./shared-files', () => ({ discardSharedCopy: (uri: string) => { state.discarded.push(uri); } }));
vi.mock('expo-file-system', () => ({ File: class { size = 0; constructor(public uri: string) {} } }));
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: async () => {
    state.pickerOpenedAfterAlert = state.alerts.length > 0;
    return state.picked;
  },
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
}));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: async () => state.documents }));

const { pickFromFiles, pickFromPhotos, uploadMediaFile, uploadShared } = await import('./pick');
const { uploads } = await import('./uploads');
const { onImportCompleted } = await import('./import-hooks');
const { pendingUploads } = await import('./local-media');

let files: Set<string>;
let access: 'all' | 'limited' | 'denied' | 'undetermined';
let print: MediaProbe;

beforeEach(async () => {
  const db = memoryDb();
  await migrate(db);
  files = new Set();
  access = 'all';
  let copies = 0;
  print = { status: 'ok', fingerprint: PRINT };
  const native: MediaNative = {
    probe: async (): Promise<MediaProbe> => print,
    download: async () => ({ status: 'icloud' }),
    cancelDownload: () => undefined,
    photosAccess: () => access,
    requestPhotosAccess: async () => { access = 'all'; return access; },
    mediaRoot: () => ROOT,
    durableCopy: async (_uri, name) => {
      copies += 1;
      const path = `media/${copies}-${name}`;
      files.add(`${ROOT}${path}`);
      return { path, uri: `${ROOT}${path}`, bytes: 900 };
    },
    availableBytes: () => 100 * 1024 ** 3,
    mediaFiles: () => [],
    removeMedia: (path) => { files.delete(`${ROOT}${path}`); },
    fileExists: (uri) => files.has(uri),
    fileSize: () => 900,
    removeFile: (uri) => { files.delete(uri); },
    geometry: async () => null,
    ensureProxy: async () => undefined,
    touchProxy: () => false,
    removeProxy: () => undefined,
    analyze: async () => undefined,
    exportOriginal: async () => { throw new Error('unused'); },
  };
  state.deps = { store: createLocalMediaStore(db), native };
  state.uploads = [];
  state.failNames = new Set();
  state.discarded = [];
  state.alerts = [];
  state.alertChoice = 'Continue';
  state.pickerOpenedAfterAlert = false;
  state.register = false;
  state.registered = [];
  state.originals = [];
  state.hold = null;
});

describe('Photos access', () => {
  it('explains and asks once, before opening the picker, then references by asset id', async () => {
    access = 'undetermined';
    state.picked = { canceled: false, assets: [{ uri: 'file:///cache/IMG_1.mov', fileName: 'IMG_1.mov', assetId: 'PH-1' }] };
    await pickFromPhotos('p1');
    expect(state.alerts).toEqual(['Use your originals']);
    expect(state.pickerOpenedAfterAlert).toBe(true);
    expect(await state.deps?.store.lookup('asset-IMG_1.mov')).toMatchObject({ phLocalId: 'PH-1', fileUri: null });
    await pickFromPhotos('p1');
    expect(state.alerts).toHaveLength(1);
  });

  it('copies after "Not now" and never asks again', async () => {
    access = 'undetermined';
    state.alertChoice = 'Not now';
    state.picked = { canceled: false, assets: [{ uri: 'file:///cache/IMG_1.mov', fileName: 'IMG_1.mov', assetId: 'PH-1' }] };
    await pickFromPhotos('p1');
    await pickFromPhotos('p1');
    expect(state.alerts).toHaveLength(1);
    expect(await state.deps?.store.lookup('asset-IMG_1.mov')).toMatchObject({ phLocalId: 'PH-1', fileUri: expect.stringMatching(/^media\//) });
  });
});

describe('import hooks', () => {
  it('references a Photos video by asset id under full access and uploads the picked file', async () => {
    state.picked = { canceled: false, assets: [{ uri: 'file:///cache/IMG_1.mov', fileName: 'IMG_1.mov', assetId: 'PH-1' }] };
    const result = await pickFromPhotos('p1');
    expect(result.failed).toEqual([]);
    expect(state.uploads).toEqual([{ uri: 'file:///cache/IMG_1.mov', name: 'IMG_1.mov' }]);
    expect(await state.deps?.store.lookup('asset-IMG_1.mov')).toMatchObject({ phLocalId: 'PH-1', fileUri: null, fingerprint: 'e1:abcd' });
  });

  it('keeps a durable copy of a Photos video when the picker gave no asset id', async () => {
    access = 'limited';
    state.picked = { canceled: false, assets: [{ uri: 'file:///cache/IMG_2.mov', fileName: 'IMG_2.mov', assetId: null }] };
    await pickFromPhotos('p1');
    expect(state.uploads[0]?.uri).toBe(`${ROOT}media/1-IMG_2.mov`);
    expect(await state.deps?.store.lookup('asset-IMG_2.mov')).toMatchObject({ phLocalId: null, fileUri: 'media/1-IMG_2.mov', serverOnly: false });
  });

  it('copies Files imports (video and audio) into Application Support before uploading', async () => {
    state.documents = {
      canceled: false,
      assets: [
        { uri: 'file:///cache/DocumentPicker/take.mov', name: 'take.mov', mimeType: 'video/quicktime' },
        { uri: 'file:///cache/DocumentPicker/song.mp3', name: 'song.mp3', mimeType: 'audio/mpeg' },
      ],
    };
    await pickFromFiles('p1');
    expect(state.uploads.map((upload) => upload.uri).sort()).toEqual([`${ROOT}media/1-take.mov`, `${ROOT}media/2-song.mp3`].sort());
    expect(await state.deps?.store.lookup('asset-song.mp3')).toMatchObject({ fileUri: expect.stringMatching(/^media\/\d-song\.mp3$/) });
  });

  it('keeps the durable copy of a share import and lets the share-extension copy go', async () => {
    const result = await uploadShared('p1', [{ uri: 'file:///group/memo.m4a', name: 'memo.m4a', mimeType: 'audio/x-m4a' }]);
    expect(result.failed).toEqual([]);
    expect(files.has(`${ROOT}media/1-memo.m4a`)).toBe(true);
    expect(state.discarded).toEqual(['file:///group/memo.m4a']);
    expect(await state.deps?.store.lookup('asset-memo.m4a')).toMatchObject({ fileUri: 'media/1-memo.m4a' });
  });

  it('keeps a failed share for a retry and removes the copy made for it', async () => {
    state.failNames.add('memo.m4a');
    const result = await uploadShared('p1', [{ uri: 'file:///group/memo.m4a', name: 'memo.m4a', mimeType: 'audio/x-m4a' }]);
    expect(result.failed).toEqual(['memo.m4a']);
    expect(state.discarded).toEqual([]);
    expect(files.size).toBe(0);
  });

  it('records sticker images and voice-over takes', async () => {
    await uploadMediaFile('p1', { uri: 'file:///cache/sticker.png', name: 'sticker.png', mimeType: 'image/png' }, { kind: 'image', origin: 'photos', phLocalId: 'PH-7' });
    await uploadMediaFile('p1', { uri: 'file:///tmp/take.m4a', name: 'take.m4a', mimeType: 'audio/mp4' }, { kind: 'audio', origin: 'capture' });
    expect(await state.deps?.store.lookup('asset-sticker.png')).toMatchObject({ fileUri: 'media/1-sticker.png', phLocalId: 'PH-7', fingerprint: null });
    expect(await state.deps?.store.lookup('asset-take.m4a')).toMatchObject({ fileUri: 'media/2-take.m4a', fingerprint: 'e1:abcd' });
  });

  it('uploads as before where there is no registry (web, Android)', async () => {
    state.deps = null;
    await uploadShared('p1', [{ uri: 'file:///group/clip.mov', name: 'clip.mov' }]);
    expect(state.uploads).toEqual([{ uri: 'file:///group/clip.mov', name: 'clip.mov' }]);
  });
});

describe('land first', () => {
  const VIDEO = { ...PRINT, geometry: { width: 3840, height: 2160, rotation: 90 } };
  beforeEach(() => {
    state.register = true;
    print = { status: 'ok', fingerprint: VIDEO };
  });

  it('puts the clip on the timeline before its original uploads, with words started on the copy', async () => {
    let release = (): void => undefined;
    state.hold = new Promise((resolve) => { release = resolve; });
    const announced: string[] = [];
    const stop = onImportCompleted((assets) => { announced.push(...assets.map((asset) => asset.id)); });
    state.documents = { canceled: false, assets: [{ uri: 'file:///cache/DocumentPicker/take.mov', name: 'take.mov', mimeType: 'video/quicktime' }] };

    const result = await pickFromFiles('p1');
    stop();
    expect(result).toEqual({ assets: [expect.objectContaining({ id: 'asset-take.mov', duration: 3 })], failed: [] });
    expect(state.uploads).toEqual([]);
    expect(state.registered).toEqual([{ projectId: 'p1', name: 'take.mov', mimeType: 'video/quicktime', duration: 3, width: 3840, height: 2160, hasAudio: true }]);
    // Playable from this phone right away, and announced for words before any byte is sent.
    expect(await state.deps?.store.lookup('asset-take.mov')).toMatchObject({ fileUri: 'media/1-take.mov' });
    expect(announced).toEqual(['asset-take.mov']);
    expect(uploads.get('asset-take.mov')).toMatchObject({ state: 'uploading', projectId: 'p1' });
    expect(await pendingUploads(state.deps!.store)).toEqual([expect.objectContaining({ assetId: 'asset-take.mov', projectId: 'p1' })]);

    release();
    expect(await uploads.settled(['asset-take.mov'])).toBe(true);
    expect(state.originals).toEqual([{ assetId: 'asset-take.mov', projectId: 'p1', uri: `${ROOT}media/1-take.mov` }]);
    expect(uploads.get('asset-take.mov')).toBeUndefined();
    expect(await pendingUploads(state.deps!.store)).toEqual([]);
  });

  it('lands a voice-over take and a share the same way, and lets the share-extension copy go', async () => {
    print = { status: 'ok', fingerprint: PRINT };
    await uploadMediaFile('p1', { uri: 'file:///tmp/take.m4a', name: 'take.m4a', mimeType: 'audio/mp4' }, { kind: 'audio', origin: 'capture' });
    await uploadShared('p1', [{ uri: 'file:///group/memo.m4a', name: 'memo.m4a', mimeType: 'audio/x-m4a' }]);
    expect(state.uploads).toEqual([]);
    expect(state.registered.map((probe) => [probe.name, probe.width, probe.height])).toEqual([['take.m4a', 0, 0], ['memo.m4a', 0, 0]]);
    expect(state.discarded).toEqual(['file:///group/memo.m4a']);
    expect(await uploads.settled(['asset-take.m4a', 'asset-memo.m4a'])).toBe(true);
  });

  it('uploads first without a project, for a still, when the probe fails, and on an older server', async () => {
    await uploadShared(undefined, [{ uri: 'file:///group/a.mov', name: 'a.mov', mimeType: 'video/quicktime' }]);
    await uploadMediaFile('p1', { uri: 'file:///cache/sticker.png', name: 'sticker.png', mimeType: 'image/png' }, { kind: 'image', origin: 'photos' });
    print = { status: 'failed', error: 'unreadable' };
    await uploadShared('p1', [{ uri: 'file:///group/b.mkv', name: 'b.mkv' }]);
    print = { status: 'ok', fingerprint: VIDEO };
    state.register = false;
    await uploadShared('p1', [{ uri: 'file:///group/c.mov', name: 'c.mov', mimeType: 'video/quicktime' }]);
    expect(state.uploads.map((upload) => upload.name)).toEqual(['a.mov', 'sticker.png', 'b.mkv', 'c.mov']);
    expect(state.registered).toEqual([]);
    expect(uploads.entries()).toEqual([]);
  });
});
