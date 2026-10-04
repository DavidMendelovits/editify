/**
 * The 1.0 ─▶ 1.1 cutover importer (release/1.1 plan T9, T16; D14, D15, C3, C6,
 * C8, C11, C18, C19, C21, C22). It runs inside editify-v11 (the only machine that
 * can mount editify_v11_data) and pulls from editify-dm over Fly's private 6PN
 * network through the read-only source agent (source-agent.mjs). Commands and
 * the production order are in RUNBOOK.md; the CLI is cutover.ts.
 *
 *  editify-dm (1.0)                          editify-v11 (1.1)
 *  ────────────────                          ─────────────────────────────────────────────
 *  source-agent.mjs serve ──6PN :7373──▶     cutover.ts (this module)
 *    GET  /du        du per directory ─────▶   measure: v11 volume should be 1.5x (C11)
 *    POST /snapshot  backup API copy  ─────▶   snapshot: /data/cutover/snapshots/*.db, J = its max journal id
 *    GET  /manifest  size + sha256    ─────▶   copy: originals, proxies, renders (C3, C21)
 *    GET  /file      bytes            ─────▶     space check first: free >= 1.2x remaining or abort (C11)
 *                                              each file: download, fsync, re-read, size + sha256 == 1.0's
 *                                            import (per user, SHARED scope first):
 *                                              all of the user's files verified? ─ no ─▶ import_failures, skip
 *                                              yes: ONE transaction:
 *                                                drop beta_copy rows (C18), drop rows 1.0 no longer has,
 *                                                upsert every table with paths rewritten, ledger + import_users
 *                                            ── 1.0 READ_ONLY=1 (C20) ──
 *    POST /snapshot  final copy       ─────▶   delta: copy new files, replay `mutations` id > J (C19)
 *                                              insert/update = upsert, delete = delete (cascades journaled too)
 *                                            dry-run: per-user content hash, rows + files, 1.0 vs 1.1;
 *                                              any diff ─▶ exit 1
 *
 * Re-runs are idempotent: verified files are skipped, a user already imported
 * at the current snapshot is skipped unless --force, and only failed or new
 * users are retried. Postgres project sync (public ─▶ v11) rides along when
 * DATABASE_URL is set (pg-copy.ts).
 *
 * Two guards keep the delta's promise: `import --all` refuses a snapshot whose
 * journal is off or missing triggers (the delta could not replay what follows
 * it), and once the delta has started every import refuses, because 1.1 is
 * live and a re-import rewrites imported projects' children from 1.0. The
 * delta retries its own file failures on a re-run.
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import type { EditifyDatabase } from '../../src/db/database.js';
import { hasMutationJournal, iterateMutationsAfter, journaledTables, latestMutationId, type Mutation } from '../../src/db/mutation-journal.js';
import {
  assertSpace,
  copyFiles,
  freeBytesOf,
  groupByOwnerDir,
  indexManifest,
  orphanFiles,
  planFiles,
  remainingBytes,
  unverifiedFiles,
  type FilePlan,
  type ManifestIndex,
  type MediaFile,
} from './media.js';
import type { PgSyncCopy } from './pg-copy.js';
import type { CutoverSource, DuReport, ManifestEntry, SnapshotInfo } from './source.js';
import { sha256File } from './source-agent.mjs';
import {
  clearFailures,
  ensureStateTables,
  getState,
  importedUser,
  ledgerFor,
  listFailures,
  recordFailure,
  setState,
  usersWithFailures,
  type ImportTag,
} from './state.js';
import {
  LEDGERED_TABLES,
  SHARED,
  TABLE_ORDER,
  TABLE_RULES,
  appTables,
  assertKnownSchema,
  displayUser,
  listOwners,
  pkOf,
  quote,
  rewriteRow,
  rowsWhereIn,
  scopeRoots,
  scopeRows,
  settingsOwner,
  sha256,
  tableInfo,
  type PathMap,
  type Row,
  type TableInfo,
} from './tables.js';

export type Scope = { kind: 'all' } | { kind: 'users'; users: string[] };

export interface ImporterOptions {
  source: CutoverSource;
  /** The 1.1 SQLite, opened writable (createDatabase). */
  dest: EditifyDatabase;
  /** The 1.1 volume root (/data on Fly). */
  destRoot: string;
  /** The 1.0 volume root the stored paths start with (/data on Fly). */
  sourceRoot?: string;
  /** Snapshots and scratch; default <destRoot>/cutover, which the media copy never touches. */
  workDir?: string;
  pg?: PgSyncCopy | undefined;
  freeBytes?: (path: string) => Promise<number>;
  concurrency?: number;
  log?: (line: string) => void;
}

export interface UserReport {
  user: string;
  status: 'imported' | 'skipped' | 'failed';
  rows: number;
  files: number;
  bytes: number;
  reasons: string[];
}

export interface ImportReport {
  watermark: number;
  /** False when the snapshot has no complete mutations journal (a --without-journal rehearsal): the delta will refuse. */
  journal: boolean;
  snapshot: string;
  users: UserReport[];
  copied: number;
  copiedBytes: number;
  missing: string[];
  external: string[];
  orphans: string[];
}

export interface DeltaReport { from: number; through: number; applied: number; byOp: Record<string, number>; copied: number; failures: number }

