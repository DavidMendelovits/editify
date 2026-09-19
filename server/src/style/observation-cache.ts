import type { EditifyDatabase } from '../db/database.js';
import { videoObservationSchema, type VideoObservation } from './observation.js';

/**
 * Observations keyed by asset and analyzer version. Watching a video is the
 * expensive step of the workflow, so a second profile built from the same
 * clips (or a rerun after a crash halfway through) reuses the rows rather
 * than paying for the model again. A bumped analyzer version misses on purpose.
 */
export class ObservationCache {
  constructor(private readonly database: EditifyDatabase) {}

  get(assetId: string, analyzerId: string, version: string): VideoObservation | undefined {
    const row = this.database.prepare(
      'SELECT observation_json FROM video_observations WHERE asset_id = ? AND analyzer = ? AND analyzer_version = ?',
    ).get(assetId, analyzerId, version) as { observation_json: string } | undefined;
    if (!row) return undefined;
    const parsed = videoObservationSchema.safeParse(JSON.parse(row.observation_json));
    return parsed.success ? parsed.data : undefined;
  }

  put(observation: VideoObservation, version: string): void {
    this.database.prepare(`
      INSERT INTO video_observations (asset_id, analyzer, analyzer_version, observation_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(asset_id, analyzer, analyzer_version) DO UPDATE SET observation_json = excluded.observation_json, created_at = excluded.created_at
    `).run(observation.assetId, observation.analyzer, version, JSON.stringify(observation), new Date().toISOString());
  }

  /** Drops every row for an asset, for when the upload itself is deleted. */
  forget(assetId: string): void {
    this.database.prepare('DELETE FROM video_observations WHERE asset_id = ?').run(assetId);
  }
}
