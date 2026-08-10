import { randomUUID } from 'node:crypto';
import {
  newProjectSchema,
  operationSchema,
  projectSchema,
  type NewProject,
  type Operation,
  type Project,
} from '@editify/shared';
import type { EditifyDatabase } from './database.js';
import { applyOperation, OperationError } from '../operations/apply.js';

export class VersionConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`Version conflict: expected ${expected}, current version is ${actual}`);
    this.name = 'VersionConflictError';
  }
}

interface ProjectRow { doc_json: string }
interface LogRow {
  id: string;
  op_json: string;
  before_doc_json: string;
}

export interface OperationLogEntry {
  id: string;
  batchId: string;
  operation: Operation;
  beforeVersion: number;
  afterVersion: number;
  undone: boolean;
  createdAt: string;
}

export class ProjectStore {
  constructor(private readonly database: EditifyDatabase) {}

  create(input: NewProject): Project {
    const values = newProjectSchema.parse(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const project: Project = {
      id,
      title: values.title,
      format: values.format,
      fps: values.fps,
      duration: 0,
      version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [] },
        { id: 'audio-main', kind: 'audio', clips: [] },
        { id: 'captions', kind: 'caption', clips: [] },
      ],
    };
    this.database.prepare(
      'INSERT INTO projects (id, title, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, project.title, JSON.stringify(project), now, now);
    return project;
  }

  insert(project: Project): Project {
    const parsed = projectSchema.parse(project);
    const now = new Date().toISOString();
    this.database.prepare(
      'INSERT OR REPLACE INTO projects (id, title, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(parsed.id, parsed.title, JSON.stringify(parsed), now, now);
    return parsed;
  }

  list(): Project[] {
    return (this.database.prepare('SELECT doc_json FROM projects ORDER BY updated_at DESC').all() as ProjectRow[])
      .map((row) => projectSchema.parse(JSON.parse(row.doc_json)));
  }

  get(id: string): Project | undefined {
    const row = this.database.prepare('SELECT doc_json FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? projectSchema.parse(JSON.parse(row.doc_json)) : undefined;
  }

  applyOperations(projectId: string, rawOperations: Operation[], baseVersion: number): Project {
    return this.database.transaction(() => {
      let project = this.get(projectId);
      if (!project) throw new OperationError(`Project ${projectId} was not found`);
      if (project.version !== baseVersion) throw new VersionConflictError(baseVersion, project.version);

      const batchId = randomUUID();
      rawOperations.forEach((rawOperation, sequence) => {
        const operation = operationSchema.parse(rawOperation);
        const before = project as Project;
        let undoneLogId: string | undefined;
        let after: Project;

        if (operation.type === 'undo') {
          const previous = this.database.prepare(`
            SELECT id, op_json, before_doc_json FROM operation_log
            WHERE project_id = ? AND undone = 0 AND json_extract(op_json, '$.type') != 'undo'
            ORDER BY rowid DESC LIMIT 1
          `).get(projectId) as LogRow | undefined;
          if (!previous) throw new OperationError('There is no operation to undo');
          const snapshot = projectSchema.parse(JSON.parse(previous.before_doc_json));
          after = { ...snapshot, version: before.version + 1 };
          undoneLogId = previous.id;
        } else {
          after = applyOperation(before, operation);
        }

        const now = new Date().toISOString();
        this.database.prepare(`
          INSERT INTO operation_log
            (id, batch_id, project_id, sequence, op_json, before_doc_json, after_doc_json, undone, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).run(randomUUID(), batchId, projectId, sequence, JSON.stringify(operation), JSON.stringify(before), JSON.stringify(after), now);
        if (undoneLogId) this.database.prepare('UPDATE operation_log SET undone = 1 WHERE id = ?').run(undoneLogId);
        project = after;
      });

      this.database.prepare('UPDATE projects SET title = ?, doc_json = ?, updated_at = ? WHERE id = ?')
        .run(project.title, JSON.stringify(project), new Date().toISOString(), projectId);
      return project;
    })();
  }

  operationLog(projectId: string): OperationLogEntry[] {
    const rows = this.database.prepare(`
      SELECT id, batch_id, op_json, before_doc_json, after_doc_json, undone, created_at
      FROM operation_log WHERE project_id = ? ORDER BY rowid ASC
    `).all(projectId) as Array<{
      id: string; batch_id: string; op_json: string; before_doc_json: string;
      after_doc_json: string; undone: number; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      operation: operationSchema.parse(JSON.parse(row.op_json)),
      beforeVersion: projectSchema.parse(JSON.parse(row.before_doc_json)).version,
      afterVersion: projectSchema.parse(JSON.parse(row.after_doc_json)).version,
      undone: row.undone === 1,
      createdAt: row.created_at,
    }));
  }
}
