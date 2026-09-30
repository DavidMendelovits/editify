import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { ChatStore } from '../src/db/chat-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';

/**
 * Every route that takes an id, called by Bob with Alice's ids: each must
 * answer as if the thing does not exist. Alice, calling the same table, gets
 * through. A new `:id` route belongs in this table.
 */
const SUPABASE = 'https://isolation.supabase.test';
const ALICE = 'alice-0000';
const BOB = 'bob-0000';
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'EDITIFY_TOKEN', 'GEMINI_API_KEY'] as const;

let app: FastifyInstance;
let database: EditifyDatabase;
const saved: Record<string, string | undefined> = {};
const auth: Record<string, { authorization: string }> = {};
const ids = { project: '', bobProject: '', asset: 'alice-clip', render: '', style: '', sound: 'sound-whoosh-soft' };

async function sign(privateKey: CryptoKey, subject: string): Promise<string> {
  return await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'isolation' })
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), alg: 'ES256', kid: 'isolation', use: 'sig' }] });
  auth[ALICE] = { authorization: `Bearer ${await sign(privateKey, ALICE)}` };
  auth[BOB] = { authorization: `Bearer ${await sign(privateKey, BOB)}` };

  database = createDatabase(':memory:');
  app = await buildApp({ database, auth: { supabaseUrl: SUPABASE, jwks } });

  // Alice's project over HTTP, so ownership comes from her token.
  ids.project = (await app.inject({ method: 'POST', url: '/projects', headers: auth[ALICE] ?? {}, payload: { title: 'Alice' } })).json().id;
  ids.bobProject = (await app.inject({ method: 'POST', url: '/projects', headers: auth[BOB] ?? {}, payload: { title: 'Bob' } })).json().id;

  // Her media, with real files so the file routes can answer her without ffmpeg.
  const dir = mkdtempSync(join(tmpdir(), 'editify-isolation-'));
  const media = join(dir, 'media');
  mkdirSync(media);
  for (const name of ['original.mp4', 'proxy.mp4', 'filmstrip.jpg', 'out.mp4', 'contact.jpg']) writeFileSync(join(media, name), 'x');
  const assets = new AssetStore(database);
  const row = (id: string) => ({
    id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 4, width: 1080, height: 1920, fps: 30, hasAudio: true,
    // thumbnail = original skips the colour-pipeline re-shoot, as for an image asset.
    originalPath: join(media, 'original.mp4'), proxyPath: join(media, 'proxy.mp4'), thumbnailPath: join(media, 'original.mp4'),
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
  });
  assets.insert(row(ids.asset), ALICE);
  assets.link(ids.project, ids.asset);
  assets.insert(row(ids.sound));
  assets.insert(row('pre-auth-clip'));
  new TranscriptStore(database).put(ids.asset, {
    language: 'en', durationProcessedSeconds: 4, words: [{ w: 'hi', s: 0, e: 0.5 }], segments: [{ s: 0, e: 0.5, text: 'hi' }],
  }, { cellSeconds: 0.05, rmsDb: [-20, -18] });
  new InsightStore(database).put({ assetId: ids.asset, hook: null, highlights: [], summary: 'seeded', generatedAt: new Date(0).toISOString() });
  database.prepare('INSERT INTO dissections (asset_id, dissection_json, created_at) VALUES (?, ?, ?)').run(ids.asset, JSON.stringify({
    assetId: ids.asset, duration: 4, cuts: [], averageShotLength: 4, cutDensity: 0, tempoBpm: 120, loudnessLufs: -14,
    energy: { cellSeconds: 0.25, rmsDb: [] }, energyPeaks: [], overlayActivity: [], summary: 'seeded', generatedAt: new Date(0).toISOString(),
  }), new Date(0).toISOString());

  const renders = new RenderStore(database);
  ids.render = renders.create(ids.project, '720p').id;
  renders.update(ids.render, 'done', { outputPath: join(media, 'out.mp4') });
  new ChatStore(database).add(ids.project, 'user', 'cut the intro');
  ids.style = 'alice-style';
  database.prepare(`
    INSERT INTO style_profiles (id, name, asset_ids_json, metrics_json, style_doc, created_at, user_id)
    VALUES (?, 'Hers', ?, '[]', 'doc', ?, ?)
  `).run(ids.style, JSON.stringify([ids.asset]), new Date(0).toISOString(), ALICE);
});

