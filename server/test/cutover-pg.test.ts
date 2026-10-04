import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { Importer } from '../scripts/cutover/importer.js';
import { PgSyncCopy } from '../scripts/cutover/pg-copy.js';
import { LocalSource } from '../scripts/cutover/source.js';
import { resolveUser } from '../scripts/cutover/users.js';
import { ALICE, BOB, createFixture, type Fixture } from './helpers/cutover-fixture.js';

/*
 * The Postgres half of the cutover: public.sync_* (1.0) mirrored into
 * v11.sync_* (1.1) per user. Its own database, `editify_cutover_test`, next to
 * the one SYNC_TEST_DATABASE_URL names (pg-sync.test.ts drops and recreates
 * schemas in that one, and test files run in parallel).
 */
const BASE_URL = process.env.SYNC_TEST_DATABASE_URL ?? 'postgresql://localhost/editify_t9_test';
const TEST_URL = (() => {
  const url = new URL(BASE_URL);
  url.pathname = '/editify_cutover_test';
  return url.toString();
})();
const MIGRATIONS = ['20261002120000_project_sync.sql', '20261004000000_v11_project_sync.sql']
  .map((name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));

const STANDIN = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULL::uuid $f$;
`;

async function prepare(): Promise<string | undefined> {
  try {
    const admin = new pg.Client(BASE_URL);
    await admin.connect();
    try {
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'editify_cutover_test'");
      if (!exists.rowCount) await admin.query('CREATE DATABASE editify_cutover_test');
    } finally {
      await admin.end();
    }
    const client = new pg.Client(TEST_URL);
    await client.connect();
    try {
      await client.query(STANDIN);
      await client.query('DROP SCHEMA IF EXISTS v11 CASCADE');
      await client.query('DROP TABLE IF EXISTS public.sync_receipts, public.sync_op_log, public.sync_projects CASCADE');
      for (const migration of MIGRATIONS) await client.query(migration);
      await client.query("INSERT INTO auth.users (id, email) VALUES ($1, 'alice@example.com'), ($2, 'bob@example.com') ON CONFLICT DO NOTHING", [ALICE, BOB]);
    } finally {
      await client.end();
    }
    return undefined;
  } catch (error) {
    const { message, code } = error as { message?: string; code?: string };
    return `Postgres unreachable at ${BASE_URL}: ${message || code || String(error)}`;
  }
}

const skipReason = await prepare();
const inCi = Boolean(process.env.CI) && process.env.CI !== 'false';
if (skipReason && inCi) throw new Error(`[cutover-pg.test] CI must run these tests: ${skipReason}`);
if (skipReason) console.warn(`[cutover-pg.test] skipped: ${skipReason}`);

const pool = skipReason ? undefined : new pg.Pool({ connectionString: TEST_URL, max: 4 });
afterAll(async () => { await pool?.end(); });

let fixture: Fixture | undefined;
let dest: EditifyDatabase | undefined;
afterEach(async () => {
  dest?.close();
  dest = undefined;
  fixture?.source.close();
  if (fixture) rmSync(fixture.base, { recursive: true, force: true });
  fixture = undefined;
  await pool?.query('TRUNCATE public.sync_projects, v11.sync_projects CASCADE');
});

async function syncProject(id: string, user: string, title: string): Promise<void> {
  const doc = JSON.stringify({ id, title, version: 1 });
  await pool!.query("INSERT INTO public.sync_projects (id, user_id, title, doc, revision, last_seq) VALUES ($1, $2, $3, $4::jsonb, 1, 2)", [id, user, title, doc]);
  await pool!.query("INSERT INTO public.sync_op_log (project_id, seq, user_id, kind, ops, revision, after_doc) VALUES ($1, 1, $2, 'create', '[]', 0, $3::jsonb)", [id, user, doc]);
  await pool!.query("INSERT INTO public.sync_op_log (project_id, seq, user_id, kind, ops, revision, after_doc, change_id) VALUES ($1, 2, $2, 'edit', '[{\"type\":\"trim\"}]', 1, $3::jsonb, 'c1')", [id, user, doc]);
  await pool!.query("INSERT INTO public.sync_receipts (project_id, change_id, user_id, base_revision, revision, seq, hash, request_digest) VALUES ($1, 'c1', $2, 0, 1, 2, 'h', 'd')", [id, user]);
}

const v11Count = async (table: string, user: string): Promise<number> =>
  Number((await pool!.query(`SELECT COUNT(*) AS n FROM v11.${table} WHERE user_id = $1`, [user])).rows[0].n);

describe.skipIf(Boolean(skipReason))('cutover: Postgres project sync, public ─▶ v11', () => {
  function setup(): Importer {
    fixture = createFixture();
    dest = createDatabase(fixture.destDb, { readonly: false, journal: false });
    return new Importer({
      source: new LocalSource(fixture.sourceRoot, fixture.sourceDb, join(fixture.destRoot, 'cutover')),
      dest,
      destRoot: fixture.destRoot,
      sourceRoot: fixture.sourceRoot,
      pg: new PgSyncCopy(pool!, 'public', 'v11'),
      freeBytes: async () => 1e12,
    });
  }

  it('mirrors each user with their SQLite rows, replaces beta copies at cutover, and the dry run hashes the rows', async () => {
    const importer = setup();
    await syncProject('sync-a1', ALICE, 'Alice synced');
    await syncProject('sync-b1', BOB, 'Bob synced');
    await importer.snapshot();

    await importer.import({ kind: 'users', users: [ALICE] });
    expect([await v11Count('sync_projects', ALICE), await v11Count('sync_op_log', ALICE), await v11Count('sync_receipts', ALICE)]).toEqual([1, 2, 1]);
    expect(await v11Count('sync_projects', BOB)).toBe(0);

    // 1.0 moves on: Alice's project goes, a new one arrives.
    await pool!.query("DELETE FROM public.sync_projects WHERE id = 'sync-a1'");
    await syncProject('sync-a2', ALICE, 'Alice second');
    const cutover = await importer.import({ kind: 'all' });
    expect(cutover.users.every((user) => user.status === 'imported')).toBe(true);
    const ids = (await pool!.query('SELECT id FROM v11.sync_projects ORDER BY id')).rows.map((row: { id: string }) => row.id);
    expect(ids).toEqual(['sync-a2', 'sync-b1']);
    const dry = await importer.dryRun({ kind: 'all' });
    expect(dry.diffs).toBe(0);
    expect(dry.users.find((user) => user.user === ALICE)?.pg?.counts).toEqual({ sync_projects: 1, sync_op_log: 2, sync_receipts: 1 });

    // The read-only window: 1.0 refuses /sync writes too, so the delta's copy is final.
    await syncProject('sync-b2', BOB, 'Bob late');
    await importer.delta();
    expect(await v11Count('sync_projects', BOB)).toBe(2);
    expect((await importer.dryRun({ kind: 'all' })).diffs).toBe(0);

    await pool!.query(`UPDATE v11.sync_projects SET title = 'Bob synceD' WHERE id = 'sync-b1'`);
    expect((await importer.dryRun({ kind: 'users', users: [BOB] })).diffs).toBe(1);
  });

  it('resolves --user by email through auth.users', async () => {
    expect(await resolveUser('Alice@Example.com', pool, {})).toBe(ALICE);
    expect(await resolveUser(BOB.toUpperCase(), pool, {})).toBe(BOB);
    await expect(resolveUser('nobody@example.com', pool, {})).rejects.toThrow(/nobody@example.com/);
  });
});
