import {
  clipTimelineDuration,
  operationSchema,
  type Clip,
  type Operation,
  type Project,
  type SyncAudioRequest,
  type SyncAudioResult,
} from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import { SyncError, measureSyncFiles, type SyncMeasurement } from '../media/sync.js';

/** A memo piece shorter than this is a sliver where the recordings barely overlap: not worth a clip. */
const MIN_PIECE_SECONDS = 0.05;
/** Measurements kept in memory: a measure-then-apply round trip must not decode twice. */
const CACHE_LIMIT = 16;

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Turns a sync measurement into timeline edits. It measures against the
 * originals because that is what `render.ts` cuts from, so the offset means
 * exactly what the export will do. When originals stop living on the server,
 * this is the one place that has to switch to the proxy's audio.
 */
export class SyncService {
  private readonly measurements = new Map<string, Promise<SyncMeasurement>>();

  constructor(
    private readonly assets: Pick<AssetStore, 'get'>,
    private readonly measure: (videoPath: string, memoPath: string) => Promise<SyncMeasurement> = measureSyncFiles,
  ) {}

  async plan(project: Project, request: SyncAudioRequest): Promise<SyncAudioResult> {
    const clips = project.tracks.flatMap((track) => track.clips.map((clip) => ({ clip, kind: track.kind, trackId: track.id })));
    const memoEntry = clips.find((entry) => entry.clip.id === request.audioClipId);
    if (!memoEntry) return { ok: false, error: `Clip ${request.audioClipId} was not found` };
    if (memoEntry.kind !== 'audio') return { ok: false, error: `Clip ${request.audioClipId} is not on an audio track` };
    const memoClip = memoEntry.clip;
    if (!memoClip.assetId) return { ok: false, error: `Clip ${memoClip.id} has no media` };
    const memoAsset = this.assets.get(memoClip.assetId);
    if (!memoAsset?.hasAudio) return { ok: false, error: `Clip ${memoClip.id} has no audio to sync` };

    const videoClips = clips.filter((entry) => entry.kind === 'video' && entry.clip.assetId).map((entry) => entry.clip);
    let videoClip: Clip | undefined;
    if (request.videoClipId) {
      videoClip = videoClips.find((clip) => clip.id === request.videoClipId);
      if (!videoClip) return { ok: false, error: `Video clip ${request.videoClipId} was not found` };
    } else {
      videoClip = videoClips
        .filter((clip) => this.assets.get(clip.assetId as string)?.hasAudio && clip.assetId !== memoClip.assetId)
        .sort((left, right) => clipTimelineDuration(right) - clipTimelineDuration(left))[0];
      if (!videoClip) return { ok: false, error: 'There is no video clip with its own sound to sync against' };
    }
    const videoAsset = this.assets.get(videoClip.assetId as string);
    if (!videoAsset?.hasAudio) {
      return { ok: false, error: `Video clip ${videoClip.id} has no sound of its own, so there is nothing to line the memo up against` };
    }
    if (videoAsset.id === memoAsset.id) return { ok: false, error: 'That audio is the video\'s own soundtrack' };

    let measurement: SyncMeasurement;
    try {
      measurement = await this.cachedMeasure(videoAsset.id, videoAsset.originalPath, memoAsset.id, memoAsset.originalPath);
    } catch (error) {
      if (error instanceof SyncError) return { ok: false, error: error.message };
      throw error;
    }
    if (!measurement.confident) {
      return {
        ok: false,
        error: 'Could not find where these recordings line up. They may not be of the same moment, or the video\'s own sound is too faint to match.',
      };
    }

    // memo(v): memo source seconds heard at video source second v.
    const memoAt = (videoSeconds: number): number =>
      measurement.anchor - measurement.lag + measurement.rate * (videoSeconds - measurement.anchor);
    const notes: string[] = [];
    const pieces: Array<{ start: number; in: number; out: number }> = [];
    // Every clip cut from the same footage gets its own piece, so syncing after
    // a cleanup pass still covers every surviving shot.
    const siblings = videoClips
      .filter((clip) => clip.assetId === videoAsset.id)
      .sort((left, right) => left.start - right.start);
    for (const clip of siblings) {
      if ((clip.speed ?? 1) !== 1) {
        notes.push(`Skipped ${clip.id}: it plays at ${clip.speed}×, and a sped-up shot cannot hold synced sound.`);
        continue;
      }
      let start = clip.start;
      let sourceIn = memoAt(clip.in);
      let sourceOut = memoAt(clip.out);
      if (sourceIn < 0) {
        // The memo was not rolling yet: its piece starts partway into the shot.
        start += -sourceIn / measurement.rate;
        sourceIn = 0;
      }
      sourceOut = Math.min(sourceOut, memoAsset.duration);
      if (sourceOut - sourceIn < MIN_PIECE_SECONDS) {
        notes.push(`Skipped ${clip.id}: the memo was not recording during that shot.`);
        continue;
      }
      pieces.push({ start: round6(start), in: round6(sourceIn), out: round6(sourceOut) });
    }
    const [first, ...rest] = pieces;
    if (!first) return { ok: false, error: 'The memo does not overlap any of that video\'s shots on the timeline' };

    const speed = round6(measurement.rate);
    const taken = new Set(clips.map((entry) => entry.clip.id));
    const nextId = (() => {
      let counter = 0;
      return (): string => {
        let id: string;
        do { counter += 1; id = `${memoClip.id}-sync-${counter}`; } while (taken.has(id));
        taken.add(id);
        return id;
      };
    })();
    const ops: Operation[] = [operationSchema.parse({
      type: 'set_clip_properties',
      params: { updates: [{ clipId: memoClip.id, start: first.start, in: first.in, out: first.out, speed }] },
    })];
    for (const piece of rest) {
      ops.push(operationSchema.parse({
        type: 'add_clip',
        params: {
          trackId: memoEntry.trackId,
          clip: {
            id: nextId(),
            assetId: memoAsset.id,
            ...piece,
            speed,
            volume: memoClip.volume ?? 1,
            ...(memoClip.duck ? { duck: true } : {}),
          },
        },
      }));
    }
    if (measurement.rate !== 1 && measurement.driftSec !== undefined) {
      notes.push(`The two recorders' clocks drift ${Math.abs(measurement.driftSec * 1000).toFixed(0)}ms apart over the set; the memo plays at ${speed}× to stay locked.`);
    }
    return {
      ok: true,
      ops,
      videoClipId: videoClip.id,
      // Where memoAt(v) = 0; just the lag when the clocks agree.
      offsetSec: round6(measurement.anchor - (measurement.anchor - measurement.lag) / measurement.rate),
      speed,
      ...(measurement.driftSec === undefined ? {} : { driftMs: Math.round(measurement.driftSec * 1000) }),
      confidence: Math.round(measurement.fineScore * 10) / 10,
      pieces: pieces.length,
      notes,
    };
  }

  private async cachedMeasure(videoId: string, videoPath: string, memoId: string, memoPath: string): Promise<SyncMeasurement> {
    const key = `${videoId}\u0000${memoId}`;
    const cached = this.measurements.get(key);
    if (cached) return await cached;
    const pending = this.measure(videoPath, memoPath);
    this.measurements.set(key, pending);
    if (this.measurements.size > CACHE_LIMIT) this.measurements.delete(this.measurements.keys().next().value as string);
    pending.catch(() => this.measurements.delete(key));
    return await pending;
  }
}
