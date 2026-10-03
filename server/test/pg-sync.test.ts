import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBatch,
  projectHash,
  projectSchema,
  type AgentTurnRequest,
  type Operation,
  type Project,
  type SyncPushRequest,
} from '@editify/shared';
import type { ToolProvider } from '../src/agent/providers.js';
import { AgentService } from '../src/agent/service.js';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/database.js';
import {
  PgSyncStore,
  SyncChangeReusedError,
  SyncConflictError,
  SyncMismatchError,
  SyncNotFoundError,
  SyncProjectTakenError,
} from '../src/db/pg-sync-store.js';
import { PgTurnLock, turnLockKey } from '../src/db/pg-turn-lock.js';
import { createPgPools, pgSettings, type PgPools } from '../src/db/postgres.js';
import { ProjectStore } from '../src/db/project-store.js';
import { registerAgentTurnRoutes } from '../src/routes/agent-turn.js';
import { registerSyncRoutes } from '../src/routes/sync.js';
import { grant } from './fixtures/grant.js';

/*
 * Runs against a real Postgres: SYNC_TEST_DATABASE_URL, else a throwaway
 * `editify_t9_test` database on localhost, created on first run. The
 * migration is applied (twice, to prove it re-runs) on a stand-in for
 * Supabase's `auth` schema and `anon` / `authenticated` roles.
 */
const MIGRATION = new URL('../../supabase/migrations/20261002120000_project_sync.sql', import.meta.url);
const TEST_URL = process.env.SYNC_TEST_DATABASE_URL ?? 'postgresql://localhost/editify_t9_test';
const ADMIN_URL = process.env.SYNC_TEST_ADMIN_URL ?? 'postgresql://localhost/postgres';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-000000000b0b';

