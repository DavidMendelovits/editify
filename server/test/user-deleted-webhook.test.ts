import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts reads these at import time, and vitest runs this block before the
// imports below: purges land in a scratch data dir, and the admin API has a URL.
const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const saved = {
    EDITIFY_DATA_DIR: process.env.EDITIFY_DATA_DIR,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const dataDir = mkdtempSync(joinPath(tmpdir(), 'editify-webhook-'));
  process.env.EDITIFY_DATA_DIR = dataDir;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-for-tests';
  return { dataDir, saved };
});

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { SettingsStore } from '../src/db/settings-store.js';
import { USER_DELETED_PATH } from '../src/routes/webhooks.js';
import { listDataOwners } from '../src/services/account-service.js';
import { sweepOrphans } from '../src/services/orphan-sweep.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '../src/services/webhook-signature.js';

const SECRET = 'webhook-secret-for-tests';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const media = (id: string) => ({
  id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1, width: 10, height: 10,
  fps: 30, hasAudio: false, originalPath: '/x', proxyPath: '/x', thumbnailPath: '/x',
  originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date().toISOString(),
});

/** A user with a project, a render file on disk, and an asset directory on disk. */
function seedUser(database: EditifyDatabase, userId: string, tag: string): { assetDir: string; renderFile: string } {
  const project = new ProjectStore(database).create({ title: tag, format: '9:16', fps: 30 }, userId);
  new AssetStore(database).insert(media(`webhook-${tag}-clip`), userId);
  const assetDir = join(scratch.dataDir, 'assets', `webhook-${tag}-clip`);
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, 'original.mp4'), 'x');
  const render = new RenderStore(database).create(project.id, '720p');
  const renderFile = join(scratch.dataDir, `render-${tag}.mp4`);
  writeFileSync(renderFile, 'x');
  database.prepare('UPDATE renders SET output_path = ? WHERE id = ?').run(renderFile, render.id);
  return { assetDir, renderFile };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function delivery(body: object, options: { secret?: string; timestamp?: number; tamper?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? nowSeconds());
  return {
    method: 'POST' as const,
    url: USER_DELETED_PATH,
    headers: {
      'content-type': 'application/json',
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signWebhook(options.secret ?? SECRET, timestamp, raw),
    },
    payload: options.tamper ? raw.replace(ALICE, BOB) : raw,
  };
}

const event = (eventId: string, userId = ALICE) => ({ type: 'user.deleted', event_id: eventId, user_id: userId });
const projectCount = (database: EditifyDatabase, userId: string) =>
  (database.prepare('SELECT COUNT(*) AS count FROM projects WHERE user_id = ?').get(userId) as { count: number }).count;

/**
 * What Supabase Auth sends for an unknown id with no API version header: the
 * legacy envelope from internal/api/admin.go (loadUser), plus x-sb-error-code.
 */
const userNotFound = () => new Response(
  JSON.stringify({ code: 404, error_code: 'user_not_found', msg: 'User not found' }),
  { status: 404, headers: { 'content-type': 'application/json', 'x-sb-error-code': 'user_not_found' } },
);

/** A 404 that is not Auth's answer: a wrong SUPABASE_URL path, a proxy, a gateway. */
const gateway404 = () => new Response(
  JSON.stringify({ message: 'no Route matched with those values' }),
  { status: 404, headers: { 'content-type': 'application/json' } },
);

/** The admin API: Auth's user_not_found for ids in `gone`, 200 for everyone else. */
function stubAdmin(gone: string[], status?: number) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (status) return new Response('{}', { status });
    const id = decodeURIComponent(String(url).split('/').pop() ?? '');
    return gone.includes(id) ? userNotFound() : new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Restored once every block has run: the sweep blocks below use the admin API too.
