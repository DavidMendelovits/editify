import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { configureMutationJournal } from '../src/db/mutation-journal.js';
import { Importer, type ImporterOptions } from '../scripts/cutover/importer.js';
import { SpaceError } from '../scripts/cutover/media.js';
import { journalStatus, serve } from '../scripts/cutover/source-agent.mjs';
import { HttpSource, LocalSource, type CutoverSource } from '../scripts/cutover/source.js';
import { SHARED } from '../scripts/cutover/tables.js';
import { ALICE, BOB, createFixture, insertAsset, insertChat, insertProject, writeMedia, type Fixture } from './helpers/cutover-fixture.js';


let fixture: Fixture | undefined;
let dest: EditifyDatabase | undefined;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  dest?.close();
  dest = undefined;
  fixture?.source.close();
  if (fixture) rmSync(fixture.base, { recursive: true, force: true });
  fixture = undefined;
});

function setup(overrides: Partial<ImporterOptions> & { source?: CutoverSource } = {}): { fx: Fixture; importer: Importer; local: LocalSource } {
  fixture = createFixture();
  dest = createDatabase(fixture.destDb, { readonly: false, journal: false });
  const local = new LocalSource(fixture.sourceRoot, fixture.sourceDb, join(fixture.destRoot, 'cutover'));
  const importer = make(local, overrides);
  return { fx: fixture, importer, local };
}

function make(source: CutoverSource, overrides: Partial<ImporterOptions> = {}): Importer {
  if (!fixture || !dest) throw new Error('setup first');
  return new Importer({ source, dest, destRoot: fixture.destRoot, sourceRoot: fixture.sourceRoot, freeBytes: async () => 1e12, ...overrides });
}

const count = (table: string, where = '1 = 1', ...values: unknown[]): number =>
  (dest!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...values) as { n: number }).n;
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Flips one byte of one file as it crosses the wire: the copy must catch it against 1.0's hash. */
class CorruptingSource implements CutoverSource {
  readonly label = 'corrupting';
  constructor(private readonly inner: CutoverSource, private readonly victim: string) {}
  du = () => this.inner.du();
  manifest = () => this.inner.manifest();
  snapshot = (path: string) => this.inner.snapshot(path);
  async download(rel: string, destPath: string): Promise<void> {
    await this.inner.download(rel, destPath);
    if (rel === this.victim) {
      const bytes = readFileSync(destPath);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      writeFileSync(destPath, bytes);
    }
  }
}

