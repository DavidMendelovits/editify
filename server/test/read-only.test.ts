import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { ChatStore } from '../src/db/chat-store.js';
import { createDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { READ_ONLY_RETRY_AFTER_SECONDS } from '../src/read-only.js';

/**
 * The cutover freeze (plan C20): with READ_ONLY=1, a sweep of real requests
 * must leave the SQLite file byte-identical, every write must get a 503, and
 * the read paths that normally cache what they compute must still answer.
 */
const SUPABASE = 'https://read-only.supabase.test';
const ALICE = 'alice-ro';
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'EDITIFY_TOKEN', 'GEMINI_API_KEY', 'READ_ONLY', 'MUTATION_JOURNAL'] as const;
const saved: Record<string, string | undefined> = {};

let dir = '';
let dbPath = '';
let jwks: JWTVerifyGetKey;
let headers: Record<string, string> = {};
const ids = { project: '', render: '', queued: '', asset: 'seeded-clip', fresh: 'fresh-clip' };

/**
 * editify.db and its -wal together: in WAL mode a commit lands in the -wal
 * file first, so hashing the .db alone would miss a write the freeze let
 * through until the next checkpoint.
 */
const sha256 = (path: string): string => {
  const hash = createHash('sha256');
  for (const file of [path, `${path}-wal`]) hash.update(`${file.slice(path.length)}:`).update(existsSync(file) ? readFileSync(file) : 'absent');
  return hash.digest('hex');
};

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), alg: 'ES256', kid: 'ro', use: 'sig' }] });
  const token = await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'ro' })
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setSubject(ALICE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  headers = { authorization: `Bearer ${token}` };

  dir = mkdtempSync(join(tmpdir(), 'editify-read-only-'));
  dbPath = join(dir, 'editify.db');
  const media = join(dir, 'media');
  mkdirSync(media);
  // A real second of picture and tone, so the waveform and dissection paths
  // actually compute (and would store) something.
  const clip = join(media, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:d=1',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip]);
  copyFileSync(clip, join(media, 'proxy.mp4'));
  writeFileSync(join(media, 'out.mp4'), 'master');

  // Seed through a normal, writable open: this is the file 1.0 freezes. The
  // last commits stay in editify.db-wal (no automatic checkpoint, and the
  // files are copied before the clean close would fold them in), the state a
  // machine is in when the flip lands before a checkpoint.
  const seedPath = join(dir, 'seed.db');
  const database = createDatabase(seedPath, { readonly: false, journal: false });
  database.pragma('wal_autocheckpoint = 0');
  const projects = new ProjectStore(database);
  ids.project = projects.create({ title: 'Frozen', format: '9:16', fps: 30 }, ALICE).id;
  const assets = new AssetStore(database);
  const row = (id: string) => ({
    id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1, width: 64, height: 64, fps: 25, hasAudio: true,
    originalPath: clip, proxyPath: join(media, 'proxy.mp4'), thumbnailPath: clip,
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
  });
  for (const id of [ids.asset, ids.fresh]) {
    assets.insert(row(id), ALICE);
    assets.link(ids.project, id);
  }
  new TranscriptStore(database).put(ids.asset, {
    language: 'en', durationProcessedSeconds: 1, words: [{ w: 'hi', s: 0, e: 0.5 }], segments: [{ s: 0, e: 0.5, text: 'hi there!' }],
  });
  const renders = new RenderStore(database);
  ids.render = renders.create(ids.project, '720p').id;
  renders.update(ids.render, 'done', { outputPath: join(media, 'out.mp4') });
  // Stranded by a restart: a writable boot would re-queue it.
  ids.queued = renders.create(ids.project, '720p').id;
  new ChatStore(database).add(ids.project, 'user', 'cut the intro');
  for (const suffix of ['', '-wal', '-shm']) copyFileSync(`${seedPath}${suffix}`, `${dbPath}${suffix}`);
  database.close();
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function frozenApp(): Promise<FastifyInstance> {
  return await buildApp({ database: createDatabase(dbPath, { readonly: true }), readOnly: true, auth: { supabaseUrl: SUPABASE, jwks } });
}

describe('READ_ONLY=1', () => {
  it('serves a sweep of reads, refuses every write, and leaves editify.db and its -wal byte-identical', async () => {
    // The freeze has to hold for commits still in the WAL, not just the .db.
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    const before = sha256(dbPath);
    const app = await frozenApp();
    const { project, render, queued, asset, fresh } = ids;

    const reads: Array<[string, number]> = [
      ['/health', 200],
      ['/client-config', 200],
      ['/renders', 200],
      ['/presets', 200],
      ['/sounds', 200],
      ['/projects', 200],
      [`/projects/${project}`, 200],
      [`/projects/${project}/history`, 200],
      [`/projects/${project}/oplog`, 200],
      [`/projects/${project}/cleanup`, 200],
      [`/projects/${project}/chat`, 200],
      [`/projects/${project}/chat/live`, 200],
      ['/assets', 200],
      [`/assets?projectId=${project}`, 200],
      [`/assets/${asset}`, 200],
      [`/assets/${asset}/transcript`, 200],
      // Computed by the mock provider, served, not stored.
      [`/assets/${asset}/insights`, 200],
      // Computed by ffmpeg, served, not stored.
      [`/assets/${fresh}/waveform`, 200],
      [`/assets/${fresh}/dissect`, 200],
      [`/assets/${asset}/thumb.jpg`, 200],
      [`/assets/${asset}/proxy.mp4`, 200],
      [`/assets/${asset}/original`, 200],
      // Would write a file: refused like a write.
      [`/assets/${asset}/filmstrip.jpg`, 503],
      [`/renders/${render}`, 200],
      [`/renders/${render}/file.mp4`, 200],
      ['/style-profile', 404],
      ['/style-profiles', 200],
      ['/style/analyzer', 200],
    ];
    for (const [url, status] of reads) {
      const response = await app.inject({ method: 'GET', url, headers });
      expect({ url, status: response.statusCode, body: response.statusCode >= 500 && status !== 503 ? response.body : '' })
        .toEqual({ url, status, body: '' });
    }

    // The update gate still reaches phones with no credentials at all.
    expect((await app.inject({ method: 'GET', url: '/client-config' })).json()).toMatchObject({ minVersion: expect.any(String) });
    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(health).toMatchObject({ ok: true, readOnly: true, jobs: { renders: 1, imports: 0, media: 0 } });
    // Recovery skipped: the stranded render was not re-queued (or run).
    expect((await app.inject({ method: 'GET', url: `/renders/${queued}`, headers })).json().status).toBe('queued');

    const writes: Array<['POST' | 'PUT' | 'PATCH' | 'DELETE', string, unknown]> = [
      ['POST', '/projects', { title: 'new' }],
      ['POST', `/projects/${project}/ops`, { ops: [{ type: 'set_format', params: { format: '16:9' } }], baseVersion: 0 }],
      ['POST', `/projects/${project}/render`, { resolution: '720p' }],
      ['POST', `/projects/${project}/chat`, { message: 'hi' }],
      ['DELETE', `/projects/${project}`, undefined],
      ['PATCH', `/assets/${asset}`, { label: 'renamed' }],
      ['POST', `/assets/${asset}/transcribe`, { force: true }],
      ['POST', `/assets/${asset}/insights`, { force: true }],
      ['POST', `/assets/${asset}/dissect`, { force: true }],
      ['PUT', '/style/analyzer', { analyzer: 'ffmpeg' }],
      ['POST', '/telemetry', { kind: 'feedback' }],
      ['DELETE', '/account', undefined],
      ['POST', '/webhooks/supabase/user-deleted', { type: 'DELETE', record: { id: ALICE } }],
      // Routes only the 1.1 line has. The gate is global (any non-read method), so they are
      // refused without opting in; listing them keeps a per-route exemption from slipping in.
      ['POST', '/sync/projects', { projects: [] }],
      ['POST', `/sync/projects/${project}/changes`, { baseVersion: 0, changes: [] }],
      ['DELETE', `/sync/projects/${project}`, undefined],
      ['POST', '/agent/turn', { projectId: project, message: 'hi' }],
      ['PUT', `/assets/${asset}/original?projectId=${project}`, 'bytes'],
    ];
    for (const [method, url, payload] of writes) {
      // With and without credentials: the gate runs before auth.
      for (const auth of [headers, {}]) {
        const response = await app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
        expect({ method, url, status: response.statusCode }).toEqual({ method, url, status: 503 });
        expect(response.headers['retry-after']).toBe(String(READ_ONLY_RETRY_AFTER_SECONDS));
        expect(response.json().error).toMatch(/^Editify is updating/);
      }
    }

    await app.close();
    expect(sha256(dbPath)).toBe(before);
  });

  it('fails loudly on a writer the mode missed', () => {
    const database = createDatabase(dbPath, { readonly: true });
    try {
      expect(database.readonly).toBe(true);
      expect(() => new ProjectStore(database).create({ title: 'sneaky', format: '9:16', fps: 30 }, ALICE))
        .toThrow(expect.objectContaining({ code: 'SQLITE_READONLY' }));
    } finally {
      database.close();
    }
  });

  it('is what READ_ONLY=1 in the environment turns on', async () => {
    vi.stubEnv('READ_ONLY', '1');
    try {
      const database = createDatabase(dbPath);
      expect(database.readonly).toBe(true);
      const app = await buildApp({ database, auth: { supabaseUrl: SUPABASE, jwks } });
      expect((await app.inject({ method: 'POST', url: '/projects', headers, payload: { title: 'x' } })).statusCode).toBe(503);
      expect((await app.inject({ method: 'GET', url: '/health' })).json().readOnly).toBe(true);
      await app.close();
      // A writable handle under READ_ONLY=1 is a misconfiguration, not a quiet downgrade.
      const writable = createDatabase(':memory:', { readonly: false });
      await expect(buildApp({ database: writable })).rejects.toThrow(/read-only/);
      writable.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('changes nothing when unset', async () => {
    const database = createDatabase(':memory:');
    const app = await buildApp({ database, auth: { supabaseUrl: SUPABASE, jwks } });
    expect(database.readonly).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/projects', headers, payload: { title: 'x' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ readOnly: false, jobs: { renders: 0, imports: 0, media: 0 } });
    await app.close();
  });
});
