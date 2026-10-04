import type { EditifyDatabase } from '../../src/db/database.js';

/*
 * The importer's bookkeeping, kept in the 1.1 SQLite next to the data it
 * describes, so a row and the record of importing it commit together.
 *
 *   import_state     watermark J, the snapshot it came from, how far the delta replayed
 *   import_files     every media file copied and verified (size + sha256 against 1.0)
 *   import_ledger    every root row the import wrote, with its owner and tag (beta_copy | cutover)
 *   import_users     users whose import committed, at which watermark
 *   import_failures  user, asset, reason: what kept a user's rows from committing (C3)
 */

export type ImportTag = 'beta_copy' | 'cutover';

export function ensureStateTables(database: EditifyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS import_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      dest_mtime_ms INTEGER NOT NULL,
      verified_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_ledger (
      table_name TEXT NOT NULL,
      pk_json TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tag TEXT NOT NULL CHECK (tag IN ('beta_copy', 'cutover')),
      imported_at TEXT NOT NULL,
      PRIMARY KEY (table_name, pk_json)
    );
    CREATE INDEX IF NOT EXISTS import_ledger_user_idx ON import_ledger(user_id, tag);
    CREATE TABLE IF NOT EXISTS import_users (
      user_id TEXT PRIMARY KEY,
      tag TEXT NOT NULL CHECK (tag IN ('beta_copy', 'cutover')),
      watermark INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      rows INTEGER NOT NULL,
      files INTEGER NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      asset_id TEXT,
      path TEXT,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      first_failed_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL,
      UNIQUE (user_id, asset_id, path)
    );
  `);
}

export function getState(database: EditifyDatabase, key: string): string | undefined {
  return (database.prepare('SELECT value FROM import_state WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setState(database: EditifyDatabase, key: string, value: string): void {
  database.prepare('INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export interface Failure { userId: string; assetId: string | null; path: string | null; reason: string }

export function recordFailure(database: EditifyDatabase, failure: Failure): void {
  const now = new Date().toISOString();
  // UNIQUE treats NULLs as distinct, so the match is done by hand.
  const existing = database.prepare(`
    SELECT id FROM import_failures WHERE user_id = ? AND asset_id IS ? AND path IS ?
  `).get(failure.userId, failure.assetId, failure.path) as { id: number } | undefined;
  if (existing) {
    database.prepare('UPDATE import_failures SET reason = ?, attempts = attempts + 1, last_failed_at = ? WHERE id = ?')
      .run(failure.reason, now, existing.id);
  } else {
    database.prepare(`
      INSERT INTO import_failures (user_id, asset_id, path, reason, first_failed_at, last_failed_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(failure.userId, failure.assetId, failure.path, failure.reason, now, now);
  }
}

export function clearFailures(database: EditifyDatabase, userId: string): void {
  database.prepare('DELETE FROM import_failures WHERE user_id = ?').run(userId);
}

export function listFailures(database: EditifyDatabase): Array<Failure & { attempts: number; lastFailedAt: string }> {
  return (database.prepare(`
    SELECT user_id, asset_id, path, reason, attempts, last_failed_at FROM import_failures ORDER BY user_id, asset_id, path
  `).all() as Array<{ user_id: string; asset_id: string | null; path: string | null; reason: string; attempts: number; last_failed_at: string }>)
    .map((row) => ({ userId: row.user_id, assetId: row.asset_id, path: row.path, reason: row.reason, attempts: row.attempts, lastFailedAt: row.last_failed_at }));
}

export function usersWithFailures(database: EditifyDatabase): Set<string> {
  return new Set((database.prepare('SELECT DISTINCT user_id FROM import_failures').all() as Array<{ user_id: string }>).map((row) => row.user_id));
}

export interface ImportedUser { userId: string; tag: ImportTag; watermark: number; snapshot: string }

export function importedUser(database: EditifyDatabase, userId: string): ImportedUser | undefined {
  const row = database.prepare('SELECT user_id, tag, watermark, snapshot FROM import_users WHERE user_id = ?').get(userId) as
    { user_id: string; tag: ImportTag; watermark: number; snapshot: string } | undefined;
  return row ? { userId: row.user_id, tag: row.tag, watermark: row.watermark, snapshot: row.snapshot } : undefined;
}

/** Root rows the import wrote for a user (any tag), as `table -> Set(pk_json)`. */
export function ledgerFor(database: EditifyDatabase, userId: string, tag?: ImportTag): Map<string, Set<string>> {
  const rows = (tag
    ? database.prepare('SELECT table_name, pk_json FROM import_ledger WHERE user_id = ? AND tag = ?').all(userId, tag)
    : database.prepare('SELECT table_name, pk_json FROM import_ledger WHERE user_id = ?').all(userId)) as Array<{ table_name: string; pk_json: string }>;
  const ledger = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = ledger.get(row.table_name) ?? new Set<string>();
    set.add(row.pk_json);
    ledger.set(row.table_name, set);
  }
  return ledger;
}