afterAll(() => {
  for (const [key, value] of Object.entries(scratch.saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /webhooks/supabase/user-deleted', () => {
  let database: EditifyDatabase;
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.SUPABASE_WEBHOOK_SECRET = SECRET;
    database = createDatabase(':memory:');
    app = await buildApp({ database });
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_WEBHOOK_SECRET;
    delete process.env.READ_ONLY;
  });

  it('purges a confirmed-deleted user (rows and files), leaving others alone', async () => {
    const alice = seedUser(database, ALICE, 'alice');
    const bob = seedUser(database, BOB, 'bob');
    new SettingsStore(database).setFor('style.analyzer', 'ffmpeg', ALICE);
    const fetchMock = stubAdmin([ALICE]);

    const response = await app.inject(delivery(event('evt-1')));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'purged',
      eventId: 'evt-1',
      purged: { rows: { projects: 1, assets: 1, reports: 0, styles: 0 }, files: { assetDirs: 1, renderOutputs: 1 } },
    });
    // The admin lookup, with the service key, for exactly this user.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://supabase.test/auth/v1/admin/users/${ALICE}`);
    expect((init.headers as Record<string, string>).apikey).toBe('service-role-for-tests');

    expect(existsSync(alice.assetDir)).toBe(false);
    expect(existsSync(alice.renderFile)).toBe(false);
    expect(existsSync(bob.assetDir)).toBe(true);
    expect(existsSync(bob.renderFile)).toBe(true);
    expect(projectCount(database, ALICE)).toBe(0);
    expect(projectCount(database, BOB)).toBe(1);
    expect(listDataOwners(database)).toEqual([BOB]);
  });

  it('purges whole render directories (captions and contact sheet too), even unfinished renders', async () => {
    stubAdmin([ALICE]);
    const renderDirs = (userId: string, tag: string) => {
      const project = new ProjectStore(database).create({ title: tag, format: '9:16', fps: 30 }, userId);
      const renders = new RenderStore(database);
      const done = renders.create(project.id, '720p');
      const failed = renders.create(project.id, '720p');
      const doneDir = join(scratch.dataDir, 'renders', done.id);
      const failedDir = join(scratch.dataDir, 'renders', failed.id);
      for (const dir of [doneDir, failedDir]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(doneDir, 'output.mp4'), 'x');
      writeFileSync(join(doneDir, 'contact.jpg'), 'x');
      writeFileSync(join(doneDir, 'captions.ass'), 'Dialogue: private words');
      // A failed render never records an output, but its caption file stays behind.
      writeFileSync(join(failedDir, 'captions.ass'), 'Dialogue: private words');
      renders.update(done.id, 'done', { outputPath: join(doneDir, 'output.mp4') });
      renders.update(failed.id, 'error', { error: 'ffmpeg exploded' });
      return { doneDir, failedDir };
    };
    const alice = renderDirs(ALICE, 'alice-renders');
    const bob = renderDirs(BOB, 'bob-renders');

    const response = await app.inject(delivery(event('evt-render-dirs')));
    expect(response.json().purged.files).toEqual({ assetDirs: 0, renderOutputs: 2 });
    expect(existsSync(alice.doneDir)).toBe(false);
    expect(existsSync(alice.failedDir)).toBe(false);
    expect(existsSync(join(bob.doneDir, 'captions.ass'))).toBe(true);
    expect(existsSync(join(bob.failedDir, 'captions.ass'))).toBe(true);
  });

  it('never resolves a recursive delete outside its own asset or render directory', async () => {
    stubAdmin([ALICE]);
    const bob = seedUser(database, BOB, 'bob-escape');
    // Ids are server UUIDs, but a bad row must not turn into `rm -rf <data dir>`.
    new AssetStore(database).insert(media('..'), ALICE);
    const response = await app.inject(delivery(event('evt-escape')));
    expect(response.statusCode).toBe(200);
    expect(existsSync(bob.assetDir)).toBe(true);
    expect(existsSync(bob.renderFile)).toBe(true);
  });

  it('verifies the exact bytes Postgres sends (jsonb::text spacing, charset parameter)', async () => {
    stubAdmin([ALICE]);
    seedUser(database, ALICE, 'pg-shape');
    // What `payload::text` looks like for the trigger's jsonb_build_object.
    const raw = `{"type": "user.deleted", "user_id": "${ALICE}", "event_id": "evt-pg", "occurred_at": "2026-10-03 12:00:00.123+00"}`;
    const timestamp = String(nowSeconds());
    const response = await app.inject({
      method: 'POST',
      url: USER_DELETED_PATH,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signWebhook(SECRET, timestamp, raw),
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('purged');
  });

  it('is idempotent per event id: a repeat answers 200 without purging again', async () => {
    const fetchMock = stubAdmin([ALICE]);
    seedUser(database, ALICE, 'replay1');
    expect((await app.inject(delivery(event('evt-replay')))).json().status).toBe('purged');

    // New data for the same id after the first delivery: a re-purge would take it.
    new ProjectStore(database).create({ title: 'later', format: '9:16', fps: 30 }, ALICE);
    const repeat = await app.inject(delivery(event('evt-replay')));
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ status: 'duplicate', eventId: 'evt-replay' });
    expect(projectCount(database, ALICE)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses with 409 when the admin API says the user still exists', async () => {
    stubAdmin([]);
    seedUser(database, ALICE, 'alive');
    const response = await app.inject(delivery(event('evt-alive')));
    expect(response.statusCode).toBe(409);
    expect(projectCount(database, ALICE)).toBe(1);
    // A refusal is not recorded, so a later genuine delivery still runs.
    stubAdmin([ALICE]);
    expect((await app.inject(delivery(event('evt-alive')))).json().status).toBe('purged');
  });

  it('answers 503 and deletes nothing when the admin API cannot confirm', async () => {
    stubAdmin([], 500);
    seedUser(database, ALICE, 'outage');
    expect((await app.inject(delivery(event('evt-outage')))).statusCode).toBe(503);
    expect(projectCount(database, ALICE)).toBe(1);
  });

  it('answers 503 and deletes nothing on a 404 that is not Auth saying user_not_found', async () => {
    seedUser(database, ALICE, 'gateway');
    for (const response of [
      gateway404,
      () => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
      () => new Response('', { status: 404 }),
      // Auth's own 404 for a malformed id is not "gone" either.
      () => new Response(JSON.stringify({ code: 404, error_code: 'validation_failed', msg: 'user_id must be an UUID' }), { status: 404 }),
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => response()));
      expect((await app.inject(delivery(event('evt-gateway')))).statusCode).toBe(503);
      expect(projectCount(database, ALICE)).toBe(1);
    }
  });

  it('accepts user_not_found in the 2024-01-01 error envelope and from the header alone', async () => {
    seedUser(database, ALICE, 'versioned');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 'user_not_found', message: 'User not found' }), { status: 404 },
    )));
    expect((await app.inject(delivery(event('evt-versioned')))).json().status).toBe('purged');

    seedUser(database, ALICE, 'header-only');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404, headers: { 'x-sb-error-code': 'user_not_found' } })));
    expect((await app.inject(delivery(event('evt-header-only')))).json().status).toBe('purged');
  });

  it('rejects bad, missing and tampered signatures with 401 before any lookup', async () => {
    const fetchMock = stubAdmin([ALICE]);
    seedUser(database, ALICE, 'forged');
    const wrongKey = await app.inject(delivery(event('evt-forged'), { secret: 'not-the-secret' }));
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.json().reason).toBe('bad-signature');

    const tampered = await app.inject(delivery(event('evt-forged'), { tamper: true }));
    expect(tampered.json().reason).toBe('bad-signature');

    const unsigned = delivery(event('evt-forged'));
    delete (unsigned.headers as Record<string, string>)[SIGNATURE_HEADER];
    const missing = await app.inject(unsigned);
    expect(missing.statusCode).toBe(401);
    expect(missing.json().reason).toBe('missing-headers');

    const noTimestamp = delivery(event('evt-forged'));
    delete (noTimestamp.headers as Record<string, string>)[TIMESTAMP_HEADER];
    expect((await app.inject(noTimestamp)).json().reason).toBe('missing-headers');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(projectCount(database, ALICE)).toBe(1);
  });

  it('rejects stale and future timestamps, allowing small clock skew', async () => {
    stubAdmin([ALICE]);
    const stale = await app.inject(delivery(event('evt-stale'), { timestamp: nowSeconds() - 301 }));
    expect(stale.statusCode).toBe(401);
    expect(stale.json().reason).toBe('stale');

    const future = await app.inject(delivery(event('evt-future'), { timestamp: nowSeconds() + 120 }));
    expect(future.statusCode).toBe(401);
    expect(future.json().reason).toBe('future');

    const skewed = await app.inject(delivery(event('evt-skew'), { timestamp: nowSeconds() + 10 }));
    expect(skewed.statusCode).toBe(200);
  });

  it('answers 503 without a configured secret, never accepting unsigned', async () => {
    delete process.env.SUPABASE_WEBHOOK_SECRET;
    const fetchMock = stubAdmin([ALICE]);
    seedUser(database, ALICE, 'nosecret');
    // Signed with the empty string, the only key an unconfigured server could hold.
    const response = await app.inject(delivery(event('evt-nosecret'), { secret: '' }));
    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(projectCount(database, ALICE)).toBe(1);
  });

  it('answers 503 in read-only mode', async () => {
    process.env.READ_ONLY = '1';
    stubAdmin([ALICE]);
    seedUser(database, ALICE, 'readonly');
    expect((await app.inject(delivery(event('evt-ro')))).statusCode).toBe(503);
    expect(projectCount(database, ALICE)).toBe(1);
  });

  it('rejects a signed body that is not a user.deleted event', async () => {
    stubAdmin([ALICE]);
    const response = await app.inject(delivery({ type: 'user.created', event_id: 'e', user_id: ALICE }));
    expect(response.statusCode).toBe(400);
  });

  it('opts only this route out of bearer auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/projects' })).statusCode).toBe(401);
  });
});