export interface TableDiff { table: string; sourceRows: number; destRows: number; missing: string[]; extra: string[]; changed: string[] }
export interface FileDiff { path: string; problem: 'missing' | 'size' | 'sha256' | 'extra' }
export interface DryRunUser {
  user: string;
  rows: number;
  files: number;
  bytes: number;
  sourceHash: string;
  destHash: string;
  tables: TableDiff[];
  fileDiffs: FileDiff[];
  pg?: { source: string; dest: string; counts: Record<string, number> };
}
export interface DryRunReport { snapshot: string; watermark: number; users: DryRunUser[]; diffs: number }

export interface MeasureReport { source: DuReport; destFree: number; recommendedVolumeBytes: number }

interface Prepared {
  snap: EditifyDatabase;
  snapshotName: string;
  watermark: number;
  index: ManifestIndex;
  groups: Map<string, ManifestEntry[]>;
}

interface UserPlan {
  user: string;
  roots: Map<string, Row[]>;
  renders: Row[];
  /** Assets the user's projects link but someone else owns, absent on 1.1: imported alongside, not ledgered. */
  depRoots: Map<string, Row[]>;
  files: FilePlan;
  depFiles: FilePlan;
}

const STATE_SNAPSHOT = 'current_snapshot';
const STATE_BULK_WATERMARK = 'bulk_watermark';
const STATE_DELTA_THROUGH = 'delta_through';
/** Set when the first delta starts (after the App Store release): from then on an import would wipe 1.1 users' writes. */
const STATE_DELTA_STARTED = 'delta_started';
/** '1' when the bulk import's snapshot had the journal and all its triggers, '0' when it ran without them. */
const STATE_BULK_JOURNAL = 'bulk_journal';
/** Failures the delta records carry this prefix, so a re-run of the delta retries them itself. */
const DELTA_FAILURE = 'delta: ';

/** Whether a 1.0 database has the journal table and all three triggers on every table it journals (C19). */
export function journalComplete(database: EditifyDatabase): { ok: boolean; missing: string[] } {
  if (!hasMutationJournal(database)) return { ok: false, missing: ['the mutations table'] };
  const triggers = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((row) => row.name));
  const missing = journaledTables(database).flatMap((table) => ['insert', 'update', 'delete']
    .map((op) => `mutations_journal_${table}_${op}`)
    .filter((name) => !triggers.has(name)));
  return { ok: missing.length === 0, missing };
}

const ASSET_CHILDREN = TABLE_ORDER.filter((table) => {
  const rule = TABLE_RULES[table];
  return rule?.kind === 'child' && rule.parent === 'assets';
});
const PROJECT_CHILDREN = TABLE_ORDER.filter((table) => {
  const rule = TABLE_RULES[table];
  return rule?.kind === 'child' && rule.parent === 'projects';
});

export class Importer {
  private readonly source: CutoverSource;
  private readonly dest: EditifyDatabase;
  private readonly destRoot: string;
  private readonly paths: PathMap;
  private readonly workDir: string;
  private readonly pg: PgSyncCopy | undefined;
  private readonly freeBytes: (path: string) => Promise<number>;
  private readonly concurrency: number;
  private readonly log: (line: string) => void;
  private readonly destInfo = new Map<string, TableInfo>();
  private readonly statements = new Map<string, Database.Statement>();

  constructor(options: ImporterOptions) {
    this.source = options.source;
    this.dest = options.dest;
    this.destRoot = options.destRoot;
    this.paths = { sourceRoot: options.sourceRoot ?? '/data', destRoot: options.destRoot };
    this.workDir = options.workDir ?? join(options.destRoot, 'cutover');
    this.pg = options.pg;
    this.freeBytes = options.freeBytes ?? freeBytesOf;
    this.concurrency = options.concurrency ?? 4;
    this.log = options.log ?? (() => undefined);
    // The live 1.1 server shares this file: wait out its writes instead of failing with SQLITE_BUSY.
    // Every write transaction here is IMMEDIATE: one that reads first (dropPrevious, replay) would
    // otherwise fail its first write at once, without the timeout, while the server holds the lock.
    this.dest.pragma('busy_timeout = 15000');
    this.dest.pragma('foreign_keys = ON');
    ensureStateTables(this.dest);
  }

  // ── measure ───────────────────────────────────────────────────────────────

  /** C11: du per directory on 1.0, free space on 1.1, and the 1.5x volume size to provision. */
  async measure(): Promise<MeasureReport> {
    const source = await this.source.du();
    return { source, destFree: await this.freeBytes(this.destRoot), recommendedVolumeBytes: Math.ceil(source.total.bytes * 1.5) };
  }

  // ── snapshot ──────────────────────────────────────────────────────────────

