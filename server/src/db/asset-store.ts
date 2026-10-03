import type { AssetMetadata } from '@editify/shared';
import type { EditifyDatabase } from './database.js';
import { publicBaseUrl } from '../config.js';
import { SOUND_ID_PREFIX } from '../media/sound-library.js';

export interface StoredAsset extends AssetMetadata {
  originalPath: string;
  proxyPath: string;
  thumbnailPath: string;
}

/** `status` defaults to 'ready' — only the async import path inserts 'processing'. */
export type NewAsset = Omit<StoredAsset, 'status'> & { status?: AssetMetadata['status'] };

interface AssetRow {
  id: string; original_name: string; mime_type: string; duration: number; width: number;
  height: number; fps: number; has_audio: number; original_path: string; proxy_path: string;
  thumbnail_path: string; created_at: string; label: string | null; status: string | null;
}

/**
 * What a signed-in user may read: their own rows plus the built-in sound
 * library. Other NULL-owner rows (pre-auth uploads) belong to nobody and stay
 * hidden. Binds one parameter, the user id.
 */
const VISIBLE = `(assets.user_id = ? OR (assets.user_id IS NULL AND assets.id LIKE '${SOUND_ID_PREFIX}%'))`;

export class AssetStore {
  constructor(private readonly database: EditifyDatabase) {}

