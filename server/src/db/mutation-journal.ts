import type { EditifyDatabase } from './database.js';

/**
 * An append-only journal of every row change, written by SQLite triggers
 * (plan C19). The 1.1 cutover copies a bulk snapshot of this database up to a
 * journal id J, then replays every mutation after J once 1.0 is frozen, so
 * nothing written between the snapshot and the freeze is lost.
 *
 * Installed only with MUTATION_JOURNAL=1. Without it there is no `mutations`
 * table and no trigger, so the flag-off server behaves exactly as before.
 * Turning the flag off again drops the triggers but keeps the journal rows.
 *
 * Replay semantics, for the importer:
 * - `insert` carries the new row; apply it as an upsert. `INSERT OR REPLACE`
 *   and `ON CONFLICT DO UPDATE` both land here or as `update`, and a REPLACE's
 *   implicit delete of the old row does not fire a delete trigger.
 * - `update` carries the primary key as it was BEFORE the change and the row
 *   after it, so a changed primary key still finds its row.
 * - `delete` carries the row as it was before the delete. Cascaded deletes are
 *   journaled too: SQLite fires triggers for foreign-key actions.
 * - `id` is AUTOINCREMENT: strictly increasing, never reused.
 */

export type MutationOp = 'insert' | 'update' | 'delete';

export interface Mutation {
  id: number;
  table: string;
  op: MutationOp;
  /** Primary-key columns and their values; `{ rowid }` for a table without one. */
  pk: Record<string, unknown>;
  /** Every column: after the change for insert/update, before it for delete. */
  row: Record<string, unknown>;
  createdAt: string;
}

const JOURNAL_TABLE = 'mutations';
const TRIGGER_PREFIX = 'mutations_journal_';
const OPS: Array<{ op: MutationOp; event: 'INSERT' | 'UPDATE' | 'DELETE'; pkFrom: 'NEW' | 'OLD'; rowFrom: 'NEW' | 'OLD' }> = [
  { op: 'insert', event: 'INSERT', pkFrom: 'NEW', rowFrom: 'NEW' },
  { op: 'update', event: 'UPDATE', pkFrom: 'OLD', rowFrom: 'NEW' },
  { op: 'delete', event: 'DELETE', pkFrom: 'OLD', rowFrom: 'OLD' },
];

export function journalEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MUTATION_JOURNAL === '1';
}

const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Every table holding app data: all of them except SQLite's own and the journal itself. */
export function journaledTables(database: EditifyDatabase): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?
    ORDER BY name
  `).all(JOURNAL_TABLE) as Array<{ name: string }>).map((row) => row.name);
}

function journalTriggerNames(database: EditifyDatabase): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ESCAPE '\\'")
    .all(`${TRIGGER_PREFIX.replace(/_/g, '\\_')}%`) as Array<{ name: string }>).map((row) => row.name);
}

function jsonObject(source: 'NEW' | 'OLD', columns: string[]): string {
  return `json_object(${columns.map((column) => `${quoteString(column)}, ${source}.${quoteIdentifier(column)}`).join(', ')})`;
}

/**
 * Installs or removes the journal. Triggers are rebuilt on every boot, after
 * migrations, because each one lists its table's columns: a column added by a
 * later migration must show up in the journaled row.
 */
export function configureMutationJournal(database: EditifyDatabase, enabled: boolean): void {
  database.transaction(() => {
    for (const name of journalTriggerNames(database)) database.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
    if (!enabled) return;
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
        pk_json TEXT NOT NULL,
        row_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    for (const table of journaledTables(database)) {
      const info = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; pk: number }>;
      const columns = info.map((column) => column.name);
      const pkColumns = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
      for (const { op, event, pkFrom, rowFrom } of OPS) {
        const pk = pkColumns.length ? jsonObject(pkFrom, pkColumns) : `json_object('rowid', ${pkFrom}.rowid)`;
        database.exec(`
          CREATE TRIGGER ${quoteIdentifier(`${TRIGGER_PREFIX}${table}_${op}`)}
          AFTER ${event} ON ${quoteIdentifier(table)}
          BEGIN
            INSERT INTO ${JOURNAL_TABLE} (table_name, op, pk_json, row_json)
            VALUES (${quoteString(table)}, '${op}', ${pk}, ${jsonObject(rowFrom, columns)});
          END
        `);
      }
    }
  })();
}

/** Whether this database has a journal at all (it never does with the flag off). */
export function hasMutationJournal(database: EditifyDatabase): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(JOURNAL_TABLE));
}

/** The newest journal id, 0 for an empty journal: the J a bulk snapshot is cut at. */
export function latestMutationId(database: EditifyDatabase): number {
  if (!hasMutationJournal(database)) return 0;
  const row = database.prepare(`SELECT MAX(id) AS id FROM ${JOURNAL_TABLE}`).get() as { id: number | null };
  return row.id ?? 0;
}

/** Mutations with an id greater than `afterId`, oldest first, at most `limit` of them. */
export function readMutationsAfter(database: EditifyDatabase, afterId: number, limit = 1000): Mutation[] {
  if (!hasMutationJournal(database)) return [];
  const rows = database.prepare(`
    SELECT id, table_name, op, pk_json, row_json, created_at FROM ${JOURNAL_TABLE}
    WHERE id > ? ORDER BY id ASC LIMIT ?
  `).all(afterId, limit) as Array<{ id: number; table_name: string; op: MutationOp; pk_json: string; row_json: string; created_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    table: row.table_name,
    op: row.op,
    pk: JSON.parse(row.pk_json) as Record<string, unknown>,
    row: JSON.parse(row.row_json) as Record<string, unknown>,
    createdAt: row.created_at,
  }));
}

/** Every mutation after `afterId`, in pages, for a replay that should not hold the whole delta in memory. */
export function* iterateMutationsAfter(database: EditifyDatabase, afterId: number, pageSize = 1000): Generator<Mutation> {
  let cursor = afterId;
  for (;;) {
    const page = readMutationsAfter(database, cursor, pageSize);
    yield* page;
    const last = page.at(-1);
    if (!last || page.length < pageSize) return;
    cursor = last.id;
  }
}
