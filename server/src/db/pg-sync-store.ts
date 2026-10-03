import pg from 'pg';
import {
  OperationError,
  applyBatch,
  operationSchema,
  projectHash,
  projectSchema,
  type Operation,
  type Project,
  type SyncLogEntry,
  type SyncLogKind,
  type SyncPushRequest,
  type SyncReceipt,
} from '@editify/shared';

/*
 * Device-authoritative project sync in Postgres (decision 4A, OV4). The schema
 * is supabase/migrations/20261002120000_project_sync.sql. Every push is one
 * transaction:
 *
 *   BEGIN
 *   SELECT project FOR UPDATE ─ missing or not this user's ─▶ not found
 *   receipt for changeId? ───────────────────────────────────▶ that receipt (retry)
 *   revision != baseRevision? ───────────────────────────────▶ 409 stale
 *   apply: edits through shared applyBatch; undo / redo / revert_run from the log
 *   expectedHash given and different? ───────────────────────▶ rejected
 *   no-op? ─▶ receipt only, revision unchanged
 *   else ──▶ log row at last_seq + 1, receipt, document at revision + 1
 *   COMMIT
 *
 * The row lock serializes writers per project, so two pushes on the same
 * revision cannot both pass the check, and seq is assigned without gaps. The
 * history rules are the SQLite ProjectStore's (project-store.ts), ordered by
 * seq instead of rowid.
 */

export type PgPool = pg.Pool;
type Queryable = pg.Pool | pg.PoolClient;

/** One pool per process. Lazy: nothing connects until the first query. */
export function createPgPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
  // An idle client losing its connection is reported here; unhandled, it would crash the process.
  pool.on('error', (error) => { console.error('[sync] idle Postgres client error', error.message); });
  return pool;
}

export async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class SyncConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`The project is at revision ${actual}, not ${expected}`);
    this.name = 'SyncConflictError';
  }
}

export class SyncMismatchError extends Error {
  constructor(public readonly expectedHash: string, public readonly actualHash: string) {
    super('The change produced a different document on the server than on the device');
    this.name = 'SyncMismatchError';
  }
}

