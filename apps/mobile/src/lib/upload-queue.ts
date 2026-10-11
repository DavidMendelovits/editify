/**
 * Originals on their way to the server after a land-first import (pick.ts): the clip is
 * already on the timeline and plays from this phone, and this sends its original behind it,
 * one clip at a time, tied to no screen. Free of React Native: the registry and the upload
 * are passed in (uploads.ts wires the real ones), so every branch runs under vitest.
 *
 *   enqueue ─▶ pendingUploads (registry meta: its copy is never evicted) ─▶ the registry row
 *     (`commit`, run only once the entry is saved) ─▶ 'queued' ─▶ 'uploading' ─▶ uploadMissing
 *     for that one clip (the app copy as it is, a Photos original through a temporary file, an
 *     iCloud one downloaded first; leased meanwhile)
 *        ├─ sent ─▶ gone from the queue and from pendingUploads
 *        ├─ 404 (the clip or its project was deleted) ─▶ dropped quietly
 *        ├─ 409 in_progress (another upload of it is landing) ─▶ to the back of the queue, sent
 *        │     again after a pause (the rest go meanwhile); the server answers 200 once that one landed
 *        ├─ 409 mismatch or 413 (the server will never take it) ─▶ 'failed' and `stuck`: no
 *        │     retry, the clip stays on this iPhone only and its copy is kept
 *        └─ failed otherwise ─▶ 'failed' with the reason, still in pendingUploads; retry() sends it again
 *
 * Each entry belongs to the account that imported it: only the signed-in account's uploads
 * are sent, so another account's token never meets them. If the app dies mid-upload, the entry
 * stays in pendingUploads: resume() (the editor calls it) sends it again, and its copy is kept
 * meanwhile; one whose registry row is gone (its project was deleted) is dropped then. Should a
 * resume never happen, the export's server path finds the original missing (serverReadiness)
 * and offers the same upload.
 */
import { pendingUploads, setPendingUploads, type MediaDeps, type PendingUpload } from './local-media';
import { uploadMissing, type OriginalFile } from './device-export';
import type { ImportProgress } from './upload-progress';

export interface UploadEntry extends PendingUpload {
  state: 'queued' | 'uploading' | 'failed';
  progress?: ImportProgress | undefined;
  error?: string | undefined;
  /** Not sent again before this time (ms): another upload of the clip was landing. */
  notBefore?: number | undefined;
}

export interface UploadQueueDeps {
  media: () => Promise<MediaDeps | null>;
  /** PUT /assets/:id/original for `entry`; rejects with the server's refusal ({ status, code }). */
  upload: (entry: PendingUpload, file: OriginalFile, onBytes: (sent: number, expected: number) => void, signal?: AbortSignal) => Promise<void>;
  /** The signed-in account (null: none, or the shared token). */
  user: () => string | null;
  now?: () => number;
  /** How long to wait before asking again while another upload of the clip lands. */
  inProgressWaitMs?: number;
}

export interface UploadQueue {
  /**
   * Saves the upload (for the signed-in account), runs `commit` (the registry row) only once it
   * is saved, then starts it after any ahead of it. When `commit` throws, nothing is queued and
   * the error is rethrown. An id already queued is left as it is.
   */
  enqueue(upload: Omit<PendingUpload, 'userId'>, commit?: () => Promise<void>): Promise<void>;
  /** A failed upload goes again; a stuck one or anything else is left as it is. */
  retry(assetId: string): void;
  /** Queues what the signed-in account left unsent (read once per launch and account), and starts the queue. */
  resume(): Promise<void>;
  get(assetId: string): UploadEntry | undefined;
  /** The same array until something changes (for useSyncExternalStore). */
  entries(): readonly UploadEntry[];
  subscribe(listener: () => void): () => void;
  /** Resolves once none of `assetIds` is queued or uploading: true when none of them failed either. */
  settled(assetIds: readonly string[]): Promise<boolean>;
}

/** Progress lands on React state, and a native upload reports every chunk. */
const PROGRESS_INTERVAL_MS = 250;
const IN_PROGRESS_WAIT_MS = 5000;

