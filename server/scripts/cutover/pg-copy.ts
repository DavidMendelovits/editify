import type pg from 'pg';
import { SCHEMA_NAME } from '../../src/db/postgres.js';
import { withTransaction } from '../../src/db/pg-sync-store.js';
import { sha256 } from './tables.js';

/*
 * The one 1.0 store that is not SQLite: Postgres project sync (decision 4A).
 * 1.0 keeps it in `public`, 1.1 in `v11` (D3), in the same Supabase database.
 * No shipped client writes /sync yet, so these tables are usually empty; the
 * cutover still mirrors them per user so nothing written there is lost:
 *
 *   BEGIN
 *   DELETE v11 rows the import put there before (and any id 1.0 now has) for this user
 *   INSERT v11.sync_projects / sync_op_log / sync_receipts  SELECT ... FROM public WHERE user_id = $1
 *   COMMIT
 *
 * READ_ONLY=1 on editify-dm refuses /sync writes too, so a copy taken in the
 * read-only window is final: the delta simply copies every user again.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLES = {
  sync_projects: { columns: ['id', 'user_id', 'title', 'doc', 'revision', 'last_seq', 'created_at', 'updated_at'], order: 'id' },
  sync_op_log: {
    columns: ['project_id', 'seq', 'user_id', 'kind', 'ops', 'revision', 'after_doc', 'undone', 'run_id', 'undo_target_seq', 'change_id', 'created_at'],
    order: 'project_id, seq',
  },
  sync_receipts: {
    columns: ['project_id', 'change_id', 'user_id', 'base_revision', 'revision', 'seq', 'hash', 'request_digest', 'created_at'],
    order: 'project_id, change_id',
  },
} as const;

export interface PgUserDigest { projects: string[]; counts: Record<string, number>; digest: string }

export class PgSyncCopy {
  constructor(private readonly pool: pg.Pool, readonly sourceSchema = 'public', readonly destSchema = 'v11') {
    for (const schema of [sourceSchema, destSchema]) if (!SCHEMA_NAME.test(schema)) throw new Error(`Not a schema name: ${schema}`);
    if (sourceSchema === destSchema) throw new Error('The sync copy needs two different schemas');
  }

  /** Users with synced projects in 1.0's schema. */
  async owners(): Promise<string[]> {
    const { rows } = await this.pool.query<{ user_id: string }>(`SELECT DISTINCT user_id::text AS user_id FROM "${this.sourceSchema}".sync_projects ORDER BY 1`);
    return rows.map((row) => row.user_id);
  }

  /**
   * Replaces the user's copied rows in the 1.1 schema with 1.0's, in one
   * transaction. `previous` are project ids an earlier import put there.
   * Returns the project ids now copied (the caller ledgers them).
   */
  async copyUser(user: string, previous: string[]): Promise<string[]> {
    if (!UUID.test(user)) return [];
    const src = this.sourceSchema;
    const dst = this.destSchema;
    return await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM "${src}".sync_projects WHERE user_id = $1 ORDER BY id`, [user]);
      const ids = rows.map((row) => row.id);
      const stale = [...new Set([...previous, ...ids])];
      // Cascades take the old log and receipts with them.
      if (stale.length) await client.query(`DELETE FROM "${dst}".sync_projects WHERE id = ANY($1::text[]) AND user_id = $2`, [stale, user]);
      for (const [table, { columns }] of Object.entries(TABLES)) {
        const list = columns.join(', ');
        await client.query(`INSERT INTO "${dst}".${table} (${list}) SELECT ${list} FROM "${src}".${table} WHERE user_id = $1`, [user]);
      }
      return ids;
    });
  }

  /** Content digest of a user's sync rows in one schema; `only` limits it to those project ids. */
  async digest(schema: string, user: string, only?: Set<string>): Promise<PgUserDigest> {
    if (!SCHEMA_NAME.test(schema)) throw new Error(`Not a schema name: ${schema}`);
    const counts: Record<string, number> = {};
    const parts: string[] = [];
    let projects: string[] = [];
    if (!UUID.test(user)) return { projects, counts, digest: sha256('') };
    for (const [table, { columns, order }] of Object.entries(TABLES)) {
      const projectColumn = table === 'sync_projects' ? 'id' : 'project_id';
      const { rows } = await this.pool.query<Record<string, unknown>>(
        `SELECT ${columns.map((column) => (column === 'doc' || column === 'ops' || column === 'after_doc' ? `${column}::text AS ${column}` : column)).join(', ')}
         FROM "${schema}".${table} WHERE user_id = $1 ORDER BY ${order}`,
        [user],
      );
      const kept = only ? rows.filter((row) => only.has(String(row[projectColumn]))) : rows;
      if (table === 'sync_projects') projects = kept.map((row) => String(row.id));
      counts[table] = kept.length;
      parts.push(sha256(kept.map((row) => JSON.stringify(columns.map((column) => {
        const value = row[column];
        return value instanceof Date ? value.toISOString() : value ?? null;
      }))).join('\n')));
    }
    return { projects, counts, digest: sha256(parts.join(':')) };
  }
}