  /** `userId` scoping matches ProjectStore: undefined = unscoped (shared token, internal calls). */
  insert(asset: NewAsset, userId?: string): StoredAsset {
    this.database.prepare(`
      INSERT INTO assets
        (id, original_name, mime_type, duration, width, height, fps, has_audio,
         original_path, proxy_path, thumbnail_path, created_at, status, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id, asset.originalName, asset.mimeType, asset.duration, asset.width, asset.height,
      asset.fps, asset.hasAudio ? 1 : 0, asset.originalPath, asset.proxyPath,
      asset.thumbnailPath, asset.createdAt, asset.status ?? 'ready', userId ?? null,
    );
    return this.get(asset.id) ?? { ...asset, status: asset.status ?? 'ready' };
  }

  /**
   * Insert, or re-point an existing row at a regenerated file. The built-in
   * sound library needs this: its rows are keyed on a fixed `sound-<id>`, so a
   * new recipe version has to replace the old paths instead of colliding.
   */
  upsert(asset: NewAsset, userId?: string): StoredAsset {
    if (!this.get(asset.id)) return this.insert(asset, userId);
    this.database.prepare(`
      UPDATE assets
         SET original_name = ?, mime_type = ?, duration = ?,
             original_path = ?, proxy_path = ?, thumbnail_path = ?, status = ?
       WHERE id = ?
    `).run(
      asset.originalName, asset.mimeType, asset.duration, asset.originalPath,
      asset.proxyPath, asset.thumbnailPath, asset.status ?? 'ready', asset.id,
    );
    return this.get(asset.id) ?? { ...asset, status: asset.status ?? 'ready' };
  }

  /** End of background processing: the generated media, or the failure, lands here. */
  setStatus(id: string, status: AssetMetadata['status'], paths?: { proxyPath: string; thumbnailPath: string }): void {
    if (paths) {
      this.database.prepare('UPDATE assets SET status = ?, proxy_path = ?, thumbnail_path = ? WHERE id = ?')
        .run(status, paths.proxyPath, paths.thumbnailPath, id);
    } else {
      this.database.prepare('UPDATE assets SET status = ? WHERE id = ?').run(status, id);
    }
  }

  /**
   * A re-uploaded original (PUT /assets/:id/original). A still's display paths point at its
   * original, so they move with it.
   */
  setOriginalPath(id: string, path: string): void {
    this.database.prepare(`
      UPDATE assets
         SET original_path = ?,
             proxy_path = CASE WHEN proxy_path = original_path THEN ? ELSE proxy_path END,
             thumbnail_path = CASE WHEN thumbnail_path = original_path THEN ? ELSE thumbnail_path END
       WHERE id = ?
    `).run(path, path, path, id);
  }

  /** An empty/blank label clears it, so the card falls back to the file name. */
  setLabel(id: string, label: string): StoredAsset | undefined {
    const trimmed = label.trim();
    this.database.prepare('UPDATE assets SET label = ? WHERE id = ?').run(trimmed || null, id);
    return this.get(id);
  }

  get(id: string, userId?: string): StoredAsset | undefined {
    const row = (userId === undefined
      ? this.database.prepare('SELECT * FROM assets WHERE id = ?').get(id)
      : this.database.prepare(`SELECT * FROM assets WHERE id = ? AND ${VISIBLE}`).get(id, userId)
    ) as AssetRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  /** Writes need ownership: the sound library is readable by everyone, editable by no user. */
  owned(id: string, userId?: string): StoredAsset | undefined {
    if (userId === undefined) return this.get(id);
    const row = this.database.prepare('SELECT * FROM assets WHERE id = ? AND user_id = ?').get(id, userId) as AssetRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  getByOriginalName(originalName: string, userId?: string): StoredAsset | undefined {
    const row = (userId === undefined
      ? this.database.prepare('SELECT * FROM assets WHERE original_name = ? ORDER BY rowid ASC LIMIT 1').get(originalName)
      : this.database.prepare(`SELECT * FROM assets WHERE original_name = ? AND ${VISIBLE} ORDER BY rowid ASC LIMIT 1`).get(originalName, userId)
    ) as AssetRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(userId?: string): StoredAsset[] {
    const rows = (userId === undefined
      ? this.database.prepare('SELECT * FROM assets ORDER BY rowid ASC').all()
      : this.database.prepare(`SELECT * FROM assets WHERE ${VISIBLE} ORDER BY rowid ASC`).all(userId)
    ) as AssetRow[];
    return rows.map((row) => this.fromRow(row));
  }

  /** The media belonging to one project — everything else stays out of its way. */
  listForProject(projectId: string, userId?: string): StoredAsset[] {
    return (this.database.prepare(`
      SELECT assets.* FROM assets
      JOIN project_assets ON project_assets.asset_id = assets.id
      WHERE project_assets.project_id = ?${userId === undefined ? '' : ` AND ${VISIBLE}`}
      ORDER BY assets.rowid ASC
    `).all(...(userId === undefined ? [projectId] : [projectId, userId])) as AssetRow[]).map((row) => this.fromRow(row));
  }

  /**
   * One asset as the project may use it: linked to it, or a library sound.
   * `project_assets` is the grant the agent's tools read through.
   */
  getInProject(projectId: string, id: string, userId?: string): StoredAsset | undefined {
    if (!this.linkedOrSound(projectId, id)) return undefined;
    return this.get(id, userId);
  }

  /** Whether a timeline may reference `id`: linked to the project, or a library sound. */
  linkedOrSound(projectId: string, id: string): boolean {
    return id.startsWith(SOUND_ID_PREFIX) || Boolean(this.database.prepare(
      'SELECT 1 FROM project_assets WHERE project_id = ? AND asset_id = ?',
    ).get(projectId, id));
  }

  /** Idempotent: re-importing the same file into a project is not an error. */
  link(projectId: string, assetId: string): void {
    this.database.prepare('INSERT OR IGNORE INTO project_assets (project_id, asset_id, created_at) VALUES (?, ?, ?)')
      .run(projectId, assetId, new Date().toISOString());
  }

  private fromRow(row: AssetRow): StoredAsset {
    return {
      id: row.id,
      originalName: row.original_name,
      mimeType: row.mime_type,
      duration: row.duration,
      width: row.width,
      height: row.height,
      fps: row.fps,
      hasAudio: row.has_audio === 1,
      status: (row.status ?? 'ready') as AssetMetadata['status'],
      ...(row.label ? { label: row.label } : {}),
      originalPath: row.original_path,
      proxyPath: row.proxy_path,
      thumbnailPath: row.thumbnail_path,
      originalUrl: `${publicBaseUrl}/assets/${row.id}/original`,
      proxyUrl: `${publicBaseUrl}/assets/${row.id}/proxy.mp4`,
      thumbnailUrl: `${publicBaseUrl}/assets/${row.id}/thumb.jpg`,
      filmstripUrl: `${publicBaseUrl}/assets/${row.id}/filmstrip.jpg`,
      createdAt: row.created_at,
    };
  }
}