/** Why the server will never take this original, said plainly; undefined when a retry may work. */
function stuckReason(refused: unknown): string | undefined {
  const { status, code } = (refused ?? {}) as { status?: number; code?: string };
  if (status === 413) return 'It is over the 2 GB upload limit, so it stays on this iPhone only. Editing and exporting here still work.';
  if (status === 409 && code === 'mismatch') return 'The server could not read it as the same clip, so it stays on this iPhone only. Editing and exporting here still work.';
  return undefined;
}

export function createUploadQueue(deps: UploadQueueDeps): UploadQueue {
  const now = deps.now ?? Date.now;
  let entries: readonly UploadEntry[] = [];
  const listeners = new Set<() => void>();
  let running = false;
  /** Accounts resumed this launch. */
  const resumed = new Map<string | null, Promise<void>>();
  /** Saved but not committed yet: not sent until the registry row exists. */
  const held = new Set<string>();
  /** Registry writes, one after another: each reads the list it changes. */
  let writes: Promise<void> = Promise.resolve();

  const publish = (next: readonly UploadEntry[]): void => {
    entries = next;
    for (const listener of listeners) listener();
  };
  const update = (assetId: string, patch: Partial<UploadEntry>): void => {
    publish(entries.map((entry) => (entry.assetId === assetId ? { ...entry, ...patch } : entry)));
  };
  /** Rejects when the write fails; the chain itself carries on. */
  const persist = (change: (list: PendingUpload[]) => PendingUpload[]): Promise<void> => {
    const write = writes.then(async () => {
      const media = await deps.media();
      if (media) await setPendingUploads(media.store, change(await pendingUploads(media.store)));
    });
    writes = write.catch(() => undefined);
    return write;
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const forget = async (assetId: string): Promise<void> => {
    await persist((list) => list.filter((upload) => upload.assetId !== assetId)).catch(() => undefined);
    publish(entries.filter((entry) => entry.assetId !== assetId));
  };
  const toUpload = ({ state: _state, progress: _progress, error: _error, notBefore: _notBefore, ...upload }: UploadEntry): PendingUpload => upload;

  const send = async (entry: UploadEntry): Promise<void> => {
    const { assetId } = entry;
    update(assetId, { state: 'uploading', error: undefined, progress: undefined });
    const media = await deps.media();
    if (!media) {
      update(assetId, { state: 'failed', error: 'This iPhone has no media registry' });
      return;
    }
    let refused: unknown;
    let reported = 0;
    const result = await uploadMissing({
      clips: [{ assetId, kind: entry.kind, name: entry.name }],
      deps: media,
      upload: async (file, onBytes, signal) => {
        try {
          await deps.upload(toUpload(entry), file, onBytes, signal);
        } catch (error) {
          refused = error;
          throw error;
        }
      },
      onProgress: (progress) => {
        if (now() - reported < PROGRESS_INTERVAL_MS && progress.done === 0) return;
        reported = now();
        update(assetId, { progress });
      },
    });
    const { status, code } = (refused ?? {}) as { status?: number; code?: string };
    // Only the signed-in owner's uploads are sent, so a 404 means the clip itself is gone.
    if (result.uploaded.length > 0 || status === 404) return await forget(assetId);
    if (status === 409 && code === 'in_progress') {
      // To the back of the queue, so the clips behind it don't wait on another upload of it.
      const waited = { ...entry, state: 'queued' as const, progress: undefined, error: undefined, notBefore: now() + (deps.inProgressWaitMs ?? IN_PROGRESS_WAIT_MS) };
      publish([...entries.filter((item) => item.assetId !== assetId), waited]);
      return;
    }
    const stuck = stuckReason(refused);
    if (stuck) {
      await persist((list) => list.map((upload) => (upload.assetId === assetId ? { ...upload, stuck } : upload))).catch(() => undefined);
      update(assetId, { state: 'failed', error: stuck, stuck });
      return;
    }
    update(assetId, { state: 'failed', error: result.failed[0]?.error ?? 'The upload failed' });
  };

  const sendable = (entry: UploadEntry): boolean => entry.state === 'queued' && !held.has(entry.assetId) && entry.userId === deps.user();
  const next = (): UploadEntry | undefined => entries.find((entry) => sendable(entry) && (entry.notBefore ?? 0) <= now());
  let wake: ReturnType<typeof setTimeout> | undefined;
  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (let entry = next(); entry; entry = next()) {
        const current = entry;
        await send(current).catch((error: unknown) => {
          update(current.assetId, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
        });
      }
    } finally {
      running = false;
    }
    // Only clips waiting out another upload of themselves are left: come back when the first may go.
    const waiting = entries.filter(sendable).map((entry) => entry.notBefore ?? 0);
    if (waiting.length > 0 && !wake) {
      wake = setTimeout(() => { wake = undefined; void pump(); }, Math.max(0, Math.min(...waiting) - now()));
    }
  };

  const add = (upload: PendingUpload): void => {
    if (entries.some((entry) => entry.assetId === upload.assetId)) return;
    publish([...entries, upload.stuck ? { ...upload, state: 'failed', error: upload.stuck } : { ...upload, state: 'queued' }]);
  };

  return {
    async enqueue(input, commit) {
      const upload: PendingUpload = { ...input, userId: deps.user() };
      held.add(upload.assetId);
      add(upload);
      try {
        await persist((list) => (list.some((item) => item.assetId === upload.assetId) ? list : [...list, upload]));
        await commit?.();
      } catch (error) {
        await forget(upload.assetId);
        held.delete(upload.assetId);
        throw error;
      }
      held.delete(upload.assetId);
      void pump();
    },

    retry(assetId) {
      const entry = entries.find((item) => item.assetId === assetId);
      if (entry?.state !== 'failed' || entry.stuck) return;
      update(assetId, { state: 'queued', error: undefined, notBefore: undefined });
      void pump();
    },

    resume() {
      const user = deps.user();
      let pending = resumed.get(user);
      if (!pending) {
        pending = (async () => {
          const media = await deps.media();
          if (!media) return;
          for (const upload of await pendingUploads(media.store)) {
            if (upload.userId !== user || entries.some((entry) => entry.assetId === upload.assetId)) continue;
            // Its row went with its project (forgetMedia): there is nothing left to send.
            if (!(await media.store.lookup(upload.assetId))) {
              await persist((list) => list.filter((item) => item.assetId !== upload.assetId)).catch(() => undefined);
              continue;
            }
            add(upload);
          }
        })().catch(() => undefined);
        resumed.set(user, pending);
      }
      // Every time, not only the first: back on an account in the same launch, its uploads go again.
      return pending.then(() => { void pump(); });
    },

    get: (assetId) => entries.find((entry) => entry.assetId === assetId),
    entries: () => entries,
    subscribe,

    settled(assetIds) {
      const ids = new Set(assetIds);
      const check = (): boolean | undefined => {
        const mine = entries.filter((entry) => ids.has(entry.assetId));
        if (mine.some((entry) => entry.state !== 'failed')) return undefined;
        return mine.length === 0;
      };
      const answer = check();
      if (answer !== undefined) return Promise.resolve(answer);
      return new Promise((resolve) => {
        const stop = subscribe(() => {
          const settled = check();
          if (settled === undefined) return;
          stop();
          resolve(settled);
        });
      });
    },
  };
}

/** "uploading 34%", "waiting to upload", "upload failed", "only on this iPhone". */
export function uploadLabel(entry: UploadEntry): string {
  if (entry.stuck) return 'only on this iPhone';
  if (entry.state === 'failed') return 'upload failed';
  if (entry.state === 'queued') return 'waiting to upload';
  const progress = entry.progress;
  if (!progress || progress.totalBytes <= 0) return 'uploading';
  return `uploading ${Math.floor(Math.min(1, progress.sentBytes / progress.totalBytes) * 100)}%`;
}
