import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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

/** Structural project comparison ignoring `version`, normalized through the schema so key order can't differ. */
function sameDoc(left: Project, right: Project): boolean {
  return JSON.stringify(projectSchema.parse({ ...left, version: 0 }))
    === JSON.stringify(projectSchema.parse({ ...right, version: 0 }));
}

interface ProjectRow { doc_json: string }
interface LogRow {
  id: string;
  batch_id: string;
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

/**
 * `userId` scoping: undefined means "no scope" — shared-token requests and
 * internal service calls see everything. A real user sees their own rows plus
 * NULL-owner rows (pre-auth data, the built-in sound library).
 */
export class ProjectStore {
  constructor(private readonly database: EditifyDatabase) {}

  create(input: NewProject, userId?: string): Project {
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
        { id: 'overlays', kind: 'overlay', clips: [] },
        { id: 'captions', kind: 'caption', clips: [] },
      ],
    };
    this.database.prepare(
      'INSERT INTO projects (id, title, doc_json, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, project.title, JSON.stringify(project), now, now, userId ?? null);
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

  list(userId?: string): Project[] {
    const rows = (userId === undefined
      ? this.database.prepare('SELECT doc_json FROM projects ORDER BY updated_at DESC').all()
      : this.database.prepare('SELECT doc_json FROM projects WHERE user_id = ? OR user_id IS NULL ORDER BY updated_at DESC').all(userId)
    ) as ProjectRow[];
    return rows.map((row) => projectSchema.parse(JSON.parse(row.doc_json)));
  }

  get(id: string, userId?: string): Project | undefined {
    const row = (userId === undefined
      ? this.database.prepare('SELECT doc_json FROM projects WHERE id = ?').get(id)
      : this.database.prepare('SELECT doc_json FROM projects WHERE id = ? AND (user_id = ? OR user_id IS NULL)').get(id, userId)
    ) as ProjectRow | undefined;
    return row ? projectSchema.parse(JSON.parse(row.doc_json)) : undefined;
  }

  /**
   * Removes the project and, through `ON DELETE CASCADE`, its operation log,
   * asset links, renders and chat. Rows in `assets` deliberately stay: media is
   * shared between projects, so deleting one must not strand another's clips.
   * Rendered outputs on disk belong to this project alone, so they are unlinked.
   */
  async delete(id: string, userId?: string): Promise<boolean> {
    if (!this.get(id, userId)) return false;
    const outputs = (this.database.prepare(
      'SELECT output_path FROM renders WHERE project_id = ? AND output_path IS NOT NULL',
    ).all(id) as Array<{ output_path: string }>).map((row) => row.output_path);
    await Promise.all(outputs.map(async (path) => { await rm(path, { force: true }); }));
    return this.database.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  /**
   * `runId` tags every row this call logs so a whole agent turn can be reverted
   * as one checkpoint; client edits leave it undefined (NULL).
   */
  applyOperations(projectId: string, rawOperations: Operation[], baseVersion: number, runId?: string): Project {
    return this.database.transaction(() => {
      let project = this.get(projectId);
      if (!project) throw new OperationError(`Project ${projectId} was not found`);
      if (project.version !== baseVersion) throw new VersionConflictError(baseVersion, project.version);
      const original = project;

      const operations = rawOperations.map((operation) => operationSchema.parse(operation));
      if (!operations.length) throw new OperationError('At least one operation is required');
      if (operations.some((operation) => operation.type === 'undo' || operation.type === 'revert_run')
        && operations.length !== 1) {
        throw new OperationError('Undo must be applied by itself');
      }
      const batchId = randomUUID();
      const pendingLogs: Array<{ operation: Operation; before: Project; after: Project; sequence: number }> = [];
      operations.forEach((operation, sequence) => {
        const before = project as Project;
        let after: Project;

        if (operation.type === 'undo') {
          const previous = this.database.prepare(`
            SELECT id, batch_id, op_json, before_doc_json FROM operation_log
            WHERE project_id = ? AND undone = 0 AND json_extract(op_json, '$.type') != 'undo'
            ORDER BY rowid DESC LIMIT 1
          `).get(projectId) as LogRow | undefined;
          if (!previous) throw new OperationError('There is no operation to undo');
          const firstInBatch = this.database.prepare(`
            SELECT id, batch_id, op_json, before_doc_json FROM operation_log
            WHERE project_id = ? AND batch_id = ? ORDER BY sequence ASC LIMIT 1
          `).get(projectId, previous.batch_id) as LogRow;
          const snapshot = projectSchema.parse(JSON.parse(firstInBatch.before_doc_json));
          after = { ...snapshot, version: before.version + 1 };
          this.database.prepare('UPDATE operation_log SET undone = 1 WHERE project_id = ? AND batch_id = ?')
            .run(projectId, previous.batch_id);
          // Undoing a revert is a redo: bring the reverted run's rows back into
          // history so a further undo walks into the run itself.
          const undoneOperation = operationSchema.parse(JSON.parse(firstInBatch.op_json));
          if (undoneOperation.type === 'revert_run') {
            this.database.prepare('UPDATE operation_log SET undone = 0 WHERE project_id = ? AND run_id = ?')
              .run(projectId, undoneOperation.params.runId);
          }
        } else if (operation.type === 'revert_run') {
          const target = operation.params.runId;
          const earliest = this.database.prepare(`
            SELECT id, batch_id, op_json, before_doc_json FROM operation_log
            WHERE project_id = ? AND run_id = ? AND undone = 0 ORDER BY rowid ASC LIMIT 1
          `).get(projectId, target) as LogRow | undefined;
          if (!earliest) throw new OperationError(`Run ${target} was already reverted or does not exist`);
          // Anything newer that is not part of this run (and is not an undo,
          // which already retracted itself) would be silently discarded.
          // Edits interleaved *during* the run sit inside its rowid span and are
          // clobbered by the revert — accepted v1 behaviour.
          const lastRowid = (this.database.prepare('SELECT MAX(rowid) AS rowid FROM operation_log WHERE project_id = ? AND run_id = ?')
            .get(projectId, target) as { rowid: number }).rowid;
          const foreign = (this.database.prepare(`
            SELECT COUNT(*) AS count FROM operation_log
            WHERE project_id = ? AND rowid > ? AND undone = 0
              AND (run_id IS NULL OR run_id != ?)
              AND json_extract(op_json, '$.type') != 'undo'
          `).get(projectId, lastRowid, target) as { count: number }).count;
          if (foreign > 0) throw new OperationError('The timeline changed after this edit, so revert is unavailable');
          const snapshot = projectSchema.parse(JSON.parse(earliest.before_doc_json));
          after = { ...snapshot, version: before.version + 1 };
          this.database.prepare('UPDATE operation_log SET undone = 1 WHERE project_id = ? AND run_id = ?')
            .run(projectId, target);
        } else {
          after = applyOperation(before, operation);
          after.version = baseVersion;
        }
        pendingLogs.push({ operation, before, after, sequence });
        project = after;
      });

      const isHistoryOperation = operations[0]?.type === 'undo' || operations[0]?.type === 'revert_run';
      // A write that changed nothing must not bump the version: it would create a
      // bogus revert checkpoint and make the client flash an identical document.
      if (!isHistoryOperation && sameDoc(original, project)) return original;
      if (!isHistoryOperation) project.version = baseVersion + 1;
      const now = new Date().toISOString();
      for (const entry of pendingLogs) {
        const loggedAfter = entry.sequence === pendingLogs.length - 1
          ? project
          : { ...entry.after, version: project.version };
        this.database.prepare(`
          INSERT INTO operation_log
            (id, batch_id, project_id, sequence, op_json, before_doc_json, after_doc_json, undone, created_at, run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(randomUUID(), batchId, projectId, entry.sequence, JSON.stringify(entry.operation), JSON.stringify(entry.before), JSON.stringify(loggedAfter), now, runId ?? null);
      }

      this.database.prepare('UPDATE projects SET title = ?, doc_json = ?, updated_at = ? WHERE id = ?')
        .run(project.title, JSON.stringify(project), new Date().toISOString(), projectId);
      return project;
    })();
  }

  /**
   * Of `runIds`, those that still have operations standing. A run missing from
   * the result has been reverted (or never applied anything).
   */
  liveRuns(projectId: string, runIds: string[]): Set<string> {
    if (!runIds.length) return new Set();
    const rows = this.database.prepare(`
      SELECT DISTINCT run_id FROM operation_log
      WHERE project_id = ? AND undone = 0 AND run_id IN (${runIds.map(() => '?').join(', ')})
    `).all(projectId, ...runIds) as Array<{ run_id: string }>;
    return new Set(rows.map((row) => row.run_id));
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
