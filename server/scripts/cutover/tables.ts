import { createHash } from 'node:crypto';
import type { EditifyDatabase } from '../../src/db/database.js';

/*
 * The 1.0 SQLite schema as the cutover sees it (server/src/db/database.ts on
 * main): who owns each row, which columns hold media paths, and how a user's
 * rows are gathered. Every table in the source must be listed here: an unknown
 * one stops the import instead of being silently left behind.
 *
 *   root tables (owned, ledgered)      children (follow their parent)
 *   ─────────────────────────────      ──────────────────────────────────────────
 *   projects        user_id        ─▶  operation_log, project_assets, renders, chat_messages
 *   assets          user_id        ─▶  transcripts, insights, dissections, waveforms,
 *                                      face_tracks, video_observations (no FK)
 *   style_profiles  user_id
 *   reports         user_id
 *   settings        `key:<userId>` suffix, else global
 *   webhook_events  global (processed delete-account events)
 *
 * A NULL owner (pre-auth data, the built-in sound library, global settings)
 * is the "shared" scope, imported only by the full cutover.
 */

/** The shared scope's key: rows with a NULL owner. */
export const SHARED = '';
export const displayUser = (user: string): string => (user === SHARED ? '(shared)' : user);

export type TableRule =
  | { kind: 'root'; owner: 'user_id' | 'settings_key' | 'shared' }
  | { kind: 'child'; parent: 'projects' | 'assets'; column: 'project_id' | 'asset_id' };

export const TABLE_RULES: Record<string, TableRule> = {
  projects: { kind: 'root', owner: 'user_id' },
  assets: { kind: 'root', owner: 'user_id' },
  style_profiles: { kind: 'root', owner: 'user_id' },
  reports: { kind: 'root', owner: 'user_id' },
  settings: { kind: 'root', owner: 'settings_key' },
  webhook_events: { kind: 'root', owner: 'shared' },
  operation_log: { kind: 'child', parent: 'projects', column: 'project_id' },
  project_assets: { kind: 'child', parent: 'projects', column: 'project_id' },
  renders: { kind: 'child', parent: 'projects', column: 'project_id' },
  chat_messages: { kind: 'child', parent: 'projects', column: 'project_id' },
  transcripts: { kind: 'child', parent: 'assets', column: 'asset_id' },
  insights: { kind: 'child', parent: 'assets', column: 'asset_id' },
  dissections: { kind: 'child', parent: 'assets', column: 'asset_id' },
  waveforms: { kind: 'child', parent: 'assets', column: 'asset_id' },
  face_tracks: { kind: 'child', parent: 'assets', column: 'asset_id' },
  video_observations: { kind: 'child', parent: 'assets', column: 'asset_id' },
};

/** Not app data: the 1.0 journal itself. The cutover's own bookkeeping never exists in a source. */
export const SKIPPED_TABLES = new Set(['mutations']);

/** Insert order: parents before children, so foreign keys hold inside the transaction. */
export const TABLE_ORDER = [
  'projects', 'assets', 'style_profiles', 'reports', 'settings', 'webhook_events',
  'operation_log', 'project_assets', 'renders', 'chat_messages',
  'transcripts', 'insights', 'dissections', 'waveforms', 'face_tracks', 'video_observations',
];

export const ROOT_TABLES = TABLE_ORDER.filter((table) => TABLE_RULES[table]?.kind === 'root');

/** Columns holding an absolute media path on the volume. */
export const PATH_COLUMNS: Record<string, string[]> = {
  assets: ['original_path', 'proxy_path', 'thumbnail_path'],
  renders: ['output_path'],
};

export type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The owner a settings key belongs to: `key:<uuid>` is that user's, anything else is global. */
export function settingsOwner(key: string): string {
  const suffix = key.slice(key.lastIndexOf(':') + 1);
  return key.includes(':') && UUID.test(suffix) ? suffix : SHARED;
}

export const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export interface TableInfo { columns: string[]; pk: string[] }

export function tableInfo(database: EditifyDatabase, table: string): TableInfo {
  const info = database.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string; pk: number }>;
  return {
    columns: info.map((column) => column.name),
    pk: info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
  };
}

/** The app tables in a database, minus SQLite's own, the journal, and the cutover's bookkeeping. */
export function appTables(database: EditifyDatabase): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'import\\_%' ESCAPE '\\'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name).filter((name) => !SKIPPED_TABLES.has(name));
}

/** Throws when the source has a table this importer does not know how to scope. */
export function assertKnownSchema(source: EditifyDatabase): void {
  const unknown = appTables(source).filter((table) => !TABLE_RULES[table]);
  if (unknown.length) {
    throw new Error(`The 1.0 database has tables the cutover does not handle: ${unknown.join(', ')}. Add them to scripts/cutover/tables.ts.`);
  }
}

export function pkOf(row: Row, pk: string[]): string {
  return JSON.stringify(pk.map((column) => row[column] ?? null));
}

/** Every user id that owns something in the database, sorted; the shared scope is not included. */
export function listOwners(database: EditifyDatabase): string[] {
  const present = new Set(appTables(database));
  const owners = new Set<string>();
  for (const table of ['projects', 'assets', 'style_profiles', 'reports']) {
    if (!present.has(table)) continue;
    for (const row of database.prepare(`SELECT DISTINCT user_id FROM ${quote(table)} WHERE user_id IS NOT NULL`).all() as Array<{ user_id: string }>) {
      owners.add(row.user_id);
    }
  }
  if (present.has('settings')) {
    for (const row of database.prepare('SELECT key FROM settings').all() as Array<{ key: string }>) {
      const owner = settingsOwner(row.key);
      if (owner !== SHARED) owners.add(owner);
    }
  }
  return [...owners].sort();
}

