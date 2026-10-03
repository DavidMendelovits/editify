/*
 * Sync planning: which memo, which video, and how a measured lag becomes
 * timeline edits (one memo piece per shot cut from that footage). Pure, so the
 * phone plans from its own Swift measurement exactly as the server does.
 *
 *   resolveSyncPair(project, request, assetOf) ──▶ measure (server: ffmpeg + sync.ts,
 *                                                   phone: AudioSync.swift) ──▶ planSyncOps
 */
import {
  clipTimelineDuration,
  operationSchema,
  type Clip,
  type Operation,
  type Project,
  type SyncAudioRequest,
  type SyncAudioResult,
} from './index.js';
import { MAX_SYNC_SECONDS, type SyncMeasurement } from './sync.js';

/** A memo piece shorter than this is a sliver where the recordings barely overlap: not worth a clip. */
const MIN_PIECE_SECONDS = 0.05;
/** `operationBatchSchema` takes at most 100 ops; a sync is applied as one batch. */
const MAX_OPS = 100;
/** Generated pieces are named `<memo clip id>-sync-N`; this recovers the memo clip. */
const PIECE_SUFFIX = /-sync-\d+$/;

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** What planning needs to know about a recording; a stored asset satisfies it. */
export interface SyncAssetInfo { id: string; hasAudio: boolean; duration: number }

export interface SyncPair {
  memoClip: Clip;
  memoTrackId: string;
  memoAsset: SyncAssetInfo;
  videoClip: Clip;
  videoAsset: SyncAssetInfo;
}

type ClipEntry = { clip: Clip; kind: Project['tracks'][number]['kind']; trackId: string };

function entriesOf(project: Project): ClipEntry[] {
  return project.tracks.flatMap((track) => track.clips.map((clip) => ({ clip, kind: track.kind, trackId: track.id })));
}

/** Which memo clip syncs against which video clip, or why none can. */
export function resolveSyncPair(
  project: Project,
  request: SyncAudioRequest,
  assetOf: (assetId: string) => SyncAssetInfo | undefined,
): { ok: true; pair: SyncPair } | { ok: false; error: string } {
    const clips = entriesOf(project);
    const requested = clips.find((entry) => entry.clip.id === request.audioClipId);
    if (!requested) return { ok: false, error: 'That clip is not on the timeline' };
    if (requested.kind !== 'audio') return { ok: false, error: 'Only a clip on the audio track can be synced' };
    // Syncing a generated piece means syncing the memo it came from: the whole
    // set is rebuilt from that clip, never stacked on top of itself.
    const rootId = request.audioClipId.replace(PIECE_SUFFIX, '');
    const memoEntry = clips.find((entry) => entry.clip.id === rootId && entry.kind === 'audio'
      && entry.clip.assetId === requested.clip.assetId) ?? requested;
    const memoClip = memoEntry.clip;
    if (!memoClip.assetId) return { ok: false, error: 'That clip has no media' };
    const memoAsset = assetOf(memoClip.assetId);
    if (!memoAsset?.hasAudio) return { ok: false, error: 'That clip has no audio to sync' };

    const videoClips = clips.filter((entry) => entry.kind === 'video' && entry.clip.assetId).map((entry) => entry.clip);
    let videoClip: Clip | undefined;
    if (request.videoClipId) {
      videoClip = videoClips.find((clip) => clip.id === request.videoClipId);
      if (!videoClip) return { ok: false, error: 'That video clip is not on the timeline' };
    } else {
      videoClip = videoClips
        .filter((clip) => assetOf(clip.assetId as string)?.hasAudio && clip.assetId !== memoClip.assetId)
        .sort((left, right) => clipTimelineDuration(right) - clipTimelineDuration(left))[0];
      if (!videoClip) return { ok: false, error: 'There is no video clip with its own sound to sync against' };
    }
    const videoAsset = assetOf(videoClip.assetId as string);
    if (!videoAsset?.hasAudio) {
      return { ok: false, error: 'That video clip has no sound of its own, so there is nothing to line the memo up against' };
    }
    if (videoAsset.id === memoAsset.id) return { ok: false, error: 'That audio is the video\'s own soundtrack' };
    if (Math.max(videoAsset.duration, memoAsset.duration) > MAX_SYNC_SECONDS) {
      return { ok: false, error: `Sync handles recordings up to ${MAX_SYNC_SECONDS / 3600} hours long` };
    }
    return { ok: true, pair: { memoClip, memoTrackId: memoEntry.trackId, memoAsset, videoClip, videoAsset } };
}

/** Turns a measurement into ops: the memo moves under the first shot, a new piece under each later one. */
export function planSyncOps(project: Project, pair: SyncPair, measurement: SyncMeasurement): SyncAudioResult {
  const { memoClip, memoTrackId, memoAsset, videoClip, videoAsset } = pair;
  const clips = entriesOf(project);
  const videoClips = clips.filter((entry) => entry.kind === 'video' && entry.clip.assetId).map((entry) => entry.clip);
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

    // The pieces a previous sync of this memo generated: replaced, not kept.
    const stale = clips.filter((entry) => entry.kind === 'audio' && entry.clip.id !== memoClip.id
      && entry.clip.id.startsWith(`${memoClip.id}-sync-`) && entry.clip.assetId === memoClip.assetId);
    if (1 + stale.length + rest.length > MAX_OPS) {
      return { ok: false, error: `That footage is cut into ${pieces.length} shots; sync can place at most ${MAX_OPS - 1 - stale.length} at once` };
    }

    const speed = round6(measurement.rate);
    // Stale piece ids are free again, so a re-sync reuses the same names.
    const staleIds = new Set(stale.map((entry) => entry.clip.id));
    const taken = new Set(clips.map((entry) => entry.clip.id).filter((id) => !staleIds.has(id)));
    const nextId = (() => {
      let counter = 0;
      return (): string => {
        let id: string;
        do { counter += 1; id = `${memoClip.id}-sync-${counter}`; } while (taken.has(id));
        taken.add(id);
        return id;
      };
    })();
    const ops: Operation[] = [
      ...stale.map((entry) => operationSchema.parse({ type: 'remove_clip', params: { clipId: entry.clip.id } })),
      operationSchema.parse({
        type: 'set_clip_properties',
        params: { updates: [{ clipId: memoClip.id, start: first.start, in: first.in, out: first.out, speed }] },
      }),
    ];
    for (const piece of rest) {
      ops.push(operationSchema.parse({
        type: 'add_clip',
        params: {
          trackId: memoTrackId,
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
      version: project.version,
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
