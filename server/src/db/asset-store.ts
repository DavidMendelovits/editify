import type { AssetMetadata } from '@editify/shared';
import type { EditifyDatabase } from './database.js';
import { publicBaseUrl } from '../config.js';

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

export class AssetStore {
  constructor(private readonly database: EditifyDatabase) {}

  insert(asset: NewAsset): StoredAsset {
    this.database.prepare(`
      INSERT INTO assets
        (id, original_name, mime_type, duration, width, height, fps, has_audio,
         original_path, proxy_path, thumbnail_path, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id, asset.originalName, asset.mimeType, asset.duration, asset.width, asset.height,
      asset.fps, asset.hasAudio ? 1 : 0, asset.originalPath, asset.proxyPath,
      asset.thumbnailPath, asset.createdAt, asset.status ?? 'ready',
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

  /** An empty/blank label clears it, so the card falls back to the file name. */
  setLabel(id: string, label: string): StoredAsset | undefined {
    const trimmed = label.trim();
    this.database.prepare('UPDATE assets SET label = ? WHERE id = ?').run(trimmed || null, id);
    return this.get(id);
  }

  get(id: string): StoredAsset | undefined {
    const row = this.database.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  getByOriginalName(originalName: string): StoredAsset | undefined {
    const row = this.database.prepare('SELECT * FROM assets WHERE original_name = ? ORDER BY rowid ASC LIMIT 1')
      .get(originalName) as AssetRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(): StoredAsset[] {
    return (this.database.prepare('SELECT * FROM assets ORDER BY rowid ASC').all() as AssetRow[])
      .map((row) => this.fromRow(row));
  }

  /** The media belonging to one project — everything else stays out of its way. */
  listForProject(projectId: string): StoredAsset[] {
    return (this.database.prepare(`
      SELECT assets.* FROM assets
      JOIN project_assets ON project_assets.asset_id = assets.id
      WHERE project_assets.project_id = ?
      ORDER BY assets.rowid ASC
    `).all(projectId) as AssetRow[]).map((row) => this.fromRow(row));
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