describe('orphan sweep', () => {
  const CAROL = '33333333-3333-4333-8333-333333333333';

  it('lists orphans on a dry run and purges only them with purge', async () => {
    const database = createDatabase(':memory:');
    const alice = seedUser(database, ALICE, 'sweep-alice');
    seedUser(database, BOB, 'sweep-bob');
    // An owner known only through a per-user preference still counts.
    new SettingsStore(database).setFor('style.analyzer', 'ffmpeg', CAROL);
    const exists = async (userId: string) => userId === BOB;

    const dry = await sweepOrphans(database, { exists });
    expect(dry).toEqual({ owners: 3, orphans: [ALICE, CAROL], purged: {} });
    expect(projectCount(database, ALICE)).toBe(1);
    expect(existsSync(alice.assetDir)).toBe(true);

    const wet = await sweepOrphans(database, { exists, purge: true });
    expect(wet.orphans).toEqual([ALICE, CAROL]);
    expect(wet.purged[ALICE]).toEqual({
      rows: { projects: 1, assets: 1, reports: 0, styles: 0 },
      files: { assetDirs: 1, renderOutputs: 1 },
    });
    expect(projectCount(database, ALICE)).toBe(0);
    expect(existsSync(alice.assetDir)).toBe(false);
    expect(listDataOwners(database)).toEqual([BOB]);
    database.close();
  });

  it('refuses to purge when every owner looks deleted, unless forced', async () => {
    const database = createDatabase(':memory:');
    seedUser(database, ALICE, 'all-alice');
    seedUser(database, BOB, 'all-bob');
    const gone = async () => false;
    const refused = await sweepOrphans(database, { exists: gone, purge: true });
    expect(refused.refused).toMatch(/Every owner/);
    expect(refused.purged).toEqual({});
    expect(projectCount(database, ALICE)).toBe(1);

    const forced = await sweepOrphans(database, { exists: gone, purge: true, force: true });
    expect(Object.keys(forced.purged)).toEqual([ALICE, BOB]);
    database.close();
  });

  it('confirms through the admin API only on user_not_found, aborting on a gateway 404', async () => {
    const database = createDatabase(':memory:');
    seedUser(database, ALICE, 'api-alice');
    seedUser(database, BOB, 'api-bob');
    // Bob is really gone; Alice's lookup hits something that is not Auth.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => (String(url).endsWith(BOB) ? userNotFound() : gateway404())));
    await expect(sweepOrphans(database, { purge: true })).rejects.toThrow(/lookup failed \(404\)/);
    expect(projectCount(database, ALICE)).toBe(1);
    expect(projectCount(database, BOB)).toBe(1);

    stubAdmin([BOB]);
    const swept = await sweepOrphans(database, { purge: true });
    expect(swept.orphans).toEqual([BOB]);
    expect(projectCount(database, BOB)).toBe(0);
    expect(projectCount(database, ALICE)).toBe(1);
    vi.unstubAllGlobals();
    database.close();
  });

  it('aborts on a lookup error before deleting anything', async () => {
    const database = createDatabase(':memory:');
    seedUser(database, ALICE, 'err-alice');
    seedUser(database, BOB, 'err-bob');
    const flaky = async (userId: string) => {
      if (userId === BOB) throw new Error('Supabase admin lookup failed (500)');
      return false;
    };
    await expect(sweepOrphans(database, { exists: flaky, purge: true })).rejects.toThrow(/500/);
    expect(projectCount(database, ALICE)).toBe(1);
    database.close();
  });
});

