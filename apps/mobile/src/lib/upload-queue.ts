/**
 * Originals on their way to the server after a land-first import (pick.ts): the clip is
 * already on the timeline and plays from this phone, and this sends its original behind it,
 * one clip at a time, tied to no screen. Free of React Native: the registry and the upload
 * are passed in (uploads.ts wires the real ones), so every branch runs under vitest.
 *
 *   enqueue ─▶ pendingUploads (registry meta: its copy is never evicted) ─▶ 'queued'
 *     ─▶ 'uploading' ─▶ uploadMissing for that one clip (the app copy as it is, a Photos
 *        original through a temporary file, an iCloud one downloaded first; leased meanwhile)
 *        ├─ sent ─▶ gone from the queue and from pendingUploads
 *        ├─ 404 (the clip or its project was deleted) ─▶ dropped quietly
 *        └─ failed ─▶ 'failed' with the reason, still in pendingUploads; retry() sends it again
 *
 * If the app dies mid-upload, the entry stays in pendingUploads: resume() (the editor calls it)
 * sends it again, and its copy is kept meanwhile. Should that never happen, the export's server
 * path finds the original missing (serverReadiness) and offers the same upload, so the clip
 * is never lost.
 */
import { pendingUploads, setPendingUploads, type MediaDeps, type PendingUpload } from './local-media';
import { uploadMissing, type OriginalFile } from './device-export';
import type { ImportProgress } from './upload-progress';

export interface UploadEntry extends PendingUpload {
  state: 'queued' | 'uploading' | 'failed';
  progress?: ImportProgress | undefined;
  error?: string | undefined;
}

export interface UploadQueueDeps {
  media: () => Promise<MediaDeps | null>;
  /** PUT /assets/:id/original for `entry`; rejects with the server's refusal. */
  upload: (entry: PendingUpload, file: OriginalFile, onBytes: (sent: number, expected: number) => void, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface UploadQueue {
  /** Persists the upload and starts it (after any ahead of it). An id already queued is left as it is. */
  enqueue(upload: PendingUpload): Promise<void>;
  /** A failed upload goes again; anything else is left as it is. */
  retry(assetId: string): void;
  /** Once per launch: queues what a previous launch left unsent. */
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

export function createUploadQueue(deps: UploadQueueDeps): UploadQueue {
  const now = deps.now ?? Date.now;
  let entries: readonly UploadEntry[] = [];
  const listeners = new Set<() => void>();
  let running = false;
  let resumed: Promise<void> | undefined;
  /** Registry writes, one after another: each reads the list it changes. */
  let writes: Promise<void> = Promise.resolve();

  const publish = (next: readonly UploadEntry[]): void => {
    entries = next;
    for (const listener of listeners) listener();
  };
  const update = (assetId: string, patch: Partial<UploadEntry>): void => {
    publish(entries.map((entry) => (entry.assetId === assetId ? { ...entry, ...patch } : entry)));
  };
  const persist = (change: (list: PendingUpload[]) => PendingUpload[]): Promise<void> => {
    writes = writes.then(async () => {
      const media = await deps.media();
      if (media) await setPendingUploads(media.store, change(await pendingUploads(media.store)));
    }).catch(() => undefined);
    return writes;
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const finish = async (assetId: string): Promise<void> => {
    await persist((list) => list.filter((upload) => upload.assetId !== assetId));
    publish(entries.filter((entry) => entry.assetId !== assetId));
  };

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
          await deps.upload(entry, file, onBytes, signal);
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
    if (result.uploaded.length > 0 || (refused as { status?: number } | undefined)?.status === 404) {
      await finish(assetId);
      return;
    }
    update(assetId, { state: 'failed', error: result.failed[0]?.error ?? 'The upload failed' });
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (let next = entries.find((entry) => entry.state === 'queued'); next; next = entries.find((entry) => entry.state === 'queued')) {
        await send(next).catch((error: unknown) => {
          update((next as UploadEntry).assetId, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
        });
      }
    } finally {
      running = false;
    }
  };

  const add = (upload: PendingUpload): void => {
    if (entries.some((entry) => entry.assetId === upload.assetId)) return;
    publish([...entries, { ...upload, state: 'queued' }]);
  };

  return {
    async enqueue(upload) {
      add(upload);
      await persist((list) => (list.some((item) => item.assetId === upload.assetId) ? list : [...list, upload]));
      void pump();
    },

    retry(assetId) {
      if (entries.find((entry) => entry.assetId === assetId)?.state !== 'failed') return;
      update(assetId, { state: 'queued', error: undefined });
      void pump();
    },

    resume() {
      resumed ??= (async () => {
        const media = await deps.media();
        if (!media) return;
        for (const upload of await pendingUploads(media.store)) add(upload);
        void pump();
      })().catch(() => undefined);
      return resumed;
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

/** "uploading 34%", "waiting to upload", "upload failed". */
export function uploadLabel(entry: UploadEntry): string {
  if (entry.state === 'failed') return 'upload failed';
  if (entry.state === 'queued') return 'waiting to upload';
  const progress = entry.progress;
  if (!progress || progress.totalBytes <= 0) return 'uploading';
  return `uploading ${Math.floor(Math.min(1, progress.sentBytes / progress.totalBytes) * 100)}%`;
}