const SUPABASE_STANDIN = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
  -- Supabase's definition: the JWT subject PostgREST puts in request.jwt.claims.
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
    SELECT coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $f$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated;
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  -- Supabase's default privileges, which the migration narrows.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
`;

async function prepare(): Promise<string | undefined> {
  const migration = readFileSync(MIGRATION, 'utf8');
  try {
    if (!process.env.SYNC_TEST_DATABASE_URL) {
      const admin = new pg.Client(ADMIN_URL);
      await admin.connect();
      try {
        const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'editify_t9_test'");
        if (!exists.rowCount) await admin.query('CREATE DATABASE editify_t9_test');
      } finally {
        await admin.end();
      }
    }
    const client = new pg.Client(TEST_URL);
    await client.connect();
    try {
      await client.query(SUPABASE_STANDIN);
      await client.query('DROP TABLE IF EXISTS public.sync_receipts, public.sync_op_log, public.sync_projects CASCADE');
      await client.query(migration);
      await client.query(migration);
      await client.query('INSERT INTO auth.users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING', [ALICE, BOB]);
    } finally {
      await client.end();
    }
    return undefined;
  } catch (error) {
    const { message, code } = error as { message?: string; code?: string };
    return `Postgres unreachable at ${TEST_URL}: ${message || code || String(error)}`;
  }
}

const skipReason = await prepare();
// CI provides a Postgres service (.github/workflows/ci.yml), so there a missing database is a failure, not a skip.
const inCi = Boolean(process.env.CI) && process.env.CI !== 'false';
if (skipReason && inCi) throw new Error(`[pg-sync.test] CI must run these tests: ${skipReason}`);
if (skipReason) console.warn(`[pg-sync.test] skipped: ${skipReason}`);

let counter = 0;
function changeId(label = 'change'): string {
  counter += 1;
  return `${label}-${process.pid}-${counter}`.slice(0, 64);
}

function freshProject(overrides: Partial<Project> = {}): Project {
  return projectSchema.parse({
    id: `project-${changeId('p')}`,
    title: 'Stand-up set',
    format: '9:16',
    fps: 30,
    duration: 0,
    version: 0,
    tracks: [
      { id: 'video-main', kind: 'video', clips: [{ id: 'clip-0', assetId: 'asset-a', start: 0, in: 0, out: 4 }] },
      { id: 'audio-main', kind: 'audio', clips: [] },
      { id: 'overlays', kind: 'overlay', clips: [] },
      { id: 'captions', kind: 'caption', clips: [] },
    ],
    ...overrides,
  });
}

function caption(id: string, start: number): Operation {
  return { type: 'add_caption', params: { trackId: 'captions', clip: { id, text: id, start, in: 0, out: 0.5 } } };
}

function volume(clipId: string, value: number): Operation {
  return { type: 'set_volume', params: { clipId, volume: value } };
}

function push(baseRevision: number, ops: Operation[], extra: Partial<SyncPushRequest> = {}): SyncPushRequest {
  return { changeId: changeId(), baseRevision, ops, ...extra };
}

describe('sync routes without DATABASE_URL', () => {
  it('boot and answer 503 while every existing route keeps working', async () => {
    const saved = process.env.EDITIFY_NO_AUTH;
    process.env.EDITIFY_NO_AUTH = '1';
    const app = await buildApp({ database: createDatabase(':memory:'), databaseUrl: null });
    try {
      const sync = await app.inject({ method: 'GET', url: '/sync/projects' });
      expect(sync.statusCode).toBe(503);
      expect(sync.json()).toEqual({ error: 'sync not configured' });
      expect((await app.inject({ method: 'POST', url: '/sync/projects/x/changes', payload: {} })).statusCode).toBe(503);
      expect((await app.inject({ method: 'GET', url: '/projects' })).statusCode).toBe(200);
    } finally {
      await app.close();
      if (saved === undefined) delete process.env.EDITIFY_NO_AUTH;
      else process.env.EDITIFY_NO_AUTH = saved;
    }
  });
});

describe('postgres connection settings', () => {
  const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  const REMOTE = 'postgresql://postgres.ref:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

  it('refuses a remote host with no CA and no explicit sslmode=no-verify', () => {
    expect(() => pgSettings(REMOTE, {})).toThrow(/DATABASE_CA_CERT/);
    expect(() => pgSettings(`${REMOTE}?sslmode=require`, {})).toThrow(/DATABASE_CA_CERT/);
    expect(() => pgSettings(`${REMOTE}?sslmode=disable`, {})).toThrow(/DATABASE_CA_CERT/);
  });

  it('verifies against a given CA, and strips URL ssl parameters so they cannot override it', () => {
    const settings = pgSettings(`${REMOTE}?sslmode=no-verify`, { DATABASE_CA_CERT: CA });
    expect(settings.pool.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
    expect(settings.pool.connectionString).not.toMatch(/sslmode/);
    expect(settings.pool.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(settings.sessionLocks).toBe(true);
    expect(settings.warnings).toEqual([]);
  });

  it('accepts an explicit no-verify with a warning, and plaintext only on localhost', () => {
    const unverified = pgSettings(`${REMOTE}?sslmode=no-verify`, {});
    expect(unverified.pool.ssl).toEqual({ rejectUnauthorized: false });
    expect(unverified.warnings.join(' ')).toMatch(/not checked/);
    expect(pgSettings('postgresql://localhost/editify', {}).pool.ssl).toBeUndefined();
    expect(pgSettings('postgresql:///editify?host=/tmp', {}).pool.ssl).toBeUndefined();
  });

  it('keeps sync but not the session lock on the transaction pooler (6543)', () => {
    const settings = pgSettings(REMOTE.replace(':5432', ':6543'), { DATABASE_CA_CERT: CA });
    expect(settings.sessionLocks).toBe(false);
    expect(settings.warnings.join(' ')).toMatch(/6543/);
    const pools = createPgPools(REMOTE.replace(':5432', ':6543'), { DATABASE_CA_CERT: CA });
    expect(pools.lock).toBeUndefined();
    void pools.end();
  });

  it('fails the boot of an app pointed at a remote database without TLS settled', async () => {
    await expect(buildApp({ database: createDatabase(':memory:'), databaseUrl: REMOTE })).rejects.toThrow(/DATABASE_CA_CERT/);
  });
});

describe.skipIf(Boolean(skipReason))('postgres project sync', () => {
  const pool = new pg.Pool({ connectionString: TEST_URL, max: 12 });
  const store = new PgSyncStore(pool);
  afterAll(async () => { await pool.end(); });

  async function created(owner = ALICE, project = freshProject()): Promise<Project> {
    return (await store.create(owner, project)).project;
  }

  describe('create and pull', () => {
    it('registers a project at its version, idempotently, and keeps it from other accounts', async () => {
      const project = freshProject({ version: 12 });
      const first = await store.create(ALICE, project);
      expect(first).toMatchObject({ created: true, revision: 12, seq: 1 });
      expect(first.project.duration).toBe(4);
      const again = await store.create(ALICE, { ...project, title: 'Changed on the phone' });
      expect(again).toMatchObject({ created: false, revision: 12, seq: 1 });
      expect(again.project.title).toBe('Stand-up set');
      await expect(store.create(BOB, project)).rejects.toBeInstanceOf(SyncProjectTakenError);
      expect(await store.get(BOB, project.id)).toBeUndefined();
      await expect(store.push(BOB, project.id, push(12, [volume('clip-0', 0.5)]))).rejects.toBeInstanceOf(SyncNotFoundError);
      expect((await store.list(ALICE)).map((row) => row.id)).toContain(project.id);
      expect((await store.list(BOB)).map((row) => row.id)).not.toContain(project.id);
    });

    it('pulls the document, the revision and the log since a seq', async () => {
      const project = await created();
      await store.push(ALICE, project.id, push(0, [volume('clip-0', 0.5)], { runId: 'run-a' }));
      await store.push(ALICE, project.id, push(1, [caption('cap-1', 0)]));
      const pulled = await store.get(ALICE, project.id);
      expect(pulled).toMatchObject({ revision: 2, seq: 3 });
      expect(pulled?.project.version).toBe(2);
      const log = await store.log(ALICE, project.id, 1, 100);
      expect(log?.map((entry) => [entry.seq, entry.kind, entry.revision, entry.runId])).toEqual([
        [2, 'edit', 1, 'run-a'],
        [3, 'edit', 2, null],
      ]);
      expect(await store.log(BOB, project.id, 0, 100)).toBeUndefined();
    });
  });

  describe('one transaction per push', () => {
    it('lets exactly one of several pushes on the same revision win; the rest get 409 with the current revision', async () => {
      const project = await created();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_unused, index) => store.push(ALICE, project.id, push(0, [caption(`cap-${index}`, index)]))),
      );
      const won = results.filter((result) => result.status === 'fulfilled');
      const lost = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(7);
      for (const error of lost) {
        expect(error).toBeInstanceOf(SyncConflictError);
        expect(error).toMatchObject({ expected: 0, actual: 1 });
      }
      const pulled = await store.get(ALICE, project.id);
      expect(pulled?.revision).toBe(1);
      expect(pulled?.project.tracks.find((track) => track.id === 'captions')?.clips).toHaveLength(1);
      expect((await store.log(ALICE, project.id, 0, 100))?.map((entry) => entry.seq)).toEqual([1, 2]);
    });

    it('answers a repeated change id with the original receipt and applies it once, even when the copies race', async () => {
      const project = await created();
      const request = push(0, [caption('cap-dup', 0)]);
      const first = await store.push(ALICE, project.id, request);
      expect(first).toEqual({ duplicate: false, receipt: expect.objectContaining({ baseRevision: 0, revision: 1, seq: 2 }) });
      // A retry after the device moved on still finds its receipt rather than a 409.
      await store.push(ALICE, project.id, push(1, [caption('cap-next', 1)]));
      const retry = await store.push(ALICE, project.id, request);
      expect(retry).toEqual({ duplicate: true, receipt: first.receipt });

      const racing = push(2, [caption('cap-race', 2)]);
      const copies = await Promise.all(Array.from({ length: 5 }, () => store.push(ALICE, project.id, racing)));
      expect(copies.filter((copy) => !copy.duplicate)).toHaveLength(1);
      expect(new Set(copies.map((copy) => JSON.stringify(copy.receipt))).size).toBe(1);
      const captions = (await store.get(ALICE, project.id))?.project.tracks.find((track) => track.id === 'captions')?.clips ?? [];
      expect(captions.map((clip) => clip.id)).toEqual(['cap-dup', 'cap-next', 'cap-race']);
    });

    it('keeps a gapless seq order under concurrent writers, and replaying the log rebuilds the document', async () => {
      const project = await created();
      const writers = 4;
      const each = 6;
      const writer = async (index: number): Promise<void> => {
        for (let step = 0; step < each; step += 1) {
          const id = `w${index}-s${step}`;
          for (;;) {
            const current = await store.get(ALICE, project.id);
            try {
              await store.push(ALICE, project.id, push(current?.revision ?? 0, [caption(id, index * 10 + step)]));
              break;
            } catch (error) {
              if (!(error instanceof SyncConflictError)) throw error;
            }
          }
        }
      };
      await Promise.all(Array.from({ length: writers }, (_unused, index) => writer(index)));

      const log = await store.log(ALICE, project.id, 0, 1000) ?? [];
      expect(log.map((entry) => entry.seq)).toEqual(Array.from({ length: writers * each + 1 }, (_unused, index) => index + 1));
      expect(log.map((entry) => entry.revision)).toEqual(Array.from({ length: writers * each + 1 }, (_unused, index) => index));
      // Each writer's own changes land in the order it made them.
      for (let index = 0; index < writers; index += 1) {
        const mine = log.flatMap((entry) => entry.ops).flatMap((operation) => (operation.type === 'add_caption' ? [operation.params.clip.id] : []))
          .filter((id) => id.startsWith(`w${index}-`));
        expect(mine).toEqual(Array.from({ length: each }, (_unused, step) => `w${index}-s${step}`));
      }
      const replayed = log.slice(1).reduce((doc, entry) => applyBatch(doc, entry.ops), applyBatch(project, []));
      const pulled = await store.get(ALICE, project.id);
      expect(pulled?.revision).toBe(writers * each);
      expect(projectHash(replayed)).toBe(projectHash(pulled?.project as Project));
    });

    it('refuses a change id reused for a different change, writing nothing', async () => {
      const project = await created();
      const original = push(0, [volume('clip-0', 0.5)]);
      await store.push(ALICE, project.id, original);
      await expect(store.push(ALICE, project.id, { ...original, ops: [volume('clip-0', 0.6)] })).rejects.toBeInstanceOf(SyncChangeReusedError);
      await expect(store.push(ALICE, project.id, { ...original, runId: 'another-run' })).rejects.toBeInstanceOf(SyncChangeReusedError);
      expect(await store.get(ALICE, project.id)).toMatchObject({ revision: 1, seq: 2 });
      expect((await store.push(ALICE, project.id, original)).duplicate).toBe(true);
    });

    it('bumps nothing for a no-op, and its retry gets the same receipt', async () => {
      const project = await created();
      const request = push(0, [volume('clip-0', 1)]);
      await store.push(ALICE, project.id, push(0, [volume('clip-0', 0.4)]));
      const noop = await store.push(ALICE, project.id, { ...request, baseRevision: 1, ops: [volume('clip-0', 0.4)] });
      expect(noop.receipt).toMatchObject({ revision: 1, seq: null });
      expect((await store.get(ALICE, project.id))?.seq).toBe(2);
      expect((await store.push(ALICE, project.id, { ...request, baseRevision: 1, ops: [volume('clip-0', 0.4)] }))).toEqual({ duplicate: true, receipt: noop.receipt });
    });

    it('refuses a result the device did not get, and ops that would need a server-minted id, writing nothing', async () => {
      const project = await created();
      const expectedHash = projectHash(applyBatch(project, [volume('clip-0', 0.5)]));
      await expect(store.push(ALICE, project.id, push(0, [volume('clip-0', 0.6)], { expectedHash }))).rejects.toBeInstanceOf(SyncMismatchError);
      await expect(store.push(ALICE, project.id, push(0, [{ type: 'split_clip', params: { clipId: 'clip-0', at: 2 } }])))
        .rejects.toThrow(/newClipId/);
      expect(await store.get(ALICE, project.id)).toMatchObject({ revision: 0, seq: 1 });
      const ok = await store.push(ALICE, project.id, push(0, [volume('clip-0', 0.5)], { expectedHash }));
      expect(ok.receipt).toMatchObject({ revision: 1, hash: expectedHash });
    });
  });

  describe('history replays exactly as the SQLite ProjectStore does', () => {
    /** Each step runs on both stores; the documents must match after every one, and so must refusals. */
    type Step = { ops: Operation[]; runId?: string };
    const undo: Operation = { type: 'undo', params: {} };
    const redo: Operation = { type: 'redo', params: {} };
    const revert = (runId: string): Operation => ({ type: 'revert_run', params: { runId } });
    const addVideo = (id: string, start: number): Operation => ({
      type: 'add_clip', params: { trackId: 'video-main', clip: { id, assetId: 'asset-a', start, in: 0, out: 2 } },
    });

    async function differential(steps: Step[]): Promise<void> {
      const database = createDatabase(':memory:');
      const sqlite = new ProjectStore(database);
      const initial = await created();
      sqlite.insert(initial);
      grant(database, initial.id, 'asset-a');
      try {
        for (const [index, step] of steps.entries()) {
          let local: Project | Error;
          try {
            const base = sqlite.get(initial.id) as Project;
            local = sqlite.applyOperations(initial.id, step.ops, base.version, step.runId);
          } catch (error) {
            local = error as Error;
          }
          const remote = await store.get(ALICE, initial.id) as { revision: number };
          let synced: Project | Error;
          try {
            await store.push(ALICE, initial.id, push(remote.revision, step.ops, step.runId ? { runId: step.runId } : {}));
            synced = (await store.get(ALICE, initial.id))?.project as Project;
          } catch (error) {
            synced = error as Error;
          }
          const label = `step ${index}: ${step.ops.map((operation) => operation.type).join(',')}`;
          if (local instanceof Error || synced instanceof Error) {
            expect(synced instanceof Error ? synced.message : 'applied', label).toBe(local instanceof Error ? local.message : 'applied');
          } else {
            expect(synced.version, label).toBe(local.version);
            expect(projectHash(synced), label).toBe(projectHash(local));
          }
        }
      } finally {
        database.close();
      }
    }

    it('undo, a stack of undos, redo back up, and redo cleared by a new edit', async () => {
      await differential([
        { ops: [addVideo('a', 4)] },
        { ops: [addVideo('b', 6), volume('a', 0.5)] },
        { ops: [volume('clip-0', 0.2)] },
        { ops: [undo] },
        { ops: [undo] },
        { ops: [redo] },
        { ops: [redo] },
        { ops: [redo] },
        { ops: [undo] },
        { ops: [volume('a', 0.9)] },
        { ops: [redo] },
        { ops: [undo] },
        { ops: [undo] },
        { ops: [undo] },
        { ops: [undo] },
        { ops: [undo] },
      ]);
    });

    it('revert_run across batches, its undo and redo, and the refusals', async () => {
      await differential([
        { ops: [volume('clip-0', 0.3)] },
        { ops: [addVideo('r1', 4)], runId: 'run-1' },
        { ops: [addVideo('r2', 6)], runId: 'run-1' },
        { ops: [undo], runId: 'run-1' },
        { ops: [volume('r1', 0.5)], runId: 'run-1' },
        { ops: [revert('run-1')] },
        { ops: [revert('run-1')] },
        { ops: [undo] },
        { ops: [redo] },
        { ops: [undo] },
        { ops: [volume('clip-0', 0.8)] },
        { ops: [revert('run-1')] },
        { ops: [revert('run-missing')] },
        { ops: [undo, volume('clip-0', 0.1)] },
      ]);
    });
  });

  describe('routes', () => {
    let app: FastifyInstance;
    beforeEach(async () => {
      app = Fastify();
      app.addHook('onRequest', async (request) => {
        const user = request.headers['x-user'];
        if (typeof user === 'string') request.userId = user;
      });
      registerSyncRoutes(app, store);
      await app.ready();
      return async () => { await app.close(); };
    });

    it('creates, pushes, dedupes, answers stale with the current revision, and scopes by user', async () => {
      const project = freshProject();
      const headers = { 'x-user': ALICE };
      expect((await app.inject({ method: 'POST', url: '/sync/projects', headers, payload: { project } })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/sync/projects', headers, payload: { project } })).statusCode).toBe(200);

      const body = push(0, [volume('clip-0', 0.5)]);
      const first = await app.inject({ method: 'POST', url: `/sync/projects/${project.id}/changes`, headers, payload: body });
      expect(first.statusCode).toBe(200);
      expect(first.json().receipt).toMatchObject({ projectId: project.id, changeId: body.changeId, revision: 1, seq: 2 });
      const retry = await app.inject({ method: 'POST', url: `/sync/projects/${project.id}/changes`, headers, payload: body });
      expect(retry.json()).toEqual(first.json());
      expect(retry.headers['editify-sync-replay']).toBe('true');

      const reused = await app.inject({ method: 'POST', url: `/sync/projects/${project.id}/changes`, headers, payload: { ...body, ops: [volume('clip-0', 0.2)] } });
      expect(reused.statusCode).toBe(409);
      expect(reused.json()).toMatchObject({ code: 'change_id_reused' });
      const longId = await app.inject({ method: 'POST', url: '/sync/projects', headers, payload: { project: { ...project, id: 'x'.repeat(129) } } });
      expect(longId.statusCode).toBe(400);

      const stale = await app.inject({ method: 'POST', url: `/sync/projects/${project.id}/changes`, headers, payload: push(0, [volume('clip-0', 0.7)]) });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'stale', expected: 0, revision: 1 });

      const bad = await app.inject({ method: 'POST', url: `/sync/projects/${project.id}/changes`, headers, payload: push(1, [volume('missing', 0.7)]) });
      expect(bad.statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/sync/projects/${project.id}/changes`, headers, payload: { ops: [] } })).statusCode).toBe(400);

      const pulled = await app.inject({ method: 'GET', url: `/sync/projects/${project.id}`, headers });
      expect(pulled.json()).toMatchObject({ revision: 1, seq: 2, project: { id: project.id, version: 1 } });
      const log = await app.inject({ method: 'GET', url: `/sync/projects/${project.id}/log?since=1`, headers });
      expect(log.json().entries.map((entry: { seq: number }) => entry.seq)).toEqual([2]);

      const asBob = { 'x-user': BOB };
      expect((await app.inject({ method: 'GET', url: `/sync/projects/${project.id}`, headers: asBob })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/sync/projects/${project.id}/changes`, headers: asBob, payload: push(1, [volume('clip-0', 0.1)]) })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/sync/projects/${project.id}`, headers: asBob })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/sync/projects' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'DELETE', url: `/sync/projects/${project.id}`, headers })).statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url: `/sync/projects/${project.id}`, headers })).statusCode).toBe(404);
    });
  });

  describe('row level security', () => {
    it('is on for all three tables, with select-only policies on auth.uid() = user_id', async () => {
      const tables = await pool.query<{ relname: string; relrowsecurity: boolean }>(
        "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('sync_projects', 'sync_op_log', 'sync_receipts') ORDER BY relname",
      );
      expect(tables.rows).toEqual([
        { relname: 'sync_op_log', relrowsecurity: true },
        { relname: 'sync_projects', relrowsecurity: true },
        { relname: 'sync_receipts', relrowsecurity: true },
      ]);
      const policies = await pool.query<{ tablename: string; cmd: string; roles: string; qual: string }>(
        "SELECT tablename, cmd, roles::text, qual FROM pg_policies WHERE tablename LIKE 'sync\\_%' ORDER BY tablename",
      );
      expect(policies.rows.map((row) => [row.tablename, row.cmd, row.roles])).toEqual([
        ['sync_op_log', 'SELECT', '{authenticated}'],
        ['sync_projects', 'SELECT', '{authenticated}'],
        ['sync_receipts', 'SELECT', '{authenticated}'],
      ]);
      for (const row of policies.rows) expect(row.qual).toMatch(/auth\.uid\(\).*= user_id/);
    });

    it('leaves anon nothing and authenticated only SELECT', async () => {
      for (const table of ['sync_projects', 'sync_op_log', 'sync_receipts']) {
        const { rows } = await pool.query<{ role: string; privilege: string }>(
          `SELECT grantee AS role, privilege_type AS privilege FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND table_name = $1 AND grantee IN ('anon', 'authenticated') ORDER BY 1, 2`,
          [table],
        );
        expect(rows, table).toEqual([{ role: 'authenticated', privilege: 'SELECT' }]);
      }
    });

    it('aborts, changing nothing, when a sync table already exists with a different shape', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE sync_receipts RENAME COLUMN request_digest TO digest');
        await expect(client.query(readFileSync(MIGRATION, 'utf8'))).rejects.toThrow(/sync_receipts already exists without column request_digest/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('shows a signed-in client only its own rows and refuses its writes', async () => {
      const mine = await created(ALICE);
      const theirs = await created(BOB);
      await store.push(BOB, theirs.id, push(0, [volume('clip-0', 0.5)]));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE authenticated');
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ALICE, role: 'authenticated' })]);
        const projects = await client.query<{ id: string; user_id: string }>('SELECT id, user_id FROM sync_projects');
        expect(projects.rows.map((row) => row.id)).toContain(mine.id);
        expect(projects.rows.every((row) => row.user_id === ALICE)).toBe(true);
        const log = await client.query<{ user_id: string }>('SELECT user_id FROM sync_op_log');
        expect(log.rows.every((row) => row.user_id === ALICE)).toBe(true);
        const receipts = await client.query('SELECT 1 FROM sync_receipts WHERE project_id = $1', [theirs.id]);
        expect(receipts.rowCount).toBe(0);
        await client.query('SAVEPOINT write');
        await expect(client.query("UPDATE sync_projects SET revision = 99 WHERE id = $1", [mine.id])).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK TO SAVEPOINT write');
        await expect(client.query(
          "INSERT INTO sync_projects (id, user_id, doc, revision) VALUES ('forged', $1, '{}', 0)", [ALICE],
        )).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE anon');
        await expect(client.query('SELECT 1 FROM sync_projects')).rejects.toThrow(/permission denied/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });
  });

  describe('agent turn lock', () => {
    const PROJECT = 'lock-project';
    const turn = (proposalId: string, projectId = PROJECT): AgentTurnRequest => ({
      message: 'tighten this',
      proposalId,
      snapshot: {
        project: { ...freshProject(), id: projectId, version: 3 },
        assets: [{ id: 'asset-a', originalName: 'set.mov', duration: 4, width: 1080, height: 1920, fps: 30, hasAudio: true }],
      },
    });

    /** One Fly machine: its own pools (the real config), so the lock has to hold across processes, not just requests. */
    async function machine(provider: ToolProvider, env: NodeJS.ProcessEnv = {}): Promise<{ app: FastifyInstance; pools: PgPools }> {
      const pools = createPgPools(TEST_URL, env);
      const app = Fastify();
      app.addHook('onRequest', async (request) => { request.userId = ALICE; });
      registerAgentTurnRoutes(app, new AgentService(async () => provider), { lock: new PgTurnLock(pools.lock as pg.Pool) });
      await app.ready();
      return { app, pools };
    }

    /** Whether this exact advisory key is held, by anyone. */
    async function held(key: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1
           AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
        [key],
      );
      return (rowCount ?? 0) > 0;
    }

    function gated(): { provider: ToolProvider; running: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started: () => void = () => undefined;
      const running = new Promise<void>((resolve) => { started = resolve; });
      return {
        provider: { name: 'mock', async runTurn() { started(); await gate; return { text: 'Done.', toolCalls: [] }; }, async completeText() { return ''; } },
        running,
        release: () => release(),
      };
    }

    const quick: ToolProvider = {
      name: 'mock',
      async runTurn() { return { text: 'Done.', toolCalls: [] }; },
      async completeText() { return ''; },
    };
    const post = async (app: FastifyInstance, request: AgentTurnRequest) =>
      await app.inject({ method: 'POST', url: '/agent/turn', payload: request as unknown as Record<string, unknown> });

    it('blocks a second concurrent turn on the same project from another machine, and frees it when the first ends', async () => {
      const slow = gated();
      const first = await machine(slow.provider);
      const second = await machine(quick);
      const key = turnLockKey(ALICE, PROJECT);
      try {
        const holding = post(first.app, turn('proposal-lock-1'));
        await slow.running;
        expect(await held(key)).toBe(true);
        expect(await held(turnLockKey(ALICE, 'lock-project-2'))).toBe(false);

        const blocked = await post(second.app, turn('proposal-lock-2'));
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toMatchObject({ code: 'busy' });
        expect((await post(second.app, turn('proposal-lock-3', 'lock-project-2'))).statusCode).toBe(200);

        slow.release();
        expect((await holding).statusCode).toBe(200);
        expect(await held(key)).toBe(false);
        expect((await post(second.app, turn('proposal-lock-4'))).statusCode).toBe(200);
      } finally {
        slow.release();
        await first.app.close();
        await second.app.close();
        await first.pools.end();
        await second.pools.end();
      }
    });

    it('releases the lock when the turn throws', async () => {
      let started: () => void = () => undefined;
      const running = new Promise<void>((resolve) => { started = resolve; });
      let fail: (error: Error) => void = () => undefined;
      const failing: ToolProvider = {
        name: 'mock',
        async runTurn() { started(); return await new Promise((_resolve, reject) => { fail = reject; }); },
        async completeText() { return ''; },
      };
      const broken = await machine(failing);
      const other = await machine(quick);
      const key = turnLockKey(ALICE, 'lock-project-throws');
      try {
        const turning = post(broken.app, turn('proposal-throw-1', 'lock-project-throws'));
        await running;
        expect(await held(key)).toBe(true);
        fail(new Error('model fell over'));
        expect((await turning).statusCode).toBe(500);
        expect(await held(key)).toBe(false);
        expect((await post(other.app, turn('proposal-throw-2', 'lock-project-throws'))).statusCode).toBe(200);
      } finally {
        await broken.app.close();
        await other.app.close();
        await broken.pools.end();
        await other.pools.end();
      }
    });

    it('lets go of a lock held past the maximum turn duration', async () => {
      const pools = createPgPools(TEST_URL, {});
      const key = turnLockKey(ALICE, 'lock-project-hung');
      try {
        const release = await new PgTurnLock(pools.lock as pg.Pool, 50).tryAcquire(ALICE, 'lock-project-hung');
        expect(release).toBeDefined();
        expect(await held(key)).toBe(true);
        await new Promise((resolve) => { setTimeout(resolve, 200); });
        expect(await held(key)).toBe(false);
        await release?.();
      } finally {
        await pools.end();
      }
    });

    it('answers 503 instead of waiting when every lock connection is in a turn, leaving /sync its own pool', async () => {
      const slow = gated();
      const small = await machine(slow.provider, { DATABASE_LOCK_POOL_MAX: '1' });
      try {
        const holding = post(small.app, turn('proposal-cap-1', 'lock-project-cap-a'));
        await slow.running;
        const refused = await post(small.app, turn('proposal-cap-2', 'lock-project-cap-b'));
        expect(refused.statusCode).toBe(503);
        expect(refused.json()).toMatchObject({ code: 'capacity' });
        // The sync pool is separate, so a push still goes through while the turn holds its connection.
        const syncStore = new PgSyncStore(small.pools.sync);
        const project = (await syncStore.create(ALICE, freshProject())).project;
        expect((await syncStore.push(ALICE, project.id, push(0, [volume('clip-0', 0.5)]))).receipt.revision).toBe(1);
        slow.release();
        expect((await holding).statusCode).toBe(200);
      } finally {
        slow.release();
        await small.app.close();
        await small.pools.end();
      }
    });
  });
});