afterAll(async () => {
  await app.close();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** [method, url, body, what Alice gets]. Built lazily: the ids exist only after beforeAll. */
function routes(): Array<[Method, string, unknown, number]> {
  const { project, asset, render, style } = ids;
  return [
    ['GET', `/projects/${project}`, undefined, 200],
    ['POST', `/projects/${project}/ops`, { ops: [{ type: 'set_format', params: { format: '16:9' } }], baseVersion: 0 }, 200],
    ['POST', `/projects/${project}/runs/no-such-run/revert`, undefined, 409],
    ['GET', `/projects/${project}/history`, undefined, 200],
    ['GET', `/projects/${project}/oplog`, undefined, 200],
    ['GET', `/projects/${project}/cleanup`, undefined, 200],
    ['GET', `/projects/${project}/sync?audioClipId=nope`, undefined, 200],
    ['GET', `/projects/${project}/chat`, undefined, 200],
    ['GET', `/projects/${project}/chat/live`, undefined, 200],
    ['POST', `/projects/${project}/chat/improve`, { message: 'make it punchy' }, 200],
    ['GET', `/assets?projectId=${project}`, undefined, 200],
    ['GET', `/assets/${asset}`, undefined, 200],
    ['PATCH', `/assets/${asset}`, { label: 'Take 1' }, 200],
    ['POST', `/assets/${asset}/link`, { projectId: project }, 200],
    ['GET', `/assets/${asset}/transcript`, undefined, 200],
    ['POST', `/assets/${asset}/transcribe`, {}, 200],
    ['GET', `/assets/${asset}/insights`, undefined, 200],
    ['POST', `/assets/${asset}/insights`, {}, 200],
    ['GET', `/assets/${asset}/dissect`, undefined, 200],
    ['POST', `/assets/${asset}/dissect`, {}, 200],
    ['GET', `/assets/${asset}/waveform`, undefined, 200],
    ['GET', `/assets/${asset}/proxy.mp4`, undefined, 200],
    ['GET', `/assets/${asset}/thumb.jpg`, undefined, 200],
    ['GET', `/assets/${asset}/filmstrip.jpg`, undefined, 200],
    ['GET', `/assets/${asset}/original`, undefined, 200],
    ['GET', `/renders/${render}`, undefined, 200],
    ['GET', `/renders/${render}/file.mp4`, undefined, 200],
    ['GET', `/renders/${render}/contact.jpg`, undefined, 200],
    ['POST', '/style-profile/analyze', { assetIds: [asset] }, 202],
    ['POST', `/style-profiles/${style}/select`, undefined, 200],
    ['PATCH', `/style-profiles/${style}`, { name: 'Still hers' }, 200],
    ['POST', `/style-profiles/${style}/duplicate`, undefined, 201],
    ['DELETE', `/style-profiles/${style}`, undefined, 200],
    ['DELETE', `/projects/${project}`, undefined, 204],
  ];
}

async function call(user: string, method: Method, url: string, payload?: unknown) {
  return await app.inject({ method, url, headers: auth[user] ?? {}, ...(payload === undefined ? {} : { payload: payload as object }) });
}

describe('route isolation between two signed-in users', () => {
  it('answers Bob 404 on every route that takes one of Alice\'s ids', async () => {
    const leaks: string[] = [];
    for (const [method, url, payload] of routes()) {
      const response = await call(BOB, method, url, payload);
      if (response.statusCode !== 404) leaks.push(`${method} ${url} -> ${response.statusCode}`);
    }
    // Chat and render do real work for the owner, so only the refusal is swept.
    for (const [method, url] of [['POST', `/projects/${ids.project}/chat`], ['POST', `/projects/${ids.project}/render`]] as const) {
      const response = await call(BOB, method, url, url.endsWith('/chat') ? { message: 'hi' } : {});
      if (response.statusCode !== 404) leaks.push(`${method} ${url} -> ${response.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it('keeps Alice\'s rows out of Bob\'s lists', async () => {
    expect((await call(BOB, 'GET', '/projects')).json().map((project: { id: string }) => project.id)).toEqual([ids.bobProject]);
    // Bob sees the sound library and nothing else: not Alice's clip, not pre-auth media.
    expect((await call(BOB, 'GET', '/assets')).json().map((asset: { id: string }) => asset.id)).toEqual([ids.sound]);
    expect((await call(BOB, 'GET', '/style-profiles')).json()).toEqual({ profiles: [], selectedId: null });
    expect((await call(BOB, 'GET', '/style-profile')).statusCode).toBe(404);
  });

  it('refuses Bob\'s edits that reach for Alice\'s asset', async () => {
    const add = await call(BOB, 'POST', `/projects/${ids.bobProject}/ops`, {
      ops: [{ type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'stolen', assetId: ids.asset, start: 0, in: 0, out: 4 } } }],
      baseVersion: 0,
    });
    expect(add.statusCode).toBe(403);
    expect((await call(BOB, 'POST', `/assets/${ids.asset}/link`, { projectId: ids.bobProject })).statusCode).toBe(404);
    // Still version 0: nothing landed.
    expect((await call(BOB, 'GET', `/projects/${ids.bobProject}`)).json().version).toBe(0);
  });

  it('lets Bob use the sound library but not rename it, and closes the server import folder', async () => {
    expect((await call(BOB, 'GET', `/assets/${ids.sound}`)).statusCode).toBe(200);
    expect((await call(BOB, 'PATCH', `/assets/${ids.sound}`, { label: 'mine now' })).statusCode).toBe(404);
    const add = await call(BOB, 'POST', `/projects/${ids.bobProject}/ops`, {
      ops: [{ type: 'add_clip', params: { trackId: 'audio-main', clip: { id: 'sfx', assetId: ids.sound, start: 0, in: 0, out: 1 } } }],
      baseVersion: 0,
    });
    expect(add.statusCode).toBe(200);
    expect((await call(BOB, 'GET', '/assets/importable')).statusCode).toBe(403);
    expect((await call(BOB, 'POST', '/assets/import', { name: 'anything.mp4' })).statusCode).toBe(403);
  });

  it('keeps the analyzer choice per user', async () => {
    expect((await call(ALICE, 'PUT', '/style/analyzer', { analyzer: 'ffmpeg' })).statusCode).toBe(200);
    const keys = (database.prepare('SELECT key FROM settings').all() as Array<{ key: string }>).map((row) => row.key);
    expect(keys).toEqual([`style.analyzer:${ALICE}`]);
  });

  it('lets Alice through the same table', async () => {
    const wrong: string[] = [];
    for (const [method, url, payload, expected] of routes()) {
      const response = await call(ALICE, method, url, payload);
      if (response.statusCode !== expected) wrong.push(`${method} ${url} -> ${response.statusCode} ${response.body.slice(0, 120)}`);
    }
    expect(wrong).toEqual([]);
  });
});