function chunked<T>(values: T[], size = 500): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size));
  return chunks;
}

/** Rows of `table` whose `column` is one of `values`, in chunks under SQLite's parameter cap. */
export function rowsWhereIn(database: EditifyDatabase, table: string, column: string, values: unknown[]): Row[] {
  const rows: Row[] = [];
  for (const chunk of chunked(values)) {
    if (!chunk.length) continue;
    rows.push(...database.prepare(`SELECT * FROM ${quote(table)} WHERE ${quote(column)} IN (${chunk.map(() => '?').join(', ')})`).all(...chunk) as Row[]);
  }
  return rows;
}

export type RootFilter = (table: string, pk: string) => boolean;

/**
 * One scope's root rows (small: one per project, asset, profile, report,
 * setting), keyed by table. `rootFilter`, when given, keeps only the roots
 * whose key passes it: on the 1.1 side, what the import put there rather than
 * what 1.1 users made themselves. For the shared scope, video_observations
 * rows whose asset no longer exists ride along here too (they have no FK).
 */
export function scopeRoots(database: EditifyDatabase, user: string, rootFilter?: RootFilter): Map<string, Row[]> {
  const present = new Set(appTables(database));
  const roots = new Map<string, Row[]>();
  const keep = (table: string, list: Row[]): Row[] => {
    if (!rootFilter) return list;
    const { pk } = tableInfo(database, table);
    return list.filter((row) => rootFilter(table, pkOf(row, pk)));
  };
  const owned = (table: string): Row[] => (user === SHARED
    ? database.prepare(`SELECT * FROM ${quote(table)} WHERE user_id IS NULL`).all()
    : database.prepare(`SELECT * FROM ${quote(table)} WHERE user_id = ?`).all(user)) as Row[];
  for (const table of ROOT_TABLES) {
    if (!present.has(table)) continue;
    const rule = TABLE_RULES[table] as Extract<TableRule, { kind: 'root' }>;
    let list: Row[];
    if (rule.owner === 'user_id') list = owned(table);
    else if (rule.owner === 'settings_key') list = (database.prepare('SELECT * FROM settings').all() as Row[]).filter((row) => settingsOwner(String(row.key)) === user);
    else list = user === SHARED ? database.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[] : [];
    roots.set(table, keep(table, list));
  }
  if (user === SHARED && present.has('video_observations') && present.has('assets')) {
    const orphans = database.prepare('SELECT * FROM video_observations WHERE asset_id NOT IN (SELECT id FROM assets)').all() as Row[];
    // Not ledger-filtered: an asset deleted during the delta leaves its observations orphaned on both sides.
    roots.set('video_observations', orphans);
  }
  return roots;
}

/** The tables whose rows the ledger records: real roots, and orphan observations of the shared scope. */
export const LEDGERED_TABLES = new Set([...ROOT_TABLES, 'video_observations']);

/**
 * Every row of `table` in the scope, streamed: root rows from `roots`, child
 * rows read in chunks by parent id (an operation log holds whole documents,
 * so a heavy user's rows are never all in memory at once).
 */
export function* scopeRows(database: EditifyDatabase, table: string, roots: Map<string, Row[]>): Generator<Row> {
  const rule = TABLE_RULES[table];
  if (!rule) return;
  if (rule.kind === 'root') {
    yield* roots.get(table) ?? [];
    return;
  }
  if (!appTables(database).includes(table)) return;
  const ids = (roots.get(rule.parent) ?? []).map((row) => row.id);
  for (const chunk of chunked(ids)) {
    yield* database.prepare(`SELECT * FROM ${quote(table)} WHERE ${quote(rule.column)} IN (${chunk.map(() => '?').join(', ')})`)
      .iterate(...chunk) as Iterable<Row>;
  }
  if (table === 'video_observations') yield* roots.get('video_observations') ?? [];
}

/** Where 1.0 kept its volume and where 1.1 keeps it. Equal on Fly (/data both), different in a local rehearsal. */
export interface PathMap { sourceRoot: string; destRoot: string }

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** A 1.0 absolute path on the volume, moved under the 1.1 root. Anything else is returned unchanged. */
export function rewritePath(value: string, map: PathMap): string {
  const from = trimSlash(map.sourceRoot);
  const to = trimSlash(map.destRoot);
  if (from === to) return value;
  if (value === from) return to;
  return value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
}

/**
 * Path rewriting for one row: the declared path columns, plus any quoted
 * absolute path inside a JSON/text column (`"<sourceRoot>/...`).
 */
export function rewriteRow(table: string, row: Row, map: PathMap): Row {
  const from = trimSlash(map.sourceRoot);
  const to = trimSlash(map.destRoot);
  if (from === to) return row;
  const out: Row = { ...row };
  const pathColumns = new Set(PATH_COLUMNS[table] ?? []);
  for (const [column, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue;
    if (pathColumns.has(column)) out[column] = rewritePath(value, map);
    else if (value.includes(`"${from}/`)) out[column] = value.split(`"${from}/`).join(`"${to}/`);
  }
  return out;
}

function canonicalValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { blob: value.toString('base64') };
  if (typeof value === 'bigint') return value.toString();
  return value ?? null;
}

/** sha256 of a table's rows: only the given columns, key-sorted, so 1.1's extra columns do not count. */
export function tableDigest(rows: Row[], columns: string[], pk: string[]): string {
  const lines = rows
    .map((row) => ({ key: pkOf(row, pk), line: JSON.stringify(columns.map((column) => [column, canonicalValue(row[column])])) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.line);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
