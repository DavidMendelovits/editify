import {
  planSyncOps,
  resolveSyncPair,
  type Project,
  type SyncAudioRequest,
  type SyncAudioResult,
} from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import { SyncError, measureSyncFiles, type SyncMeasurement } from '../media/sync.js';

/** Measurements kept in memory: a measure-then-apply round trip must not decode twice. */
const CACHE_LIMIT = 16;
/**
 * Measurements run one at a time (each can hold a few hundred MB of samples),
 * and at most this many are in hand at once, the running one included. Past
 * that the answer is "busy, try again", so a burst of requests queues a little
 * work, not a day of it.
 */
const MAX_WAITING = 4;
/**
 * Measures memo-vs-video sync on the server (decode + shared measureSync) and
 * hands the result to the shared planner, which turns it into timeline edits. It measures against the
 * originals because that is what `render.ts` cuts from, so the offset means
 * exactly what the export will do. When originals stop living on the server,
 * this is the one place that has to switch to the proxy's audio.
 */
export class SyncService {
  private readonly measurements = new Map<string, Promise<SyncMeasurement>>();
  private readonly settled = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(
    private readonly assets: Pick<AssetStore, 'get'>,
    // Not in the shared media pool: a measurement is an audio-only decode plus
    // a few FFTs (~2.5s for a 5-minute set), and queued behind an import's
    // encode and Whisper it waited ~107s (stand-up harness, 2026-10-02). Its
    // memory is already bounded by this class: one measurement at a time,
    // MAX_WAITING in hand.
    private readonly measure: (videoPath: string, memoPath: string) => Promise<SyncMeasurement> = measureSyncFiles,
  ) {}

  /** `userId` scopes asset lookups the way the routes scope projects; undefined is unscoped (agent, tests). */
  async plan(project: Project, request: SyncAudioRequest, userId?: string): Promise<SyncAudioResult> {
    const resolved = resolveSyncPair(project, request, (assetId) => this.assets.get(assetId, userId));
    if (!resolved.ok) return resolved;
    const video = this.assets.get(resolved.pair.videoAsset.id, userId);
    const memo = this.assets.get(resolved.pair.memoAsset.id, userId);
    if (!video || !memo) return { ok: false, error: 'That clip has no media' };
    let measurement: SyncMeasurement;
    try {
      measurement = await this.cachedMeasure(video.id, video.originalPath, memo.id, memo.originalPath);
    } catch (error) {
      if (error instanceof SyncError) return { ok: false, error: error.message };
      throw error;
    }
    return planSyncOps(project, resolved.pair, measurement);
  }

  private async cachedMeasure(videoId: string, videoPath: string, memoId: string, memoPath: string): Promise<SyncMeasurement> {
    const key = `${videoId}\u0000${memoId}`;
    const cached = this.measurements.get(key);
    if (cached) return await cached;
    if (this.waiting >= MAX_WAITING) throw new SyncError('Sync is busy with other recordings. Try again in a moment.');
    this.waiting += 1;
    const pending = this.queue.then(() => this.measure(videoPath, memoPath))
      .finally(() => { this.waiting -= 1; });
    this.queue = pending.catch(() => undefined);
    this.measurements.set(key, pending);
    pending.then(
      () => { this.settled.add(key); this.evict(); },
      // A failure is forgotten so a retry measures again.
      () => { this.measurements.delete(key); this.settled.delete(key); },
    );
    return await pending;
  }

  /** Drop the oldest finished measurements past the limit; a running one is never dropped, so it stays deduplicated. */
  private evict(): void {
    for (const key of this.measurements.keys()) {
      if (this.measurements.size <= CACHE_LIMIT) return;
      if (!this.settled.has(key)) continue;
      this.measurements.delete(key);
      this.settled.delete(key);
    }
  }
}