  /** A backup API copy of the 1.0 database, downloaded and made the snapshot every later step reads. */
  async snapshot(): Promise<SnapshotInfo & { path: string }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.workDir, 'snapshots', `editify-1.0-${stamp}.db`);
    await mkdir(join(this.workDir, 'snapshots'), { recursive: true });
    const info = await this.source.snapshot(path);
    const snap = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const watermark = latestMutationId(snap);
      if (watermark !== info.journalId) throw new Error(`The snapshot's journal id ${watermark} differs from the source's ${info.journalId}`);
      assertKnownSchema(snap);
    } finally {
      snap.close();
    }
    setState(this.dest, STATE_SNAPSHOT, path);
    this.log(`snapshot ${basename(path)}: ${info.size} bytes, journal id J=${info.journalId}`);
    return { ...info, path };
  }

  private async prepare(): Promise<Prepared> {
    const path = getState(this.dest, STATE_SNAPSHOT);
    if (!path) throw new Error('No snapshot yet: run `snapshot` first.');
    const snap = new Database(path, { readonly: true, fileMustExist: true });
    assertKnownSchema(snap);
    this.assertCompatible(snap);
    const entries = await this.source.manifest();
    return { snap, snapshotName: basename(path), watermark: latestMutationId(snap), index: indexManifest(entries), groups: groupByOwnerDir(entries) };
  }

  /** Every 1.0 column must exist in 1.1 (1.1 may add columns, never drop them), or rows would lose data. */
  private assertCompatible(snap: EditifyDatabase): void {
    const destTables = new Set(appTables(this.dest));
    for (const table of appTables(snap)) {
      if (!destTables.has(table)) throw new Error(`1.1 has no ${table} table`);
      const missing = tableInfo(snap, table).columns.filter((column) => !this.info(table).columns.includes(column));
      if (missing.length) throw new Error(`1.1's ${table} lacks 1.0 column(s) ${missing.join(', ')}`);
    }
  }

  private info(table: string): TableInfo {
    let info = this.destInfo.get(table);
    if (!info) {
      info = tableInfo(this.dest, table);
      this.destInfo.set(table, info);
    }
    return info;
  }

  private scopeUsers(prepared: Prepared, scope: Scope): string[] {
    if (scope.kind === 'users') return [...new Set(scope.users)];
    // SHARED first: the sound library and other NULL-owner assets that users' projects link to.
    const ledgered = (this.dest.prepare('SELECT DISTINCT user_id FROM import_ledger').all() as Array<{ user_id: string }>).map((row) => row.user_id);
    return [SHARED, ...[...new Set([...listOwners(prepared.snap), ...ledgered])].filter((user) => user !== SHARED).sort()];
  }

  private planUser(prepared: Prepared, user: string): UserPlan {
    const { snap, index, groups } = prepared;
    const roots = scopeRoots(snap, user);
    const renders = [...scopeRows(snap, 'renders', roots)];
    const own = new Set((roots.get('assets') ?? []).map((row) => String(row.id)));
    const linked = [...new Set([...scopeRows(snap, 'project_assets', roots)].map((row) => String(row.asset_id)))]
      .filter((id) => !own.has(id) && !this.dest.prepare('SELECT 1 FROM assets WHERE id = ?').get(id));
    const depRoots = new Map<string, Row[]>([['assets', rowsWhereIn(snap, 'assets', 'id', linked)]]);
    return {
      user,
      roots,
      renders,
      depRoots,
      files: planFiles(new Map([['assets', roots.get('assets') ?? []], ['renders', renders]]), user, index, groups, this.paths.sourceRoot),
      depFiles: planFiles(depRoots, 'dependency', index, groups, this.paths.sourceRoot),
    };
  }

  // ── copy ──────────────────────────────────────────────────────────────────

  /** C11 space check, then the verified copy of every file the plans need. */
  private async copyPlans(prepared: Prepared, plans: UserPlan[]): Promise<{ copied: number; bytes: number; failed: Map<string, string> }> {
    const files = new Map<string, MediaFile>();
    for (const plan of plans) for (const file of [...plan.files.files, ...plan.depFiles.files]) files.set(file.path, file);
    const list = [...files.values()];
    const context = { database: this.dest, source: this.source, index: prepared.index, destRoot: this.destRoot, concurrency: this.concurrency, log: this.log };
    const remaining = await remainingBytes(context, list);
    const free = await this.freeBytes(this.destRoot);
    this.log(`space: ${remaining} bytes to copy, ${free} free on 1.1 (need 1.2x)`);
    assertSpace(free, remaining);
    const result = await copyFiles(context, list);
    this.log(`copy: ${result.copied} copied (${result.bytes} bytes), ${result.skipped} already verified, ${result.failures.length} failed`);
    return { copied: result.copied, bytes: result.bytes, failed: new Map(result.failures.map((failure) => [failure.file.path, failure.reason])) };
  }

  /** The bulk media copy alone (the long step, run ahead of the import). Nothing in SQLite changes but import_files. */
  async copy(scope: Scope): Promise<{ copied: number; bytes: number; failed: number }> {
    const prepared = await this.prepare();
    try {
      const plans = this.scopeUsers(prepared, scope).map((user) => this.planUser(prepared, user));
      const result = await this.copyPlans(prepared, plans);
      return { copied: result.copied, bytes: result.bytes, failed: result.failed.size };
    } finally {
      prepared.snap.close();
    }
  }

  // ── import ────────────────────────────────────────────────────────────────

  /**
   * The bulk import. `--user` scopes are tagged beta_copy (C8, C18); the full
   * scope is the cutover, which replaces each user's beta_copy rows in the same
   * transaction that imports their real ones.
   */
  async import(scope: Scope, options: { force?: boolean; withoutJournal?: boolean } = {}): Promise<ImportReport> {
    const tag: ImportTag = scope.kind === 'all' ? 'cutover' : 'beta_copy';
    if (getState(this.dest, STATE_DELTA_STARTED) !== undefined) {
      // 1.1 is live by then: a re-import rewrites every imported project's children from 1.0 and so
      // drops the chats, edits and renders (files too) 1.1 users made under them. Re-run `delta` instead.
      throw new Error('The delta has started, so 1.1 is live: an import now would wipe what 1.1 users wrote under imported projects. Re-run `delta` (it retries its own failures).');
    }
    if (scope.kind === 'users' && getState(this.dest, STATE_BULK_WATERMARK) !== undefined) {
      throw new Error('The cutover bulk import has run: a --user import now would turn real data back into a beta_copy. Use import --all.');
    }
    const prepared = await this.prepare();
    try {
      const journal = journalComplete(prepared.snap);
      if (scope.kind === 'all' && !journal.ok && !options.withoutJournal) {
        throw new Error(`The snapshot's mutations journal is incomplete (missing ${journal.missing.slice(0, 3).join(', ')}${journal.missing.length > 3 ? ', ...' : ''}), so the delta could not replay what 1.0 writes after it. Set MUTATION_JOURNAL=1 on editify-dm, check \`source-agent.mjs status\`, then take a new snapshot (C19). --without-journal only for a rehearsal.`);
      }
      const users = this.scopeUsers(prepared, scope);
      const failing = usersWithFailures(this.dest);
      const pending = users.filter((user) => {
        if (options.force || failing.has(user)) return true;
        const done = importedUser(this.dest, user);
        return !(done && done.tag === tag && done.snapshot === prepared.snapshotName);
      });
      const plans = pending.map((user) => this.planUser(prepared, user));
      const copy = await this.copyPlans(prepared, plans);
      if (scope.kind === 'all' && !journal.ok) this.log('WARNING: --without-journal: writes to 1.0 after this snapshot cannot be replayed, and the delta will refuse to run.');
      const report: ImportReport = {
        watermark: prepared.watermark,
        journal: journal.ok,
        snapshot: prepared.snapshotName,
        users: users.filter((user) => !pending.includes(user)).map((user) => ({ user, status: 'skipped', rows: 0, files: 0, bytes: 0, reasons: ['already imported at this snapshot'] })),
        copied: copy.copied,
        copiedBytes: copy.bytes,
        missing: [...new Set(plans.flatMap((plan) => plan.files.missing))].sort(),
        external: [...new Set(plans.flatMap((plan) => plan.files.external))].sort(),
        orphans: scope.kind === 'all'
          ? orphanFiles(prepared.index, new Set(plans.flatMap((plan) => [...plan.files.files, ...plan.depFiles.files].map((file) => file.path))))
          : [],
      };
      for (const plan of plans) report.users.push(await this.importUser(prepared, plan, tag, copy.failed));
      if (scope.kind === 'all' && !report.users.some((user) => user.status === 'failed')) {
        setState(this.dest, STATE_BULK_WATERMARK, String(prepared.watermark));
        setState(this.dest, STATE_DELTA_THROUGH, String(prepared.watermark));
        setState(this.dest, STATE_BULK_JOURNAL, journal.ok ? '1' : '0');
      }
      return report;
    } finally {
      prepared.snap.close();
    }
  }

  private async importUser(prepared: Prepared, plan: UserPlan, tag: ImportTag, copyFailures: Map<string, string>): Promise<UserReport> {
    const { user } = plan;
    const context = { database: this.dest, destRoot: this.destRoot, index: prepared.index };
    const ownBad = await unverifiedFiles(context, plan.files.files);
    const depBad = await unverifiedFiles(context, plan.depFiles.files);
    const fileCount = plan.files.files.length;
    const bytes = plan.files.files.reduce((sum, file) => sum + (prepared.index.get(file.path)?.size ?? 0), 0);
    if (ownBad.length || depBad.length) {
      const reasons: string[] = [];
      for (const file of [...ownBad, ...depBad]) {
        const reason = copyFailures.get(file.path) ?? 'not verified on the 1.1 volume';
        recordFailure(this.dest, { userId: user, assetId: file.owner.id, path: file.path, reason });
        reasons.push(`${file.path}: ${reason}`);
      }
      this.dest.prepare('DELETE FROM import_users WHERE user_id = ?').run(user);
      this.log(`${displayUser(user)}: NOT imported, ${reasons.length} file(s) unverified`);
      return { user, status: 'failed', rows: 0, files: fileCount, bytes, reasons };
    }

    const before = this.ledgeredMediaIds(user);
    let rows = 0;
    this.dest.transaction(() => {
      this.dropPrevious(plan);
      for (const table of ['assets', ...ASSET_CHILDREN]) {
        for (const row of scopeRows(prepared.snap, table, plan.depRoots)) this.write(table, rewriteRow(table, row, this.paths), 'ignore');
      }
      for (const table of TABLE_ORDER) {
        for (const row of scopeRows(prepared.snap, table, plan.roots)) {
          this.write(table, rewriteRow(table, row, this.paths), 'upsert');
          rows += 1;
        }
      }
      const now = new Date().toISOString();
      const ledger = this.dest.prepare('INSERT OR REPLACE INTO import_ledger (table_name, pk_json, user_id, tag, imported_at) VALUES (?, ?, ?, ?, ?)');
      for (const [table, list] of plan.roots) {
        if (!LEDGERED_TABLES.has(table)) continue;
        const { pk } = tableInfo(prepared.snap, table);
        for (const row of list) ledger.run(table, pkOf(row, pk), user, tag, now);
      }
      this.dest.prepare(`
        INSERT INTO import_users (user_id, tag, watermark, snapshot, rows, files, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET tag = excluded.tag, watermark = excluded.watermark, snapshot = excluded.snapshot,
          rows = excluded.rows, files = excluded.files, imported_at = excluded.imported_at
      `).run(user, tag, prepared.watermark, prepared.snapshotName, rows, fileCount, now);
      clearFailures(this.dest, user);
    }).immediate();
    await this.removeStaleMedia(before);

    if (this.pg && user !== SHARED) {
      try {
        const previous = [...(ledgerFor(this.dest, user).get('pg.sync_projects') ?? [])].map((pk) => (JSON.parse(pk) as string[])[0] as string);
        const copied = await this.pg.copyUser(user, previous);
        this.ledgerPg(user, tag, copied);
      } catch (error) {
        const reason = `postgres sync copy failed: ${error instanceof Error ? error.message : String(error)}`;
        recordFailure(this.dest, { userId: user, assetId: null, path: null, reason });
        this.dest.prepare('DELETE FROM import_users WHERE user_id = ?').run(user);
        return { user, status: 'failed', rows, files: fileCount, bytes, reasons: [reason] };
      }
    }
    this.log(`${displayUser(user)}: imported ${rows} rows, ${fileCount} files (${tag})`);
    return { user, status: 'imported', rows, files: fileCount, bytes, reasons: [] };
  }

  private ledgerPg(user: string, tag: ImportTag, projectIds: string[]): void {
    const now = new Date().toISOString();
    this.dest.transaction(() => {
      this.dest.prepare("DELETE FROM import_ledger WHERE table_name = 'pg.sync_projects' AND user_id = ?").run(user);
      const insert = this.dest.prepare('INSERT OR REPLACE INTO import_ledger (table_name, pk_json, user_id, tag, imported_at) VALUES (?, ?, ?, ?, ?)');
      for (const id of projectIds) insert.run('pg.sync_projects', JSON.stringify([id]), user, tag, now);
    }).immediate();
  }

  /**
   * Inside the user's transaction, before the insert:
   * - beta_copy roots go entirely, cascading whatever 1.1 testers added under them (C18);
   * - cutover roots 1.0 no longer has go too;
   * - roots that stay lose their children, which the import rewrites from 1.0.
   */
  private dropPrevious(plan: UserPlan): void {
    const incoming = new Map<string, Set<string>>();
    for (const [table, list] of plan.roots) {
      const { pk } = this.info(table);
      incoming.set(table, new Set(list.map((row) => pkOf(row, pk))));
    }
    const ledgered = this.dest.prepare("SELECT table_name, pk_json, tag FROM import_ledger WHERE user_id = ? AND table_name NOT LIKE 'pg.%'")
      .all(plan.user) as Array<{ table_name: string; pk_json: string; tag: ImportTag }>;
    const deletedAssets: string[] = [];
    const keptParents = { projects: [] as unknown[], assets: [] as unknown[] };
    // Delete in reverse dependency order so children of a dropped project go before assets they link.
    const order = [...TABLE_ORDER, 'video_observations'].reverse();
    ledgered.sort((a, b) => order.indexOf(a.table_name) - order.indexOf(b.table_name));
    for (const entry of ledgered) {
      const values = JSON.parse(entry.pk_json) as unknown[];
      const stays = entry.tag === 'cutover' && incoming.get(entry.table_name)?.has(entry.pk_json);
      if (stays) {
        if (entry.table_name === 'projects' || entry.table_name === 'assets') keptParents[entry.table_name].push(values[0]);
        continue;
      }
      if (entry.table_name === 'assets') deletedAssets.push(String(values[0]));
      this.deleteByPk(entry.table_name, values);
    }
    for (const table of PROJECT_CHILDREN) this.deleteWhereIn(table, 'project_id', keptParents.projects);
    for (const table of ASSET_CHILDREN) this.deleteWhereIn(table, 'asset_id', keptParents.assets);
    // video_observations has no foreign key, so a dropped asset's rows are removed by hand.
    this.deleteWhereIn('video_observations', 'asset_id', deletedAssets);
    this.dest.prepare("DELETE FROM import_ledger WHERE user_id = ? AND table_name NOT LIKE 'pg.%'").run(plan.user);
  }

  private deleteByPk(table: string, values: unknown[]): void {
    const { pk } = this.info(table);
    this.statement(`DELETE FROM ${quote(table)} WHERE ${pk.map((column) => `${quote(column)} IS ?`).join(' AND ')}`).run(...values);
  }

  private deleteWhereIn(table: string, column: string, values: unknown[]): void {
    for (let start = 0; start < values.length; start += 500) {
      const chunk = values.slice(start, start + 500);
      this.dest.prepare(`DELETE FROM ${quote(table)} WHERE ${quote(column)} IN (${chunk.map(() => '?').join(', ')})`).run(...chunk);
    }
  }

  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.dest.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Upsert by primary key over the columns 1.0 has; 1.1-only columns keep their value (or default). */
  private write(table: string, row: Row, mode: 'upsert' | 'ignore'): void {
    const { pk } = this.info(table);
    const columns = Object.keys(row).filter((column) => this.info(table).columns.includes(column));
    const rest = columns.filter((column) => !pk.includes(column));
    const conflict = mode === 'ignore' || !rest.length
      ? 'DO NOTHING'
      : `DO UPDATE SET ${rest.map((column) => `${quote(column)} = excluded.${quote(column)}`).join(', ')}`;
    this.statement(`
      INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
      ON CONFLICT (${pk.map(quote).join(', ')}) ${conflict}
    `).run(...columns.map((column) => row[column] ?? null));
  }

  /** Asset ids and render ids the import put on 1.1 for this user, read before a re-import. */
  private ledgeredMediaIds(user: string): { assets: string[]; renders: string[] } {
    const ledger = ledgerFor(this.dest, user);
    const assets = [...(ledger.get('assets') ?? [])].map((pk) => String((JSON.parse(pk) as unknown[])[0]));
    const projects = [...(ledger.get('projects') ?? [])].map((pk) => String((JSON.parse(pk) as unknown[])[0]));
    const renders: string[] = [];
    for (let start = 0; start < projects.length; start += 500) {
      const chunk = projects.slice(start, start + 500);
      renders.push(...(this.dest.prepare(`SELECT id FROM renders WHERE project_id IN (${chunk.map(() => '?').join(', ')})`).all(...chunk) as Array<{ id: string }>).map((row) => row.id));
    }
    return { assets, renders };
  }

  /** After a commit: media directories whose asset or render row no longer exists on 1.1. */
  private async removeStaleMedia(candidates: { assets: string[]; renders: string[] }): Promise<void> {
    for (const [dir, table, ids] of [['assets', 'assets', candidates.assets], ['renders', 'renders', candidates.renders]] as const) {
      for (const id of ids) {
        if (!id || id.includes('/') || id === '.' || id === '..') continue;
        if (this.dest.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) continue;
        await rm(join(this.destRoot, dir, id), { recursive: true, force: true });
        this.dest.prepare("DELETE FROM import_files WHERE path LIKE ? ESCAPE '\\'").run(`${dir}/${id.replace(/[\\%_]/g, '\\$&')}/%`);
      }
    }
  }

  // ── delta ─────────────────────────────────────────────────────────────────

  /**
   * C19: in the read-only window, a fresh snapshot, the copy of any media that
   * changed, then every journal entry after J replayed in ONE transaction.
   */
  async delta(): Promise<DeltaReport> {
    const bulk = getState(this.dest, STATE_BULK_WATERMARK);
    if (bulk === undefined) throw new Error('No full bulk import has completed: run `import --all` first.');
    if (getState(this.dest, STATE_BULK_JOURNAL) !== '1') {
      throw new Error('The bulk import ran without a complete mutations journal (MUTATION_JOURNAL=1), so writes to 1.0 after its snapshot cannot be replayed: the delta cannot be trusted. Turn the journal on, take a new snapshot and re-run `import --all` before the release (C19).');
    }
    // The delta's own file failures are retried by this run; any other failure is a user the bulk import never committed.
    this.dest.prepare('DELETE FROM import_failures WHERE substr(reason, 1, ?) = ?').run(DELTA_FAILURE.length, DELTA_FAILURE);
    const outstanding = listFailures(this.dest);
    if (outstanding.length) throw new Error(`${outstanding.length} import failure(s) outstanding: fix them and re-run \`import --all\` before the delta.`);
    const from = Number(getState(this.dest, STATE_DELTA_THROUGH) ?? bulk);
    if (getState(this.dest, STATE_DELTA_STARTED) === undefined) setState(this.dest, STATE_DELTA_STARTED, new Date().toISOString());
    await this.snapshot();
    const prepared = await this.prepare();
    try {
      const journal = journalComplete(prepared.snap);
      if (!journal.ok) throw new Error(`The 1.0 snapshot's mutations journal is incomplete (missing ${journal.missing.slice(0, 3).join(', ')}): it was switched off after the bulk snapshot, so writes in that gap are not in it (C19).`);
      if (latestMutationId(prepared.snap) < from) throw new Error(`The 1.0 journal ends at ${latestMutationId(prepared.snap)}, before the bulk watermark ${from}: it was reset, so the delta cannot be trusted.`);
      // Every file any row now names, so media written after J (or regenerated in place) is verified first.
      const users = [SHARED, ...listOwners(prepared.snap)];
      const plans = users.map((user) => this.planUser(prepared, user));
      const copy = await this.copyPlans(prepared, plans);
      const report: DeltaReport = { from, through: from, applied: 0, byOp: {}, copied: copy.copied, failures: 0 };
      const context = { database: this.dest, destRoot: this.destRoot, index: prepared.index };
      for (const plan of plans) {
        for (const file of await unverifiedFiles(context, [...plan.files.files, ...plan.depFiles.files])) {
          recordFailure(this.dest, { userId: plan.user, assetId: file.owner.id, path: file.path, reason: `${DELTA_FAILURE}${copy.failed.get(file.path) ?? 'not verified on the 1.1 volume'}` });
          report.failures += 1;
        }
      }
      if (report.failures) {
        this.log(`delta: NOT applied, ${report.failures} file(s) unverified (see failures); re-run \`delta\` to retry them`);
        return report;
      }
      const deletedMedia = { assets: [] as string[], renders: [] as string[] };
      this.dest.transaction(() => {
        for (const mutation of iterateMutationsAfter(prepared.snap, from)) {
          try {
            this.replay(mutation, deletedMedia);
          } catch (error) {
            throw new Error(`Journal entry ${mutation.id} (${mutation.table} ${mutation.op} ${JSON.stringify(mutation.pk)}) did not replay, so nothing was: ${error instanceof Error ? error.message : String(error)}`);
          }
          report.applied += 1;
          report.byOp[`${mutation.table}.${mutation.op}`] = (report.byOp[`${mutation.table}.${mutation.op}`] ?? 0) + 1;
          report.through = mutation.id;
        }
        setState(this.dest, STATE_DELTA_THROUGH, String(Math.max(report.through, prepared.watermark)));
      }).immediate();
      await this.removeStaleMedia(deletedMedia);
      if (this.pg) {
        const pgUsers = new Set([...(await this.pg.owners()), ...(this.dest.prepare("SELECT DISTINCT user_id FROM import_ledger WHERE table_name = 'pg.sync_projects'").all() as Array<{ user_id: string }>).map((row) => row.user_id)]);
        for (const user of pgUsers) {
          const previous = [...(ledgerFor(this.dest, user).get('pg.sync_projects') ?? [])].map((pk) => (JSON.parse(pk) as string[])[0] as string);
          this.ledgerPg(user, 'cutover', await this.pg.copyUser(user, previous));
        }
      }
      this.log(`delta: replayed ${report.applied} mutation(s), journal ${from} ─▶ ${report.through}`);
      return report;
    } finally {
      prepared.snap.close();
    }
  }

  /** One journal entry: insert/update upsert the row (moving a changed key first), delete deletes it. */
  private replay(mutation: Mutation, deleted: { assets: string[]; renders: string[] }): void {
    const rule = TABLE_RULES[mutation.table];
    if (!rule) throw new Error(`Journal entry ${mutation.id} is for ${mutation.table}, which the cutover does not handle`);
    const { pk } = this.info(mutation.table);
    const oldKey = pk.map((column) => mutation.pk[column] ?? null);
    if (pk.some((column) => !(column in mutation.pk))) throw new Error(`Journal entry ${mutation.id} has no primary key for ${mutation.table}`);
    if (mutation.op === 'delete') {
      this.deleteByPk(mutation.table, oldKey);
      if (mutation.table === 'assets') deleted.assets.push(String(oldKey[0]));
      if (mutation.table === 'renders') deleted.renders.push(String(oldKey[0]));
      if (LEDGERED_TABLES.has(mutation.table)) {
        this.dest.prepare('DELETE FROM import_ledger WHERE table_name = ? AND pk_json = ?').run(mutation.table, JSON.stringify(oldKey));
      }
      return;
    }
    const row = rewriteRow(mutation.table, mutation.row, this.paths);
    const newKey = pk.map((column) => row[column] ?? null);
    if (mutation.op === 'update' && JSON.stringify(newKey) !== JSON.stringify(oldKey)) {
      this.statement(`UPDATE ${quote(mutation.table)} SET ${pk.map((column) => `${quote(column)} = ?`).join(', ')} WHERE ${pk.map((column) => `${quote(column)} IS ?`).join(' AND ')}`)
        .run(...newKey, ...oldKey);
      this.dest.prepare('DELETE FROM import_ledger WHERE table_name = ? AND pk_json = ?').run(mutation.table, JSON.stringify(oldKey));
    }
    this.write(mutation.table, row, 'upsert');
    if (rule.kind === 'root') {
      const owner = rule.owner === 'user_id' ? (row.user_id === null || row.user_id === undefined ? SHARED : String(row.user_id))
        : rule.owner === 'settings_key' ? settingsOwner(String(row.key)) : SHARED;
      this.dest.prepare('INSERT OR REPLACE INTO import_ledger (table_name, pk_json, user_id, tag, imported_at) VALUES (?, ?, ?, ?, ?)')
        .run(mutation.table, JSON.stringify(newKey), owner, 'cutover', new Date().toISOString());
    }
  }

  // ── dry run ───────────────────────────────────────────────────────────────

  /**
   * Per user, every table's rows (1.0 columns, paths rewritten) and every media
   * file's sha256, 1.0 against 1.1. Writes nothing. `rehash: false` trusts the
   * copy's recorded hash while size and mtime are unchanged.
   */
  async dryRun(scope: Scope, options: { rehash?: boolean } = {}): Promise<DryRunReport> {
    const prepared = await this.prepare();
    try {
      const users = this.scopeUsers(prepared, scope);
      const report: DryRunReport = { snapshot: prepared.snapshotName, watermark: prepared.watermark, users: [], diffs: 0 };
      for (const user of users) {
        const result = await this.compareUser(prepared, user, options.rehash ?? true);
        report.diffs += result.tables.length + result.fileDiffs.length + (result.pg && result.pg.source !== result.pg.dest ? 1 : 0);
        report.users.push(result);
      }
      return report;
    } finally {
      prepared.snap.close();
    }
  }

  private async compareUser(prepared: Prepared, user: string, rehash: boolean): Promise<DryRunUser> {
    const ledger = ledgerFor(this.dest, user);
    const srcRoots = scopeRoots(prepared.snap, user);
    const destRoots = scopeRoots(this.dest, user, (table, pk) => Boolean(ledger.get(table)?.has(pk)));
    const tables: TableDiff[] = [];
    const sourceDigests: string[] = [];
    const destDigests: string[] = [];
    let rows = 0;
    for (const table of TABLE_ORDER) {
      if (!appTables(prepared.snap).includes(table)) continue;
      const { columns, pk } = tableInfo(prepared.snap, table);
      const hashRows = (database: EditifyDatabase, roots: Map<string, Row[]>, rewrite: boolean): Map<string, string> => {
        const map = new Map<string, string>();
        for (const raw of scopeRows(database, table, roots)) {
          const row = rewrite ? rewriteRow(table, raw, this.paths) : raw;
          map.set(pkOf(row, pk), sha256(JSON.stringify(columns.map((column) => {
            const value = row[column];
            return Buffer.isBuffer(value) ? { blob: value.toString('base64') } : value ?? null;
          }))));
        }
        return map;
      };
      const src = hashRows(prepared.snap, srcRoots, true);
      const dst = hashRows(this.dest, destRoots, false);
      rows += src.size;
      const digest = (map: Map<string, string>): string => sha256([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, hash]) => `${key}=${hash}`).join('\n'));
      sourceDigests.push(`${table}:${digest(src)}`);
      destDigests.push(`${table}:${digest(dst)}`);
      const missing = [...src.keys()].filter((key) => !dst.has(key));
      const extra = [...dst.keys()].filter((key) => !src.has(key));
      const changed = [...src.keys()].filter((key) => dst.has(key) && dst.get(key) !== src.get(key));
      if (missing.length || extra.length || changed.length) tables.push({ table, sourceRows: src.size, destRows: dst.size, missing, extra, changed });
    }

    const renders = [...scopeRows(prepared.snap, 'renders', srcRoots)];
    const plan = planFiles(new Map([['assets', srcRoots.get('assets') ?? []], ['renders', renders]]), user, prepared.index, prepared.groups, this.paths.sourceRoot);
    const fileDiffs: FileDiff[] = [];
    const sourceFiles: string[] = [];
    const destFiles: string[] = [];
    let bytes = 0;
    for (const file of plan.files) {
      const entry = prepared.index.get(file.path);
      if (!entry) continue;
      bytes += entry.size;
      sourceFiles.push(`${file.path}:${entry.size}:${entry.sha256}`);
      const destPath = join(this.destRoot, file.path);
      const info = await stat(destPath).catch(() => undefined);
      if (!info?.isFile()) { fileDiffs.push({ path: file.path, problem: 'missing' }); destFiles.push(`${file.path}:missing`); continue; }
      if (info.size !== entry.size) { fileDiffs.push({ path: file.path, problem: 'size' }); destFiles.push(`${file.path}:${info.size}`); continue; }
      let digest: string | undefined;
      if (!rehash) {
        const recorded = this.dest.prepare('SELECT sha256, dest_mtime_ms FROM import_files WHERE path = ?').get(file.path) as { sha256: string; dest_mtime_ms: number } | undefined;
        if (recorded && recorded.dest_mtime_ms === Math.trunc(info.mtimeMs)) digest = recorded.sha256;
      }
      digest ??= await sha256File(destPath);
      if (digest !== entry.sha256) fileDiffs.push({ path: file.path, problem: 'sha256' });
      destFiles.push(`${file.path}:${info.size}:${digest}`);
    }
    // Files 1.1 holds in this user's asset and render directories that 1.0 does not.
    const expected = new Set(plan.files.map((file) => file.path));
    for (const [dir, list] of [['assets', srcRoots.get('assets') ?? []], ['renders', renders]] as const) {
      for (const row of list) {
        const folder = join(this.destRoot, dir, String(row.id));
        const names = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
        for (const entry of names) {
          if (!entry.isFile() || entry.name.endsWith('.cutover-tmp')) continue;
          const rel = `${dir}/${String(row.id)}/${join(entry.parentPath.slice(folder.length), entry.name).replace(/^\/+/, '')}`;
          if (!expected.has(rel)) { fileDiffs.push({ path: rel, problem: 'extra' }); destFiles.push(`${rel}:extra`); }
        }
      }
    }
    sourceDigests.push(`files:${sha256(sourceFiles.join('\n'))}`);
    destDigests.push(`files:${sha256(destFiles.join('\n'))}`);

    let pg: DryRunUser['pg'];
    if (this.pg && user !== SHARED) {
      const only = new Set([...(ledger.get('pg.sync_projects') ?? [])].map((pk) => (JSON.parse(pk) as string[])[0] as string));
      const [source, dest] = await Promise.all([this.pg.digest(this.pg.sourceSchema, user), this.pg.digest(this.pg.destSchema, user, only)]);
      pg = { source: source.digest, dest: dest.digest, counts: source.counts };
      sourceDigests.push(`pg:${source.digest}`);
      destDigests.push(`pg:${dest.digest}`);
    }
    return {
      user,
      rows,
      files: plan.files.length,
      bytes,
      sourceHash: sha256(sourceDigests.join('\n')),
      destHash: sha256(destDigests.join('\n')),
      tables,
      fileDiffs,
      ...(pg ? { pg } : {}),
    };
  }

  /**
   * C22: a backup API copy of the 1.1 database into <workDir>/v11-backups, taken
   * right before the volume snapshot so the snapshot holds a clean copy too.
   */
  async backupDest(): Promise<{ path: string; size: number; sha256: string }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.workDir, 'v11-backups', `editify-1.1-${stamp}.db`);
    await mkdir(join(this.workDir, 'v11-backups'), { recursive: true });
    await this.dest.backup(path);
    return { path, size: (await stat(path)).size, sha256: await sha256File(path) };
  }

  failures(): ReturnType<typeof listFailures> {
    return listFailures(this.dest);
  }

  state(): Record<string, string | undefined> {
    return {
      snapshot: getState(this.dest, STATE_SNAPSHOT),
      bulkWatermark: getState(this.dest, STATE_BULK_WATERMARK),
      deltaThrough: getState(this.dest, STATE_DELTA_THROUGH),
      bulkJournal: getState(this.dest, STATE_BULK_JOURNAL),
      deltaStarted: getState(this.dest, STATE_DELTA_STARTED),
    };
  }
}

