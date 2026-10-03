import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { faceAt, faceTrackSchema, type FaceBox, type FaceTrack } from '@editify/shared';
import { dataRoot } from '../config.js';
import type { StoredAsset } from '../db/asset-store.js';
import type { EditifyDatabase } from '../db/database.js';

const FACE_TRACK_TIMEOUT_MS = 5 * 60 * 1000;
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/face_track.py');
const defaultModelPath = join(dataRoot, 'models', 'face_detection_yunet_2023mar.onnx');

export { faceAt, faceTrackSchema, type FaceBox, type FaceTrack };

export type FaceTrackRunner = (mediaPath: string) => Promise<FaceTrack>;

export function runFaceTrack(mediaPath: string): Promise<FaceTrack> {
  const python = process.env.PYTHON_BIN ?? 'python3';
  const model = process.env.FACE_MODEL_PATH ?? defaultModelPath;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [scriptPath, mediaPath, model], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error: Error | undefined, track?: FaceTrack): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(track as FaceTrack);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Face tracking timed out after ${FACE_TRACK_TIMEOUT_MS / 1000} seconds`));
    }, FACE_TRACK_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(`Face tracking exited with ${code}: ${stderr.trim().slice(-2000)}`));
        return;
      }
      try {
        finish(undefined, faceTrackSchema.parse(JSON.parse(stdout)));
      } catch (error) {
        finish(new Error(`Invalid face tracking output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

/**
 * Where the speaker's face is in each source video, for caption placement.
 * Cached per asset like dissections: tracking is a few seconds of OpenCV per
 * minute of video, and the answer never changes. A failed run is not cached,
 * so an install that gains OpenCV later starts working without a re-import.
 */
export class FaceService {
  private readonly inFlight = new Map<string, Promise<FaceTrack>>();

  constructor(
    private readonly database: EditifyDatabase,
    private readonly runner: FaceTrackRunner = runFaceTrack,
  ) {}

  get(assetId: string): FaceTrack | undefined {
    const row = this.database.prepare('SELECT track_json FROM face_tracks WHERE asset_id = ?')
      .get(assetId) as { track_json: string } | undefined;
    return row ? faceTrackSchema.parse(JSON.parse(row.track_json)) : undefined;
  }

  async getOrCreate(asset: StoredAsset): Promise<FaceTrack> {
    const existing = this.get(asset.id);
    if (existing) return existing;
    // Uploads can arrive as application/octet-stream, so "has a picture and is not a still" is the test.
    if (!(asset.width > 0 && asset.height > 0) || asset.mimeType.startsWith('image/')) {
      throw new Error(`Asset ${asset.id} is not a video`);
    }
    const pending = this.inFlight.get(asset.id) ?? this.runner(asset.originalPath)
      .then((track) => {
        this.database.prepare(`
          INSERT INTO face_tracks (asset_id, track_json, created_at) VALUES (?, ?, ?)
          ON CONFLICT(asset_id) DO UPDATE SET track_json = excluded.track_json, created_at = excluded.created_at
        `).run(asset.id, JSON.stringify(track), new Date().toISOString());
        return track;
      })
      .finally(() => this.inFlight.delete(asset.id));
    this.inFlight.set(asset.id, pending);
    return await pending;
  }

  /** Never throws: placement without a face track still keeps captions in the safe area. */
  async tryGet(asset: StoredAsset | undefined): Promise<FaceTrack | undefined> {
    if (!asset) return undefined;
    try {
      return await this.getOrCreate(asset);
    } catch {
      return undefined;
    }
  }
}