export class SyncNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} was not found`);
    this.name = 'SyncNotFoundError';
  }
}

/** The id belongs to another account. Kept apart from not-found so a create can say so. */
export class SyncProjectTakenError extends Error {
  constructor(projectId: string) {
    super(`Project id ${projectId} is already in use`);
    this.name = 'SyncProjectTakenError';
  }
}

export interface SyncedProject {
  project: Project;
  revision: number;
  /** The newest log seq: pull the log since it to catch up incrementally. */
  seq: number;
}

export interface SyncPushResult {
  receipt: SyncReceipt;
  /** True when the change id had already been applied and nothing was written now. */
  duplicate: boolean;
}

interface ProjectRow { user_id: string; doc: unknown; revision: string; last_seq: string }
interface ReceiptRow { project_id: string; change_id: string; base_revision: string; revision: string; seq: string | null; hash: string }
interface LogRow {
  seq: string; kind: SyncLogKind; ops: unknown[]; revision: string; undone: boolean;
  run_id: string | null; undo_target_seq: string | null; change_id: string | null; created_at: Date;
}

function toReceipt(row: ReceiptRow): SyncReceipt {
  return {
    projectId: row.project_id,
    changeId: row.change_id,
    baseRevision: Number(row.base_revision),
    revision: Number(row.revision),
    seq: row.seq === null ? null : Number(row.seq),
    hash: row.hash,
  };
}

function isHistory(operation: Operation): boolean {
  return operation.type === 'undo' || operation.type === 'redo' || operation.type === 'revert_run';
}

/** Ids the phone already wrote into the ops; a server-minted one would fork the two documents. */
const noNewIds = { newId: (): string => { throw new OperationError('Every generated id must be in the op (for split_clip, newClipId)'); } };

/** What one push resolves to before anything is written. */
interface Resolved {
  kind: Exclude<SyncLogKind, 'create'>;
  after: Project;
  undoTargetSeq: number | null;
  /** Undone-flag rewrites the history op implies, run in order once the change is accepted. */
  history: Array<{ sql: string; values: unknown[] }>;
}

export class PgSyncStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Registers a phone's project at its current version. Idempotent by id: a
   * repeat from the same user returns what is stored (created: false).
   */
  async create(userId: string, input: Project): Promise<SyncedProject & { created: boolean }> {
    // Normalized the same way a proposal replay is (schema defaults, derived duration).
    const project = { ...applyBatch(projectSchema.parse(input), [], noNewIds), version: input.version };
    return await withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO sync_projects (id, user_id, title, doc, revision, last_seq)
         VALUES ($1, $2, $3, $4::jsonb, $5, 1) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [project.id, userId, project.title, JSON.stringify(project), project.version],
      );
      if (inserted.rowCount === 1) {
        await client.query(
          `INSERT INTO sync_op_log (project_id, seq, user_id, kind, ops, revision, after_doc)
           VALUES ($1, 1, $2, 'create', '[]'::jsonb, $3, $4::jsonb)`,
          [project.id, userId, project.version, JSON.stringify(project)],
        );
        return { project, revision: project.version, seq: 1, created: true };
      }
      const existing = await this.read(client, userId, project.id);
      if (!existing) throw new SyncProjectTakenError(project.id);
      return { ...existing, created: false };
    });
  }

  async get(userId: string, projectId: string): Promise<SyncedProject | undefined> {
    return await this.read(this.pool, userId, projectId);
  }

  async list(userId: string): Promise<Array<{ id: string; title: string; revision: number; updatedAt: string }>> {
    const { rows } = await this.pool.query<{ id: string; title: string; revision: string; updated_at: Date }>(
      'SELECT id, title, revision, updated_at FROM sync_projects WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    );
    return rows.map((row) => ({ id: row.id, title: row.title, revision: Number(row.revision), updatedAt: row.updated_at.toISOString() }));
  }

  async delete(userId: string, projectId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM sync_projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
    return result.rowCount === 1;
  }

  /** Log rows after `sinceSeq`, oldest first. Undefined when the project is not this user's. */
  async log(userId: string, projectId: string, sinceSeq: number, limit: number): Promise<SyncLogEntry[] | undefined> {
    const owner = await this.pool.query('SELECT 1 FROM sync_projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
    if (!owner.rowCount) return undefined;
    const { rows } = await this.pool.query<LogRow>(
      `SELECT seq, kind, ops, revision, undone, run_id, undo_target_seq, change_id, created_at
       FROM sync_op_log WHERE project_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [projectId, sinceSeq, limit],
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      kind: row.kind,
      ops: row.ops.map((operation) => operationSchema.parse(operation)),
      revision: Number(row.revision),
      undone: row.undone,
      runId: row.run_id,
      undoTargetSeq: row.undo_target_seq === null ? null : Number(row.undo_target_seq),
      changeId: row.change_id,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async push(userId: string, projectId: string, request: SyncPushRequest): Promise<SyncPushResult> {
    const operations = request.ops.map((operation) => operationSchema.parse(operation));
    if (operations.some(isHistory) && operations.length !== 1) {
      // The SQLite store's wording, so either backend refuses the same way.
      throw new OperationError('Undo must be applied by itself');
    }
    return await withTransaction(this.pool, async (client) => {
      const locked = await client.query<ProjectRow>(
        'SELECT user_id, doc, revision, last_seq FROM sync_projects WHERE id = $1 FOR UPDATE',
        [projectId],
      );
      const row = locked.rows[0];
      if (!row || row.user_id !== userId) throw new SyncNotFoundError(projectId);

      const seen = await client.query<ReceiptRow>(
        `SELECT project_id, change_id, base_revision, revision, seq, hash
         FROM sync_receipts WHERE project_id = $1 AND change_id = $2`,
        [projectId, request.changeId],
      );
      if (seen.rows[0]) return { receipt: toReceipt(seen.rows[0]), duplicate: true };

      const revision = Number(row.revision);
      if (revision !== request.baseRevision) throw new SyncConflictError(request.baseRevision, revision);
      const current = projectSchema.parse(row.doc);
      const resolved = await this.resolve(client, projectId, current, operations);
      const hash = projectHash(resolved.after);
      if (request.expectedHash && request.expectedHash !== hash) throw new SyncMismatchError(request.expectedHash, hash);

      const noop = resolved.kind === 'edit' && hash === projectHash(current);
      const receipt: SyncReceipt = {
        projectId,
        changeId: request.changeId,
        baseRevision: revision,
        revision: noop ? revision : revision + 1,
        seq: noop ? null : Number(row.last_seq) + 1,
        hash,
      };
      if (!noop) {
        for (const statement of resolved.history) await client.query(statement.sql, statement.values);
        const after: Project = { ...resolved.after, version: receipt.revision };
        await client.query(
          `INSERT INTO sync_op_log
             (project_id, seq, user_id, kind, ops, revision, after_doc, undone, run_id, undo_target_seq, change_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11)`,
          [
            projectId, receipt.seq, userId, resolved.kind, JSON.stringify(operations), receipt.revision,
            JSON.stringify(after), resolved.kind === 'redo',
            // As in SQLite, any change can carry the run id, an agent's own undo included.
            request.runId ?? null,
            resolved.undoTargetSeq, request.changeId,
          ],
        );
        await client.query(
          `UPDATE sync_projects SET doc = $2::jsonb, title = $3, revision = $4, last_seq = $5, updated_at = now()
           WHERE id = $1`,
          [projectId, JSON.stringify(after), after.title, receipt.revision, receipt.seq],
        );
      }
      await client.query(
        `INSERT INTO sync_receipts (project_id, change_id, user_id, base_revision, revision, seq, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [projectId, receipt.changeId, userId, receipt.baseRevision, receipt.revision, receipt.seq, receipt.hash],
      );
      return { receipt, duplicate: false };
    });
  }

  private async read(db: Queryable, userId: string, projectId: string): Promise<SyncedProject | undefined> {
    const { rows } = await db.query<ProjectRow>(
      'SELECT user_id, doc, revision, last_seq FROM sync_projects WHERE id = $1 AND user_id = $2',
      [projectId, userId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { project: projectSchema.parse(row.doc), revision: Number(row.revision), seq: Number(row.last_seq) };
  }

  /** The document before the change logged at `seq`: its predecessor's after_doc ('create' is seq 1). */
  private async docBefore(client: pg.PoolClient, projectId: string, seq: number): Promise<Project> {
    const { rows } = await client.query<{ after_doc: unknown }>(
      'SELECT after_doc FROM sync_op_log WHERE project_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 1',
      [projectId, seq],
    );
    if (!rows[0]) throw new OperationError('The history before this change is missing');
    return projectSchema.parse(rows[0].after_doc);
  }

  private async resolve(client: pg.PoolClient, projectId: string, current: Project, operations: Operation[]): Promise<Resolved> {
    const [operation] = operations;
    if (!operation || !isHistory(operation)) {
      return { kind: 'edit', after: applyBatch(current, operations, noNewIds), undoTargetSeq: null, history: [] };
    }
    const setUndone = (undone: boolean, where: string, value: unknown) => ({
      sql: `UPDATE sync_op_log SET undone = ${undone ? 'true' : 'false'} WHERE project_id = $1 AND ${where}`,
      values: [projectId, value],
    });

    if (operation.type === 'undo') {
      // The newest standing edit or revert. Undo rows retract themselves into
      // a redo target; redo rows are logged undone; the create row is not an edit.
      const { rows } = await client.query<{ seq: string; kind: SyncLogKind; ops: unknown[] }>(
        `SELECT seq, kind, ops FROM sync_op_log
         WHERE project_id = $1 AND NOT undone AND kind IN ('edit', 'revert_run')
         ORDER BY seq DESC LIMIT 1`,
        [projectId],
      );
      const target = rows[0];
      if (!target) throw new OperationError('There is no operation to undo');
      const seq = Number(target.seq);
      const history = [setUndone(true, 'seq = $2', seq)];
      // Undoing a revert is a redo of the run: its rows come back into history.
      const undoneOperation = operationSchema.parse(target.ops[0]);
      if (target.kind === 'revert_run' && undoneOperation.type === 'revert_run') {
        history.push(setUndone(false, 'run_id = $2', undoneOperation.params.runId));
      }
      return { kind: 'undo', after: await this.docBefore(client, projectId, seq), undoTargetSeq: seq, history };
    }

    if (operation.type === 'redo') {
      const { rows } = await client.query<{ seq: string; undo_target_seq: string }>(
        `SELECT seq, undo_target_seq FROM sync_op_log
         WHERE project_id = $1 AND NOT undone AND kind = 'undo' AND undo_target_seq IS NOT NULL
         ORDER BY seq DESC LIMIT 1`,
        [projectId],
      );
      const undoRow = rows[0];
      // Any standing row newer than the undo means a real edit landed, which clears redo.
      const newer = undoRow ? await client.query(
        'SELECT 1 FROM sync_op_log WHERE project_id = $1 AND seq > $2 AND NOT undone LIMIT 1',
        [projectId, undoRow.seq],
      ) : undefined;
      if (!undoRow || newer?.rowCount) throw new OperationError('There is nothing to redo');
      const targetSeq = Number(undoRow.undo_target_seq);
      const target = (await client.query<{ kind: SyncLogKind; ops: unknown[]; after_doc: unknown }>(
        'SELECT kind, ops, after_doc FROM sync_op_log WHERE project_id = $1 AND seq = $2',
        [projectId, targetSeq],
      )).rows[0];
      if (!target) throw new OperationError('There is nothing to redo');
      const history: Resolved['history'] = [];
      // Mirror of undo: redoing a revert retracts its run again.
      const redoneOperation = operationSchema.parse(target.ops[0]);
      if (target.kind === 'revert_run' && redoneOperation.type === 'revert_run') {
        history.push(setUndone(true, 'run_id = $2', redoneOperation.params.runId));
      }
      history.push(setUndone(false, 'seq = $2', targetSeq), setUndone(true, 'seq = $2', Number(undoRow.seq)));
      return { kind: 'redo', after: projectSchema.parse(target.after_doc), undoTargetSeq: null, history };
    }

    if (operation.type !== 'revert_run') throw new OperationError(`Unsupported history operation ${operation.type}`);
    const runId = operation.params.runId;
    const span = (await client.query<{ first: string | null; last: string | null }>(
      `SELECT MIN(seq) FILTER (WHERE NOT undone) AS first, MAX(seq) AS last
       FROM sync_op_log WHERE project_id = $1 AND run_id = $2`,
      [projectId, runId],
    )).rows[0];
    if (!span?.first || !span.last) throw new OperationError(`Run ${runId} was already reverted or does not exist`);
    // Anything newer that is not part of this run (and is not an undo, which
    // already retracted itself) would be silently discarded by the revert.
    const foreign = await client.query(
      `SELECT 1 FROM sync_op_log
       WHERE project_id = $1 AND seq > $2 AND NOT undone
         AND (run_id IS NULL OR run_id <> $3) AND kind <> 'undo' LIMIT 1`,
      [projectId, span.last, runId],
    );
    if (foreign.rowCount) throw new OperationError('The timeline changed after this edit, so revert is unavailable');
    return {
      kind: 'revert_run',
      after: await this.docBefore(client, projectId, Number(span.first)),
      undoTargetSeq: null,
      history: [setUndone(true, 'run_id = $2', runId)],
    };
  }
}