describe('orphan-sweep script under READ_ONLY=1', () => {
  const script = fileURLToPath(new URL('../scripts/orphan-sweep.ts', import.meta.url));
  const serverDir = fileURLToPath(new URL('..', import.meta.url));
  const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: serverDir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      EDITIFY_DATA_DIR: scratch.dataDir,
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-for-tests',
      ...env,
    },
  });

  it('refuses --purge with a clear message and a non-zero exit, before opening anything', () => {
    const missing = join(scratch.dataDir, 'never-created.db');
    const result = run(['--purge'], { READ_ONLY: '1', DATABASE_PATH: missing });
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/READ_ONLY=1.*--purge will not run/);
    expect(existsSync(missing)).toBe(false);
  });

  it('runs the dry run on a read-only connection, leaving the file byte-identical', () => {
    const path = join(scratch.dataDir, 'frozen.db');
    createDatabase(path, { readonly: false }).close();
    const before = readFileSync(path);
    const result = run([], { READ_ONLY: '1', DATABASE_PATH: path });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', owners: 0, orphans: [] });
    expect(readFileSync(path).equals(before)).toBe(true);

    // A read-write open would create a missing file; the read-only one refuses it.
    const absent = join(scratch.dataDir, 'absent.db');
    expect(run([], { READ_ONLY: '1', DATABASE_PATH: absent }).status).not.toBe(0);
    expect(existsSync(absent)).toBe(false);
  });
});
