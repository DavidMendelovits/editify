import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalMediaStore, migrate, pendingUploads, setPendingUploads, type MediaDeps, type MediaNative, type PendingUpload } from './local-media';
import { createUploadQueue, uploadLabel, type UploadQueueDeps } from './upload-queue';
import { memoryDb } from './test-sqlite';

/*
 * The land-first upload queue: one clip at a time, persisted until it lands, failures kept
 * for a retry, a deleted clip dropped, what a killed app left behind resumed, refusals the
 * server will never change kept on the phone, and each account's uploads kept to itself.
 */
const ROOT = 'file:///support/Editify/';
const PRINT = { duration: 3, bytes: 900, audio: 'e1:abcd', color: 'sdr' as const };

let deps: MediaDeps;
let sent: string[];
/** Asset id → what its next upload does. */
let outcome: Map<string, () => Promise<void>>;
let user: string | null;

function clip(assetId: string): Omit<PendingUpload, 'userId'> {
  return { assetId, projectId: 'p1', kind: 'video', name: `${assetId}.mov` };
}

function refusal(status: number, code?: string): () => Promise<void> {
  return async () => { throw Object.assign(new Error(`refused ${status}`), { status, ...(code ? { code } : {}) }); };
}

function queue(overrides: Partial<UploadQueueDeps> = {}) {
  return createUploadQueue({
    media: async () => deps,
    user: () => user,
    inProgressWaitMs: 1,
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
  user = 'alice';
});

describe('upload queue', () => {
  it('sends one clip at a time in order, and forgets each once it lands', async () => {
    const uploads = queue();
    await uploads.enqueue(clip('a'));
    await uploads.enqueue(clip('b'));
    expect(uploads.entries().map((entry) => entry.assetId)).toEqual(['a', 'b']);
    expect(await pendingUploads(deps.store)).toEqual([{ ...clip('a'), userId: 'alice' }, { ...clip('b'), userId: 'alice' }]);
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
    outcome.set('a', refusal(404));
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

  it('keeps a clip the server will never take on this iPhone, with no retry, across launches', async () => {
    const uploads = queue();
    outcome.set('a', refusal(413));
    outcome.set('b', refusal(409, 'mismatch'));
    await uploads.enqueue(clip('a'));
    await uploads.enqueue(clip('b'));
    expect(await uploads.settled(['a', 'b'])).toBe(false);
    expect(uploadLabel(uploads.get('a')!)).toBe('only on this iPhone');
    expect(uploads.get('a')?.stuck).toContain('2 GB');
    expect(uploads.get('b')?.stuck).toContain('stays on this iPhone only');
    uploads.retry('a');
    expect(uploads.get('a')?.state).toBe('failed');
    // Still pending, so its copy is never evicted, and shown as stuck after a relaunch.
    expect((await pendingUploads(deps.store)).every((upload) => upload.stuck)).toBe(true);
    const relaunched = queue();
    await relaunched.resume();
    expect(relaunched.entries().map((entry) => [entry.assetId, entry.state, Boolean(entry.stuck)])).toEqual([['a', 'failed', true], ['b', 'failed', true]]);
    expect(sent).toEqual([]);
  });

  it('asks again while another upload of the clip is landing, after the clips behind it', async () => {
    const uploads = queue({ inProgressWaitMs: 30 });
    outcome.set('a', async () => { outcome.delete('a'); await refusal(409, 'in_progress')(); });
    await uploads.enqueue(clip('a'));
    await uploads.enqueue(clip('b'));
    expect(await uploads.settled(['a', 'b'])).toBe(true);
    expect(sent).toEqual([`b ${ROOT}media/b.mov`, `a ${ROOT}media/a.mov`]);
  });

  it('starts an account\'s uploads again when it signs back in during the same launch', async () => {
    const uploads = queue();
    await uploads.resume();
    let release = (): void => undefined;
    outcome.set('a', () => new Promise<void>((resolve) => { release = resolve; }));
    await uploads.enqueue(clip('a'));
    await uploads.enqueue(clip('c'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    user = 'bob'; // alice signs out while 'a' is on its way: 'c' waits
    outcome.delete('a');
    release();
    expect(await uploads.settled(['a'])).toBe(true);
    expect(uploads.get('c')?.state).toBe('queued');
    user = 'alice';
    await uploads.resume(); // already read this launch: it still starts her queue
    expect(await uploads.settled(['c'])).toBe(true);
    expect(sent).toEqual([`a ${ROOT}media/a.mov`, `c ${ROOT}media/c.mov`]);
  });

  it('sends only the signed-in account\'s uploads, and resumes each account\'s own', async () => {
    const uploads = queue();
    let release = (): void => undefined;
    outcome.set('a', () => new Promise<void>((resolve) => { release = resolve; }));
    await uploads.enqueue(clip('a'));
    await uploads.enqueue(clip('c')); // alice's, waiting behind 'a'
    await new Promise((resolve) => setTimeout(resolve, 0));
    user = 'bob'; // alice signs out mid-upload, bob signs in
    await uploads.enqueue(clip('b'));
    outcome.delete('a');
    release();
    expect(await uploads.settled(['a', 'b'])).toBe(true);
    // 'a' was already on its way under alice's session; alice's 'c' never goes with bob's.
    expect(sent).toEqual([`a ${ROOT}media/a.mov`, `b ${ROOT}media/b.mov`]);
    expect(uploads.get('c')?.state).toBe('queued');

    // A relaunch signed in as bob leaves alice's saved upload alone; back as alice, it goes.
    const relaunched = queue();
    await relaunched.resume();
    expect(relaunched.entries()).toEqual([]);
    user = 'alice';
    await relaunched.resume();
    expect(await relaunched.settled(['c'])).toBe(true);
    expect(sent).toEqual([`a ${ROOT}media/a.mov`, `b ${ROOT}media/b.mov`, `c ${ROOT}media/c.mov`]);
  });

  it('saves the upload before its registry row is written, and queues nothing when that write fails', async () => {
    const uploads = queue();
    let savedFirst = false;
    await uploads.enqueue(clip('a'), async () => { savedFirst = (await pendingUploads(deps.store)).some((upload) => upload.assetId === 'a'); });
    expect(savedFirst).toBe(true);
    await expect(uploads.enqueue(clip('b'), async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(uploads.get('b')).toBeUndefined();
    expect(await uploads.settled(['a'])).toBe(true);
    expect(await pendingUploads(deps.store)).toEqual([]);
    expect(sent).toEqual([`a ${ROOT}media/a.mov`]);
  });

  it('drops a saved upload whose registry row is gone (its project was deleted)', async () => {
    await setPendingUploads(deps.store, [{ ...clip('gone'), userId: 'alice' }, { ...clip('c'), userId: 'alice' }]);
    const uploads = queue();
    await uploads.resume();
    expect(uploads.entries().map((entry) => entry.assetId)).toEqual(['c']);
    expect(await uploads.settled(['c'])).toBe(true);
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
