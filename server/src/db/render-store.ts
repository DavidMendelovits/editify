import { randomUUID } from 'node:crypto';
import type { EditifyDatabase } from './database.js';
import { publicBaseUrl } from '../config.js';

export type RenderStatus = 'queued' | 'processing' | 'done' | 'error';
export interface RenderRecord {
  id: string;
  projectId: string;
  resolution: '720p' | '1080p' | '4k';
  status: RenderStatus;
  outputUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface RenderRow {
  id: string; project_id: string; resolution: '720p' | '1080p' | '4k'; status: RenderStatus;
  output_path: string | null; error: string | null; created_at: string; updated_at: string;
}

export class RenderStore {
  constructor(private readonly database: EditifyDatabase) {}

  create(projectId: string, resolution: RenderRecord['resolution']): RenderRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO renders (id, project_id, resolution, status, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(id, projectId, resolution, now, now);
    return this.get(id) as RenderRecord;
  }

  update(id: string, status: RenderStatus, values: { outputPath?: string; error?: string } = {}): void {
    this.database.prepare(`
      UPDATE renders SET status = ?, output_path = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(status, values.outputPath ?? null, values.error ?? null, new Date().toISOString(), id);
  }

  get(id: string): RenderRecord | undefined {
    const row = this.database.prepare('SELECT * FROM renders WHERE id = ?').get(id) as RenderRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      resolution: row.resolution,
      status: row.status,
      ...(row.output_path ? { outputUrl: `${publicBaseUrl}/renders/${row.id}/file.mp4` } : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  outputPath(id: string): string | undefined {
    const row = this.database.prepare('SELECT output_path FROM renders WHERE id = ?').get(id) as { output_path: string | null } | undefined;
    return row?.output_path ?? undefined;
  }
}