describe('cutover importer', () => {
  it('imports every 1.0 store with its media, rewrites paths, and the dry run finds no diff', async () => {
    const { fx, importer } = setup();
    await importer.snapshot();
    const report = await importer.import({ kind: 'all' });

    expect(report.users.map((user) => [user.user, user.status])).toEqual([[SHARED, 'imported'], [BOB, 'imported'], [ALICE, 'imported']]);
    for (const table of ['projects', 'operation_log', 'project_assets', 'renders', 'chat_messages', 'assets', 'transcripts', 'insights',
      'dissections', 'waveforms', 'face_tracks', 'video_observations', 'style_profiles', 'reports', 'settings', 'webhook_events']) {
      expect(count(table), table).toBe((fx.source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    }
    // Paths point into 1.1's volume, in the path columns and inside JSON.
    const asset = dest!.prepare("SELECT original_path, proxy_path FROM assets WHERE id = 'asset-a1'").get() as { original_path: string; proxy_path: string };
    expect(asset.original_path).toBe(join(fx.destRoot, 'assets/asset-a1/original.mov'));
    expect(sha(asset.original_path)).toBe(sha(join(fx.sourceRoot, 'assets/asset-a1/original.mov')));
    expect((dest!.prepare("SELECT output_path FROM renders WHERE id = 'render-a1'").get() as { output_path: string }).output_path)
      .toBe(join(fx.destRoot, 'renders/render-a1/output.mp4'));
    expect((dest!.prepare("SELECT payload_json FROM reports WHERE id = 'report-a1'").get() as { payload_json: string }).payload_json).toContain(fx.destRoot);
    // Originals, proxies, renders and the shared trees all arrived; the file no row names did not.
    for (const rel of ['assets/asset-a1/proxy.mp4', 'assets/asset-a1/filmstrip.jpg', 'renders/render-a1/captions.ass', 'sounds/whoosh-soft.m4a', 'emoji/1f600.png']) {
      expect(existsSync(join(fx.destRoot, rel)), rel).toBe(true);
    }
    expect(existsSync(join(fx.destRoot, 'assets/asset-nobody'))).toBe(false);
    expect(report.orphans).toEqual(['assets/asset-nobody/original.mov']);
    // 1.1-only columns stay at their defaults.
    expect(dest!.prepare("SELECT snapshot_json FROM renders WHERE id = 'render-a1'").get()).toEqual({ snapshot_json: null });
    expect(count('import_ledger', "tag = 'cutover'")).toBeGreaterThan(0);
    expect(importer.state().bulkWatermark).toBe(String(report.watermark));

    const dry = await importer.dryRun({ kind: 'all' });
    expect(dry.diffs).toBe(0);
    expect(dry.users.find((user) => user.user === ALICE)).toMatchObject({ files: 6 });
    for (const user of dry.users) expect(user.destHash).toBe(user.sourceHash);
  });

  it('is idempotent: a re-run skips what is done, and a forced one writes the same state', async () => {
    const { importer } = setup();
    await importer.snapshot();
    await importer.import({ kind: 'all' });
    const counts = () => ['projects', 'chat_messages', 'operation_log', 'assets', 'import_ledger', 'import_files'].map((table) => count(table));
    const before = counts();

    const again = await importer.import({ kind: 'all' });
    expect(again.users.every((user) => user.status === 'skipped')).toBe(true);
    expect(again.copied).toBe(0);
    expect(counts()).toEqual(before);

    await expect(importer.import({ kind: 'users', users: [ALICE] })).rejects.toThrow(/beta_copy/);

    const forced = await importer.import({ kind: 'all' }, { force: true });
    expect(forced.users.every((user) => user.status === 'imported')).toBe(true);
    expect(forced.copied).toBe(0);
    expect(counts()).toEqual(before);
    expect((await importer.dryRun({ kind: 'all' })).diffs).toBe(0);
  });

  it('holds back a user whose file fails verification, records it, and a re-run after the fix imports only them', async () => {
    const { local } = setup();
    const broken = make(new CorruptingSource(local, 'assets/asset-a1/proxy.mp4'));
    await broken.snapshot();
    const report = await broken.import({ kind: 'all' });

    expect(report.users.find((user) => user.user === ALICE)?.status).toBe('failed');
    expect(report.users.find((user) => user.user === BOB)?.status).toBe('imported');
    expect(count('projects', 'user_id = ?', ALICE)).toBe(0);
    expect(count('chat_messages', "project_id = 'project-a1'")).toBe(0);
    expect(count('projects', 'user_id = ?', BOB)).toBe(1);
    expect(existsSync(join(fixture!.destRoot, 'assets/asset-a1/proxy.mp4'))).toBe(false);
    const failures = broken.failures();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ userId: ALICE, assetId: 'asset-a1', path: 'assets/asset-a1/proxy.mp4' });
    expect(failures[0]?.reason).toMatch(/sha256/);
    expect(broken.state().bulkWatermark).toBeUndefined();

    const fixed = make(local);
    const retry = await fixed.import({ kind: 'all' });
    expect(retry.users.filter((user) => user.status === 'imported').map((user) => user.user)).toEqual([ALICE]);
    expect(retry.copied).toBe(1);
    expect(fixed.failures()).toEqual([]);
    expect(count('projects', 'user_id = ?', ALICE)).toBe(1);
    expect((await fixed.dryRun({ kind: 'all' })).diffs).toBe(0);
  });

  it('replays the journal after J: inserts, updates, deletes and their cascades, media included', async () => {
    const { fx, importer } = setup();
    // An observation with no foreign key: deleting its asset after J leaves it orphaned on both sides.
    fx.source.prepare("INSERT INTO video_observations (asset_id, analyzer, analyzer_version, observation_json, created_at) VALUES ('asset-b1', 'ffmpeg', '1', '{}', 'x')").run();
    const bulk = await importer.snapshot();
    await importer.import({ kind: 'all' });

    // Writes that land on 1.0 after the bulk snapshot. Autocheckpoint is off, so they sit in the WAL.
    const src = fx.source;
    insertProject(src, 'project-b2', BOB, 'Bob second', []);
    insertChat(src, 'chat-b2', 'project-b2', 'new after J');
    src.prepare("UPDATE projects SET title = 'Alice set (final)' WHERE id = 'project-a1'").run();
    src.prepare("DELETE FROM chat_messages WHERE id = 'chat-a2'").run();
    src.prepare("DELETE FROM projects WHERE id = 'project-b1'").run(); // cascades chat-b1 and its asset link
    src.prepare("DELETE FROM assets WHERE id = 'asset-b1'").run();
    insertAsset(src, fx.sourceRoot, 'asset-a2', ALICE);
    src.prepare("UPDATE settings SET value = 'calm' WHERE key = 'style.default'").run();
    src.prepare('DELETE FROM settings WHERE key = ?').run(`captionStyle:${ALICE}`);
    expect(existsSync(`${fx.sourceDb}-wal`)).toBe(true);

    const delta = await importer.delta();
    expect(delta.from).toBe(bulk.journalId);
    expect(delta.through).toBeGreaterThan(bulk.journalId);
    expect(delta.byOp['projects.insert']).toBe(1);
    expect(delta.byOp['projects.update']).toBe(1);
    expect(delta.byOp['projects.delete']).toBe(1);
    expect(delta.byOp['chat_messages.delete']).toBe(2); // chat-a2, and chat-b1 by cascade
    expect(delta.byOp['project_assets.delete']).toBe(1);

    expect(count('projects', "id = 'project-b1'")).toBe(0);
    expect(count('chat_messages', "id IN ('chat-a2', 'chat-b1')")).toBe(0);
    expect(count('chat_messages', "id = 'chat-b2'")).toBe(1);
    expect((dest!.prepare("SELECT title FROM projects WHERE id = 'project-a1'").get() as { title: string }).title).toBe('Alice set (final)');
    expect(existsSync(join(fx.destRoot, 'assets/asset-a2/original.mov'))).toBe(true);
    expect(existsSync(join(fx.destRoot, 'assets/asset-b1'))).toBe(false);
    expect(count('settings', 'key = ?', `captionStyle:${ALICE}`)).toBe(0);
    expect((await importer.dryRun({ kind: 'all' })).diffs).toBe(0);

    // A second delta with nothing new is a no-op.
    expect((await importer.delta()).applied).toBe(0);
  });

  it('replaces a beta_copy import at cutover, dropping what testers did on 1.1', async () => {
    const { fx, importer } = setup();
    await importer.snapshot();
    const beta = await importer.import({ kind: 'users', users: [ALICE] });
    expect(beta.users.map((user) => [user.user, user.status])).toEqual([[ALICE, 'imported']]);
    expect(count('import_ledger', "user_id = ? AND tag = 'beta_copy'", ALICE)).toBeGreaterThan(0);
    expect(count('projects', 'user_id = ?', BOB)).toBe(0);
    // The sound asset Alice's project links came along as a dependency, unowned and unledgered.
    expect(count('assets', "id = 'sound-whoosh-soft'")).toBe(1);
    expect(count('import_ledger', "table_name = 'assets' AND pk_json = '[\"sound-whoosh-soft\"]'")).toBe(0);

    // A tester edits on 1.1: a chat turn and a render on the imported project, and a project of their own.
    dest!.prepare("INSERT INTO chat_messages (id, project_id, role, content, ops_json, created_at) VALUES ('chat-beta', 'project-a1', 'user', 'beta edit', NULL, 'x')").run();
    dest!.prepare("INSERT INTO renders (id, project_id, resolution, status, output_path, error, created_at, updated_at) VALUES ('render-beta', 'project-a1', '720p', 'done', ?, NULL, 'x', 'x')")
      .run(writeMedia(fx.destRoot, 'renders/render-beta/output.mp4', 'beta render'));
    dest!.prepare("INSERT INTO projects (id, title, doc_json, created_at, updated_at, user_id) VALUES ('project-native', 'Made on 1.1', '{}', 'x', 'x', ?)").run(ALICE);

    const cutover = await importer.import({ kind: 'all' });
    expect(cutover.users.find((user) => user.user === ALICE)?.status).toBe('imported');
    expect(count('import_ledger', "tag = 'beta_copy'")).toBe(0);
    expect(count('chat_messages', "id = 'chat-beta'")).toBe(0);
    expect(count('renders', "id = 'render-beta'")).toBe(0);
    expect(existsSync(join(fx.destRoot, 'renders/render-beta'))).toBe(false);
    expect(count('chat_messages', "project_id = 'project-a1'")).toBe(2);
    expect(count('projects', "id = 'project-native'")).toBe(1);
    expect((await importer.dryRun({ kind: 'all' })).diffs).toBe(0);
  });

  it('dry run compares content, not counts: one changed byte in a row or a file is a diff', async () => {
    const { fx, importer } = setup();
    await importer.snapshot();
    await importer.import({ kind: 'all' });
    expect((await importer.dryRun({ kind: 'all' })).diffs).toBe(0);

    dest!.prepare("UPDATE chat_messages SET content = 'tighten the intrO' WHERE id = 'chat-a1'").run();
    const rowDiff = await importer.dryRun({ kind: 'users', users: [ALICE] });
    expect(rowDiff.diffs).toBe(1);
    expect(rowDiff.users[0]?.tables).toEqual([expect.objectContaining({ table: 'chat_messages', changed: ['["chat-a1"]'], missing: [], extra: [] })]);
    expect(rowDiff.users[0]?.destHash).not.toBe(rowDiff.users[0]?.sourceHash);
    dest!.prepare("UPDATE chat_messages SET content = 'tighten the intro' WHERE id = 'chat-a1'").run();

    const file = join(fx.destRoot, 'renders/render-a1/output.mp4');
    const bytes = readFileSync(file);
    bytes[5] = (bytes[5] ?? 0) ^ 0x01;
    writeFileSync(file, bytes);
    const fileDiff = await importer.dryRun({ kind: 'users', users: [ALICE] });
    expect(fileDiff.users[0]?.fileDiffs).toEqual([{ path: 'renders/render-a1/output.mp4', problem: 'sha256' }]);
    expect(fileDiff.diffs).toBe(1);
  });

  it('aborts before copying anything when 1.1 has under 1.2x the bytes left to copy', async () => {
    const { fx } = setup();
    const needed = (await new LocalSource(fx.sourceRoot, fx.sourceDb, join(fx.destRoot, 'cutover')).manifest())
      .filter((entry) => !entry.path.startsWith('assets/asset-nobody')).reduce((sum, entry) => sum + entry.size, 0);
    const tight = make(new LocalSource(fx.sourceRoot, fx.sourceDb, join(fx.destRoot, 'cutover')), { freeBytes: async () => Math.floor(needed * 1.19) });
    await tight.snapshot();
    await expect(tight.import({ kind: 'all' })).rejects.toBeInstanceOf(SpaceError);
    expect(existsSync(join(fx.destRoot, 'assets'))).toBe(false);
    expect(count('projects')).toBe(0);

    const roomy = make(new LocalSource(fx.sourceRoot, fx.sourceDb, join(fx.destRoot, 'cutover')), { freeBytes: async () => Math.ceil(needed * 1.2) });
    await expect(roomy.import({ kind: 'all' })).resolves.toMatchObject({ copied: expect.any(Number) });
  });

  it('warns at import and refuses the delta when 1.0 runs without the journal', async () => {
    const { fx, importer } = setup();
    configureMutationJournal(fx.source, false);
    fx.source.exec('DROP TABLE mutations');
    expect(await journalStatus(fx.sourceDb)).toMatchObject({ journal: false, triggers: 0, journalId: 0 });
    await importer.snapshot();
    expect((await importer.import({ kind: 'all' })).journal).toBe(false);
    await expect(importer.delta()).rejects.toThrow(/MUTATION_JOURNAL=1/);
  });

  it('backs up 1.1 with the backup API before the volume snapshot (C22)', async () => {
    const { importer } = setup();
    await importer.snapshot();
    await importer.import({ kind: 'all' });
    const backup = await importer.backupDest();
    expect(backup.sha256).toBe(sha(backup.path));
    const copy = new Database(backup.path, { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(count('projects'));
    copy.close();
  });

  it('refuses a 1.0 table it does not know how to scope', async () => {
    const { fx, importer } = setup();
    fx.source.exec('CREATE TABLE surprise (id TEXT PRIMARY KEY)');
    await expect(importer.snapshot()).rejects.toThrow(/surprise/);
  });
});

describe('cutover CLI', () => {
  it('runs snapshot, import and dry-run end to end, exiting 1 on a diff', () => {
    const { fx } = setup();
    dest!.close();
    dest = undefined;
    const env = { ...process.env, DATABASE_URL: '', EDITIFY_DATA_DIR: fx.destRoot, DATABASE_PATH: fx.destDb, MUTATION_JOURNAL: '' };
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/cutover/cutover.ts', ...args,
      '--source-dir', fx.sourceRoot, '--source-db', fx.sourceDb, '--source-root', fx.sourceRoot], { encoding: 'utf8', env });
    expect(cli('snapshot').status).toBe(0);
    const imported = cli('import', '--all');
    expect(imported.stdout).toMatch(/imported +00000000-0000-4000-8000-00000000a11c/);
    expect(imported.status).toBe(0);
    const clean = cli('dry-run', '--all');
    expect(clean.stdout).toMatch(/0 diff\(s\)/);
    expect(clean.status).toBe(0);
    const file = join(fx.destRoot, 'assets/asset-b1/proxy.mp4');
    const bytes = readFileSync(file);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    writeFileSync(file, bytes);
    const dirty = cli('dry-run', '--user', BOB);
    expect(dirty.stdout).toMatch(/file sha256: assets\/asset-b1\/proxy.mp4/);
    expect(dirty.status).toBe(1);
    expect(cli('import', '--user', 'not-a-user').status).toBe(2);
  }, 60_000);
});

