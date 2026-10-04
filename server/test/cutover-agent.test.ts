import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import {
  backupDatabase,
  insideRoot,
  journalStatus,
  manifest,
  measure,
  serve,
} from '../scripts/cutover/source-agent.mjs';

/*
 * The 1.0 half of the cutover (plan T16, C6): the read-only agent that runs on
 * editify-dm. A miniature 1.0 volume: the database in WAL mode with the
 * mutations journal on (autocheckpoint off, so new commits stay in the WAL),
 * plus media in the directories the server writes.
 */

const AGENT = new URL('../scripts/cutover/source-agent.mjs', import.meta.url).pathname;
const TOKEN = 't'.repeat(48);

let base: string | undefined;
let database: EditifyDatabase | undefined;
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  database?.close();
  database = undefined;
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

function volume(): { root: string; dbPath: string; db: EditifyDatabase } {
  base = mkdtempSync(join(tmpdir(), 'editify-agent-'));
  const root = join(base, 'data');
  const put = (rel: string, content: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  put('assets/a1/original.mov', 'o'.repeat(3000));
  put('assets/a1/proxy.mp4', 'p'.repeat(1000));
  put('renders/r1/output.mp4', 'r'.repeat(2000));
  put('sounds/whoosh.m4a', 'w'.repeat(10));
  put('cutover/source-agent.mjs', 'not media');
  put('assets/a1/proxy.mp4.cutover-tmp', 'half written');
  const dbPath = join(root, 'editify.db');
  database = createDatabase(dbPath, { readonly: false, journal: true });
  database.pragma('wal_autocheckpoint = 0');
  database.prepare("INSERT INTO projects (id, title, doc_json, created_at, updated_at) VALUES ('p1', 'first', '{}', 'x', 'x')").run();
  return { root, dbPath, db: database };
}

describe('cutover source agent', () => {
  it('measures and lists only media: never the database, its sidecars, cutover/ or half-written copies', async () => {
    const { root } = volume();
    const du = await measure(root);
    expect(du.entries).toEqual([
      { name: 'assets', bytes: 4000, files: 2 },
      { name: 'renders', bytes: 2000, files: 1 },
      { name: 'sounds', bytes: 10, files: 1 },
    ]);
    expect(du.total).toEqual({ bytes: 6010, files: 4 });

    const cachePath = join(base!, 'work', 'hash-cache.json');
    const entries = await manifest(root, { cachePath });
    expect(entries.map((entry) => entry.path)).toEqual(['assets/a1/original.mov', 'assets/a1/proxy.mp4', 'renders/r1/output.mp4', 'sounds/whoosh.m4a']);
    expect(entries[0]?.sha256).toBe(sha('o'.repeat(3000)));

    // The cache is reused while size and mtime hold, and a changed file is hashed again.
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, { sha256: string }>;
    cached['sounds/whoosh.m4a']!.sha256 = 'stale-but-trusted';
    writeFileSync(cachePath, JSON.stringify(cached));
    expect((await manifest(root, { cachePath })).find((entry) => entry.path === 'sounds/whoosh.m4a')?.sha256).toBe('stale-but-trusted');
    writeFileSync(join(root, 'sounds/whoosh.m4a'), 'W'.repeat(10));
    utimesSync(join(root, 'sounds/whoosh.m4a'), new Date(), new Date(Date.now() + 5000));
    expect((await manifest(root, { cachePath })).find((entry) => entry.path === 'sounds/whoosh.m4a')?.sha256).toBe(sha('W'.repeat(10)));
  });

  it('confines file paths to the volume and away from the database', () => {
    const root = '/data';
    expect(insideRoot(root, 'assets/a1/original.mov')).toBe('/data/assets/a1/original.mov');
    for (const bad of ['../etc/passwd', 'assets/../../etc/passwd', '/etc/passwd', '', '..', 'editify.db', 'editify.db-wal', 'cutover/x', 'a\0b']) {
      expect(insideRoot(root, bad), bad).toBeUndefined();
    }
    expect(insideRoot(root, null)).toBeUndefined();
  });

  it('snapshots with the backup API, so commits still in the WAL are in the copy, and reports J from the copy', async () => {
    const { dbPath, db } = volume();
    db.prepare("INSERT INTO projects (id, title, doc_json, created_at, updated_at) VALUES ('p2', 'wal only', '{}', 'x', 'x')").run();
    const status = await journalStatus(dbPath);
    expect(status).toMatchObject({ journal: true });
    expect(status.walBytes).toBeGreaterThan(0);

    const out = join(base!, 'snap', 'copy.db');
    const result = await backupDatabase(dbPath, out);
    expect(result.journalId).toBe(status.journalId);
    expect(result.sha256).toBe(sha(readFileSync(out)));
    const copy = new Database(out, { readonly: true });
    expect((copy.prepare('SELECT id FROM projects ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id)).toEqual(['p1', 'p2']);
    copy.close();

    // The plain file alone would have missed it: that is why copies must not be cp of editify.db.
    const naive = join(base!, 'snap', 'naive.db');
    writeFileSync(naive, readFileSync(dbPath));
    const plain = new Database(naive, { readonly: true });
    const plainHasP2 = (() => {
      try { return Boolean(plain.prepare("SELECT 1 FROM projects WHERE id = 'p2'").get()); } catch { return false; }
    })();
    expect(plainHasP2).toBe(false);
    plain.close();
  });

  it('serves du, the manifest, files and snapshots to token holders only', async () => {
    const { root, dbPath } = volume();
    const agent = await serve({ root, dbPath, host: '127.0.0.1', port: 0, token: TOKEN, workDir: join(base!, 'work') });
    closers.push(agent.close);
    const url = (path: string): string => `http://127.0.0.1:${agent.port}${path}`;
    const auth = { authorization: `Bearer ${TOKEN}` };

    expect((await fetch(url('/du'))).status).toBe(401);
    expect((await fetch(url('/du'), { headers: { authorization: `Bearer ${'u'.repeat(48)}` } })).status).toBe(401);
    expect(((await (await fetch(url('/du'), { headers: auth })).json()) as { total: { files: number } }).total.files).toBe(4);

    const lines = (await (await fetch(url('/manifest'), { headers: auth })).text()).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { path: string; sha256: string });
    expect(lines.map((line) => line.path)).toContain('renders/r1/output.mp4');

    const file = await fetch(url(`/file?path=${encodeURIComponent('renders/r1/output.mp4')}`), { headers: auth });
    expect(file.headers.get('content-length')).toBe('2000');
    expect(sha(Buffer.from(await file.arrayBuffer()))).toBe(lines.find((line) => line.path === 'renders/r1/output.mp4')?.sha256);
    for (const bad of ['../data/editify.db', 'editify.db', 'editify.db-wal']) {
      expect((await fetch(url(`/file?path=${encodeURIComponent(bad)}`), { headers: auth })).status, bad).toBe(400);
    }
    expect((await fetch(url('/file?path=assets/none.mov'), { headers: auth })).status).toBe(404);
    // A symlinked directory inside the volume does not lead out of it.
    writeFileSync(join(base!, 'outside.txt'), 'not media');
    symlinkSync(base!, join(root, 'assets', 'escape'));
    expect((await fetch(url(`/file?path=${encodeURIComponent('assets/escape/outside.txt')}`), { headers: auth })).status).toBe(404);

    const snap = await (await fetch(url('/snapshot'), { method: 'POST', headers: auth })).json() as { name: string; size: number; sha256: string; journalId: number };
    expect(snap.journalId).toBeGreaterThan(0);
    const bytes = Buffer.from(await (await fetch(url(`/snapshot/${snap.name}`), { headers: auth })).arrayBuffer());
    expect([bytes.length, sha(bytes)]).toEqual([snap.size, snap.sha256]);
    expect((await fetch(url('/snapshot/..%2Feditify.db'), { headers: auth })).status).toBe(404);
    await expect(serve({ root, dbPath, host: '127.0.0.1', port: 0, token: 'short', workDir: base! })).rejects.toThrow(/32/);
  });

  it('runs standalone as uploaded: measure and status print, serve refuses without a token', () => {
    const { root, dbPath } = volume();
    const run = (...args: string[]) => spawnSync(process.execPath, [AGENT, ...args], { encoding: 'utf8', env: { ...process.env, CUTOVER_TOKEN: '' } });
    const measured = run('measure', '--root', root);
    expect(measured.status).toBe(0);
    expect(measured.stdout).toMatch(/2 files {2}assets\n/);
    expect(measured.stdout).toMatch(/total \(6010 bytes\)/);
    expect(JSON.parse(run('status', '--db', dbPath).stdout)).toMatchObject({ journal: true, triggers: expect.any(Number) });
    const refused = run('serve', '--root', root, '--host', '127.0.0.1', '--port', '0');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/CUTOVER_TOKEN/);
  });
});
