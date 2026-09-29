import type { EditifyDatabase } from '../../src/db/database.js';

/**
 * Gives a project the media its test timeline names: `project_assets` is the
 * grant `applyOperations` checks. A placeholder id gets a bare asset row first;
 * an asset the test already inserted is left as it is, so call this after.
 */
export function grant(database: EditifyDatabase, projectId: string, ...assetIds: string[]): void {
  const now = new Date().toISOString();
  for (const id of assetIds) {
    database.prepare(`
      INSERT OR IGNORE INTO assets
        (id, original_name, mime_type, duration, width, height, fps, has_audio, original_path, proxy_path, thumbnail_path, created_at)
      VALUES (?, ?, 'video/mp4', 1, 10, 10, 30, 0, '/x', '/x', '/x', ?)
    `).run(id, `${id}.mp4`, now);
    database.prepare('INSERT OR IGNORE INTO project_assets (project_id, asset_id, created_at) VALUES (?, ?, ?)').run(projectId, id, now);
  }
}