describe('cutover over HTTP', () => {
  it('imports through the source agent: du, the manifest, files and a backup API snapshot, to token holders only', async () => {
    const { fx } = setup();
    const token = 'x'.repeat(40);
    const agent = await serve({ root: fx.sourceRoot, dbPath: fx.sourceDb, host: '127.0.0.1', port: 0, token, workDir: join(fx.base, 'agent-work') });
    cleanups.push(() => agent.close());
    const base = `http://127.0.0.1:${agent.port}`;

    expect((await fetch(`${base}/du`)).status).toBe(401);
    expect((await fetch(`${base}/du`, { headers: { authorization: `Bearer ${'y'.repeat(40)}` } })).status).toBe(401);
    const auth = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/file?path=${encodeURIComponent('../v11-data/editify.db')}`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/file?path=editify.db`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/file?path=editify.db-wal`, { headers: auth })).status).toBe(400);

    // A commit that only exists in the WAL is in the snapshot.
    insertChat(fx.source, 'chat-wal-only', 'project-a1', 'still in the WAL');
    const importer = make(new HttpSource(base, token));
    expect(await journalStatus(fx.sourceDb)).toMatchObject({ journal: true, triggers: 48 });
    const snap = await importer.snapshot();
    expect(snap.journalId).toBeGreaterThan(0);
    const du = (await importer.measure()).source;
    expect(du.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['assets', 'renders', 'sounds', 'emoji']));
    expect(du.entries.map((entry) => entry.name)).not.toContain('editify.db');

    const report = await importer.import({ kind: 'all' });
    expect(report.users.every((user) => user.status === 'imported')).toBe(true);
    expect(count('chat_messages', "id = 'chat-wal-only'")).toBe(1);
    expect(sha(join(fx.destRoot, 'renders/render-a1/output.mp4'))).toBe(sha(join(fx.sourceRoot, 'renders/render-a1/output.mp4')));
    expect((await importer.dryRun({ kind: 'all' })).diffs).toBe(0);
  });
});
