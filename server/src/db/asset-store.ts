import type { AssetMetadata } from '@editify/shared';
import type { EditifyDatabase } from './database.js';
import { publicBaseUrl } from '../config.js';

export interface StoredAsset extends AssetMetadata {
  originalPath: string;
  proxyPath: string;
  thumbnailPath: string;
}

interface AssetRow {
  id: string; original_name: string; mime_type: string; duration: number; width: number;
  height: number; fps: number; has_audio: number; original_path: string; proxy_path: string;
  thumbnail_path: string; created_at: string;
}

export class AssetStore {
  constructor(private readonly database: EditifyDatabase) {}

  insert(asset: StoredAsset): StoredAsset {
    this.database.prepare(`
      INSERT INTO assets
        (id, original_name, mime_type, duration, width, height, fps, has_audio,
         original_path, proxy_path, thumbnail_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id, asset.originalName, asset.mimeType, asset.duration, asset.width, asset.height,
      asset.fps, asset.hasAudio ? 1 : 0, asset.originalPath, asset.proxyPath,
      asset.thumbnailPath, asset.createdAt,
    );
    return this.get(asset.id) ?? asset;
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
