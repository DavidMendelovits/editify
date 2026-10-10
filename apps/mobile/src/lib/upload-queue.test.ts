import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalMediaStore, migrate, pendingUploads, type MediaDeps, type MediaNative, type PendingUpload } from './local-media';
import { createUploadQueue, uploadLabel, type UploadQueueDeps } from './upload-queue';
import { memoryDb } from './test-sqlite';

/*
 * The land-first upload queue: one clip at a time, persisted until it lands, failures kept
 * for a retry, a deleted clip dropped, and what a killed app left behind resumed.
 */
const ROOT = 'file:///support/Editify/';
const PRINT = { duration: 3, bytes: 900, audio: 'e1:abcd', color: 'sdr' as const };

let deps: MediaDeps;
let sent: string[];
/** Asset id → what its next upload does. */
let outcome: Map<string, () => Promise<void>>;

function clip(assetId: string): PendingUpload {
  return { assetId, projectId: 'p1', kind: 'video', name: `${assetId}.mov` };
}

function queue(overrides: Partial<UploadQueueDeps> = {}) {
  return createUploadQueue({
    media: async () => deps,
    upload: async (entry, file, onBytes) => {
      onBytes(450, 900);
      await (outcome.get(entry.assetId) ?? (async () => undefined))();
      sent.push(`${entry.assetId} ${file.uri}`);
    },
    ...overrides,
  });
}

beforeEach(async () => {
  const db = memoryDb();
  await migrate(db);
  const files = new Set<string>();
  const native = {
    probe: async () => ({ status: 'ok', fingerprint: PRINT }),
    mediaRoot: () => ROOT,
    fileExists: (uri: string) => files.has(uri),
    removeFile: () => undefined,
  } as unknown as MediaNative;
  deps = { store: createLocalMediaStore(db), native };
  for (const id of ['a', 'b', 'c']) {
    files.add(`${ROOT}media/${id}.mov`);
    await deps.store.record({ assetId: id, fileUri: `media/${id}.mov`, fileBytes: 900, fingerprint: PRINT });
  }
  sent = [];
  outcome = new Map();
});

describe('upload queue', () => {
  it('sends one clip at a time in order, and forgets each once it lands', async () => {
    const uploads = queue();
    await uploads.enqueue(clip('a'));
    await uploads.enqueue(clip('b'));
    expect(uploads.entries().map((entry) => entry.assetId)).toEqual(['a', 'b']);
    expect((await pendingUploads(deps.store)).map((upload) => upload.assetId)).toEqual(['a', 'b']);
    expect(await uploads.settled(['a', 'b'])).toBe(true);
    expect(sent).toEqual([`a ${ROOT}media/a.mov`, `b ${ROOT}media/b.mov`]);
    expect(uploads.entries()).toEqual([]);
    expect(await pendingUploads(deps.store)).toEqual([]);
  });

  it('keeps a failure (and its pending record) for a retry', async () => {
    const uploads = queue();
    outcome.set('a', async () => { throw new Error('The network connection was lost.'); });
    await uploads.enqueue(clip('a'));
    expect(await uploads.settled(['a'])).toBe(false);
    expect(uploads.get('a')).toMatchObject({ state: 'failed', error: 'The network connection was lost.' });
    expect(uploadLabel(uploads.get('a')!)).toBe('upload failed');
    expect((await pendingUploads(deps.store)).map((upload) => upload.assetId)).toEqual(['a']);

    outcome.delete('a');
    uploads.retry('a');
    expect(uploads.get('a')?.state).not.toBe('failed');
    expect(await uploads.settled(['a'])).toBe(true);
    expect(sent).toEqual([`a ${ROOT}media/a.mov`]);
  });

  it('drops a clip the server no longer has (deleted project or asset) without calling it a failure', async () => {
    const uploads = queue();
    outcome.set('a', async () => { throw Object.assign(new Error('Asset not found'), { status: 404 }); });
    await uploads.enqueue(clip('a'));
    expect(await uploads.settled(['a'])).toBe(true);
    expect(uploads.get('a')).toBeUndefined();
    expect(await pendingUploads(deps.store)).toEqual([]);
  });

  it('says where a clip stands while it waits and uploads', async () => {
    let release = (): void => undefined;
    outcome.set('a', () => new Promise<void>((resolve) => { release = resolve; }));
    let clock = 0;
    const uploads = queue({ now: () => (clock += 1000) });
    await uploads.enqueue(clip('a'));
    await uploads.enqueue(clip('b'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploadLabel(uploads.get('a')!)).toBe('uploading 50%');
    expect(uploadLabel(uploads.get('b')!)).toBe('waiting to upload');
    release();
    expect(await uploads.settled(['a', 'b'])).toBe(true);
  });

  it('resumes what a killed app left unsent, once, alongside new imports', async () => {
    // The process dies mid-upload: this queue's transfer never ends.
    const killed = queue({ upload: () => new Promise<void>(() => undefined) });
    await killed.enqueue(clip('a'));

    const relaunched = queue();
    await relaunched.enqueue(clip('c'));
    await relaunched.resume();
    await relaunched.resume();
    expect(relaunched.entries().map((entry) => entry.assetId)).toEqual(['c', 'a']);
    expect(await relaunched.settled(['a', 'c'])).toBe(true);
    expect(sent).toEqual([`c ${ROOT}media/c.mov`, `a ${ROOT}media/a.mov`]);
    expect(await pendingUploads(deps.store)).toEqual([]);
  });

  it('fails plainly when the clip is no longer on this iPhone', async () => {
    await deps.store.dropCopy('b', 'file-missing');
    const uploads = queue();
    await uploads.enqueue(clip('b'));
    expect(await uploads.settled(['b'])).toBe(false);
    expect(uploads.get('b')).toMatchObject({ state: 'failed', error: 'It isn\'t on this iPhone' });
  });
});
