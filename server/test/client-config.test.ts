import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { DEFAULT_MIN_OS, DEFAULT_STORE_URL, readClientConfig } from '../src/routes/client-config.js';

const SUPABASE = 'https://client-config.supabase.test';
const ENV_KEYS = ['MIN_APP_VERSION', 'LATEST_APP_VERSION', 'APP_STORE_URL', 'MIN_IOS_VERSION', 'EDITIFY_TOKEN'] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;
let database: EditifyDatabase;
let alice = '';

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), alg: 'ES256', kid: 'cc', use: 'sig' }] });
  alice = await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'cc' })
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setSubject('alice')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  database = createDatabase(':memory:');
  app = await buildApp({ database, auth: { supabaseUrl: SUPABASE, jwks } });
});

afterAll(async () => {
  await app.close();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('GET /client-config', () => {
  it('answers without credentials, briefly cacheable, with the 1.0 defaults', async () => {
    const response = await app.inject({ method: 'GET', url: '/client-config' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.json()).toEqual({ minVersion: '1.0.0', latestVersion: '1.0.0', storeUrl: DEFAULT_STORE_URL, minOs: '18.0' });
    expect(DEFAULT_MIN_OS).toBe('18.0');
  });

  it('reads the floor from the environment at request time, so a secret change needs no deploy', async () => {
    process.env.MIN_APP_VERSION = '1.1.0';
    process.env.MIN_IOS_VERSION = '19';
    try {
      const body = (await app.inject({ method: 'GET', url: '/client-config' })).json();
      expect(body).toEqual({ minVersion: '1.1.0', latestVersion: '1.1.0', storeUrl: DEFAULT_STORE_URL, minOs: '19' });
    } finally {
      delete process.env.MIN_APP_VERSION;
      delete process.env.MIN_IOS_VERSION;
    }
  });

  it('falls back to the default on a malformed version instead of shipping it', () => {
    const warnings: string[] = [];
    const config = readClientConfig({ MIN_APP_VERSION: 'one point one', LATEST_APP_VERSION: '1.2.0', MIN_IOS_VERSION: 'x' }, (message) => warnings.push(message));
    expect(config).toEqual({ minVersion: '1.0.0', latestVersion: '1.2.0', storeUrl: DEFAULT_STORE_URL, minOs: DEFAULT_MIN_OS });
    expect(warnings).toHaveLength(2);
  });

  it('never ships a store URL the client would reject (which would un-gate everyone)', () => {
    for (const bad of ['itms-apps://apps.apple.com/app/id1', 'apps.apple.com/app/id1', 'javascript:alert(1)', 'https://has space']) {
      const warnings: string[] = [];
      const config = readClientConfig({ MIN_APP_VERSION: '1.1.0', APP_STORE_URL: bad }, (message) => warnings.push(message));
      expect(config.storeUrl).toBe(DEFAULT_STORE_URL);
      expect(config.minVersion).toBe('1.1.0');
      expect(warnings).toEqual([expect.stringContaining('APP_STORE_URL')]);
    }
    const custom = 'https://apps.apple.com/us/app/editify/id6814607865';
    expect(readClientConfig({ APP_STORE_URL: ` ${custom} ` }, () => { throw new Error('no warning expected'); }).storeUrl).toBe(custom);
  });

  it('always sends minOs, so the client never has to assume the floor', () => {
    expect(readClientConfig({}).minOs).toBe('18.0');
    expect(readClientConfig({ MIN_IOS_VERSION: ' ' }).minOs).toBe('18.0');
    expect(readClientConfig({ MIN_IOS_VERSION: '19.2' }).minOs).toBe('19.2');
  });

  it('says testServer only while TEST_SERVER=1 (editify-v11 before cutover), and omits it otherwise', () => {
    expect(readClientConfig({ TEST_SERVER: '1' }).testServer).toBe(true);
    expect(readClientConfig({ TEST_SERVER: ' 1 ' }).testServer).toBe(true);
    for (const off of [{}, { TEST_SERVER: '0' }, { TEST_SERVER: '' }, { TEST_SERVER: 'true' }]) {
      expect(readClientConfig(off)).not.toHaveProperty('testServer');
    }
  });
});

describe('GET /renders', () => {
  it("lists the newest finished master of each of the caller's projects, and only theirs", async () => {
    const projects = new ProjectStore(database);
    const renders = new RenderStore(database);
    const mine = projects.create({ title: 'mine', format: '9:16', fps: 30 }, 'alice');
    const other = projects.create({ title: 'other', format: '9:16', fps: 30 }, 'bob');
    const older = renders.create(mine.id, '1080p');
    renders.update(older.id, 'done', { outputPath: '/data/renders/older.mp4' });
    await new Promise((done) => setTimeout(done, 5));
    const newer = renders.create(mine.id, '1080p');
    renders.update(newer.id, 'done', { outputPath: '/data/renders/newer.mp4' });
    renders.create(mine.id, '1080p');
    const foreign = renders.create(other.id, '1080p');
    renders.update(foreign.id, 'done', { outputPath: '/data/renders/foreign.mp4' });

    const response = await app.inject({ method: 'GET', url: '/renders', headers: { authorization: `Bearer ${alice}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((render: { id: string }) => render.id)).toEqual([newer.id]);
    expect((await app.inject({ method: 'GET', url: '/renders' })).statusCode).toBe(401);
  });
});
