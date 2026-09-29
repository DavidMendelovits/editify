import { randomUUID } from 'node:crypto';
import { renderQaSchema, type RenderQa } from '@editify/shared';
import type { EditifyDatabase } from './database.js';
import { publicBaseUrl } from '../config.js';

export type RenderStatus = 'queued' | 'processing' | 'done' | 'error';
export interface RenderRecord {
  id: string;
  projectId: string;
  resolution: '720p' | '1080p' | '4k';
  status: RenderStatus;
  /** The project version the render read when it started. Absent on renders that predate the column. */
  projectVersion?: number;
  outputUrl?: string;
  error?: string;
  qa?: RenderQa;
  /** Present when QA wrote a contact sheet of the master's frames. */
  contactSheetUrl?: string;
  createdAt: string;
  updatedAt: string;
}

interface RenderRow {
  id: string; project_id: string; resolution: '720p' | '1080p' | '4k'; status: RenderStatus;
  output_path: string | null; error: string | null; created_at: string; updated_at: string;
  project_version: number | null;
  qa_json: string | null;
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

  /** `projectVersion` is only written when given, so later status changes keep it. */
  update(id: string, status: RenderStatus, values: { outputPath?: string; error?: string; projectVersion?: number } = {}): void {
    this.database.prepare(`
      UPDATE renders SET status = ?, output_path = ?, error = ?, updated_at = ?,
        project_version = COALESCE(?, project_version)
      WHERE id = ?
    `).run(status, values.outputPath ?? null, values.error ?? null, new Date().toISOString(), values.projectVersion ?? null, id);
  }

  setQa(id: string, qa: RenderQa): void {
    this.database.prepare('UPDATE renders SET qa_json = ? WHERE id = ?').run(JSON.stringify(qa), id);
  }

  /** The newest finished render of a project, for the agent's QA read-back. */
  latestDone(projectId: string): RenderRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM renders WHERE project_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1
    `).get(projectId) as RenderRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  /** `userId` scopes through the owning project: owner-only, like ProjectStore. */
  get(id: string, userId?: string): RenderRecord | undefined {
    const row = (userId === undefined
      ? this.database.prepare('SELECT * FROM renders WHERE id = ?').get(id)
      : this.database.prepare(`
          SELECT renders.* FROM renders JOIN projects ON projects.id = renders.project_id
          WHERE renders.id = ? AND projects.user_id = ?
        `).get(id, userId)
    ) as RenderRow | undefined;
    if (!row) return undefined;
    return this.toRecord(row);
  }

  unfinished(): RenderRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM renders WHERE status IN ('queued', 'processing') ORDER BY created_at ASC
    `).all() as RenderRow[];
    return rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: RenderRow): RenderRecord {
    const qa = row.qa_json ? renderQaSchema.safeParse(JSON.parse(row.qa_json)) : undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      resolution: row.resolution,
      status: row.status,
      ...(row.project_version !== null ? { projectVersion: row.project_version } : {}),
      ...(row.output_path ? { outputUrl: `${publicBaseUrl}/renders/${row.id}/file.mp4` } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(qa?.success ? { qa: qa.data } : {}),
      ...(qa?.success && qa.data.contactSheet ? { contactSheetUrl: `${publicBaseUrl}/renders/${row.id}/contact.jpg` } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  outputPath(id: string): string | undefined {
    const row = this.database.prepare('SELECT output_path FROM renders WHERE id = ?').get(id) as { output_path: string | null } | undefined;
    return row?.output_path ?? undefined;
  }
}
