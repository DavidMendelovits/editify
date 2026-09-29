import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AgentService } from '../src/agent/service.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { registerStyleRoutes } from '../src/routes/style.js';
import { StyleService } from '../src/services/style-service.js';
import { SettingsStore } from '../src/db/settings-store.js';
import { ffmpegAnalyzer } from '../src/style/analyzers/ffmpeg.js';
import { StyleAnalyzerRegistry } from '../src/style/registry.js';
import { deleteUserData } from '../src/services/account-service.js';

// Holds the ffmpeg scan open so the 'processing' window is observable.
const scan = vi.hoisted(() => {
  let open = () => {};
  return {
    gate: Promise.resolve(),
    hold() { this.gate = new Promise<void>((resolve) => { open = resolve; }); },
    release() { open(); this.gate = Promise.resolve(); },
  };
});

vi.mock('../src/media/process.js', () => ({
  analyzeScenes: async (path: string) => {
    await scan.gate;
    if (path === '/boom.mp4') throw new Error('ffmpeg exploded');
    return { cutCount: 2, cutDensity: 0.5, averageShotLength: 2 };
  },
  analyzeLoudness: async () => -14,
}));

const agent = { distillStyle: async () => 'fast-punch pacing' } as unknown as AgentService;

// ffmpeg only, and an empty env: otherwise a real GEMINI_API_KEY on the machine
// (or in .env.local) makes these tests upload the fake asset paths to Gemini.
function styleService(database: EditifyDatabase, assets: AssetStore): StyleService {
  const analyzers = new StyleAnalyzerRegistry(new SettingsStore(database), [ffmpegAnalyzer], {});
  return new StyleService(database, assets, agent, analyzers);
}

function buildStyleApp(database: EditifyDatabase, originalPath = '/fine.mp4') {
  const assets = new AssetStore(database);
  assets.insert({
    id: 'a1', originalName: 'a1.mp4', mimeType: 'video/mp4', duration: 6,
    width: 1080, height: 1920, fps: 30, hasAudio: true,
    originalPath, proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
  });
  const app = Fastify();
  registerStyleRoutes(app, styleService(database, assets));
  return app;
}

describe('style profile analysis', () => {
  let database: EditifyDatabase;
  beforeEach(() => { database = createDatabase(':memory:'); });
  afterEach(() => { scan.release(); database.close(); });

  it('answers 202 while the scan runs, ignores a rival run, and lands the profile', async () => {
    scan.hold();
    const app = buildStyleApp(database);

    const started = await app.inject({ method: 'POST', url: '/style-profile/analyze', payload: { assetIds: ['a1'] } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ status: 'processing' });

    const pending = await app.inject({ method: 'GET', url: '/style-profile' });
    expect(pending.statusCode).toBe(404);
    expect(pending.json()).toMatchObject({ status: 'processing' });

    // A second tap joins the live run rather than starting a rival scan.
    const again = await app.inject({ method: 'POST', url: '/style-profile/analyze', payload: { assetIds: ['a1'] } });
    expect(again.statusCode).toBe(202);

    scan.release();
    await vi.waitFor(async () => {
      const done = await app.inject({ method: 'GET', url: '/style-profile' });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({
        assetIds: ['a1'], styleDoc: 'fast-punch pacing', status: 'idle', analyzer: 'ffmpeg',
        template: { videoCount: 1, watchedCount: 0, pacing: { averageShotSeconds: 2, rhythm: 'balanced' } },
      });
      expect(done.json().observations).toHaveLength(1);
      expect(done.json().observations[0]).toMatchObject({ assetId: 'a1', analyzer: 'ffmpeg', watched: false, format: '9:16' });
    });
    const rows = database.prepare('SELECT COUNT(*) AS count FROM style_profiles').get() as { count: number };
    expect(rows.count).toBe(1);
    await app.close();
  });

  it('rejects unknown asset ids and analyzers before starting any work', async () => {
    const app = buildStyleApp(database);
    const response = await app.inject({ method: 'POST', url: '/style-profile/analyze', payload: { assetIds: ['a1', 'nope'] } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Asset nope was not found' });
    const unknownAnalyzer = await app.inject({ method: 'POST', url: '/style-profile/analyze', payload: { assetIds: ['a1'], analyzer: 'sora' } });
    expect(unknownAnalyzer.statusCode).toBe(404);
    expect(unknownAnalyzer.json()).toMatchObject({ error: 'Analyzer sora was not found' });
    expect((await app.inject({ method: 'GET', url: '/style-profile' })).json()).toMatchObject({ status: 'idle' });
    await app.close();
  });

  it('lists, selects, renames, duplicates, and repoints on delete', async () => {
    const app = buildStyleApp(database);
    const styles = styleService(database, new AssetStore(database));
    const first = await styles.analyze(['a1'], { name: 'Punchy' });
    const second = await styles.analyze(['a1']);

    // Newest first, and the freshest analysis is the selected one.
    const listed = await app.inject({ method: 'GET', url: '/style-profiles' });
    expect(listed.json().profiles.map((profile: { name: string }) => profile.name)).toEqual(['Style 2', 'Punchy']);
    expect(listed.json().selectedId).toBe(second.id);
    expect((await app.inject({ method: 'GET', url: '/style-profile' })).json()).toMatchObject({ id: second.id });

    // Selecting round-trips through GET /style-profile.
    expect((await app.inject({ method: 'POST', url: `/style-profiles/${first.id}/select` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/style-profile' })).json()).toMatchObject({ id: first.id, name: 'Punchy' });

    const renamed = await app.inject({ method: 'PATCH', url: `/style-profiles/${first.id}`, payload: { name: 'Slow burn' } });
    expect(renamed.json()).toMatchObject({ id: first.id, name: 'Slow burn' });

    // A duplicate copies the measurements but does not steal the selection.
    const copy = await app.inject({ method: 'POST', url: `/style-profiles/${first.id}/duplicate` });
    expect(copy.statusCode).toBe(201);
    expect(copy.json()).toMatchObject({ name: 'Slow burn copy', styleDoc: first.styleDoc, assetIds: ['a1'] });
    expect(copy.json().id).not.toBe(first.id);
    expect((await app.inject({ method: 'GET', url: '/style-profiles' })).json().selectedId).toBe(first.id);

    // Deleting the selected profile repoints the setting at what is left.
    const removed = await app.inject({ method: 'DELETE', url: `/style-profiles/${first.id}` });
    expect(removed.json().selectedId).toBe(copy.json().id);
    expect((await app.inject({ method: 'GET', url: '/style-profile' })).json()).toMatchObject({ id: copy.json().id });
    await app.close();
  });

  it('hand-edits the style doc via PATCH and rejects an empty one', async () => {
    const app = buildStyleApp(database);
    const profile = await styleService(database, new AssetStore(database)).analyze(['a1'], { name: 'Punchy' });

    const edited = await app.inject({ method: 'PATCH', url: `/style-profiles/${profile.id}`, payload: { styleDoc: '  - Never use jump cuts\n- Captions bottom third  ' } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: profile.id, name: 'Punchy', styleDoc: '- Never use jump cuts\n- Captions bottom third' });
    expect((await app.inject({ method: 'GET', url: '/style-profile' })).json()).toMatchObject({ styleDoc: '- Never use jump cuts\n- Captions bottom third' });

    for (const payload of [{ styleDoc: '   ' }, {}]) {
      const rejected = await app.inject({ method: 'PATCH', url: `/style-profiles/${profile.id}`, payload });
      expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect((await app.inject({ method: 'GET', url: '/style-profile' })).json()).toMatchObject({ styleDoc: '- Never use jump cuts\n- Captions bottom third' });
    await app.close();
  });

  it('404s every style-profile action on an unknown id', async () => {
    const app = buildStyleApp(database);
    for (const [method, url] of [
      ['POST', '/style-profiles/nope/select'], ['POST', '/style-profiles/nope/duplicate'], ['DELETE', '/style-profiles/nope'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(404);
    }
    const renamed = await app.inject({ method: 'PATCH', url: '/style-profiles/nope', payload: { name: 'x' } });
    expect(renamed.statusCode).toBe(404);
    await app.close();
  });

  it('captures a background failure instead of crashing the process', async () => {
    const app = buildStyleApp(database, '/boom.mp4');
    expect((await app.inject({ method: 'POST', url: '/style-profile/analyze', payload: { assetIds: ['a1'] } })).statusCode).toBe(202);
    await vi.waitFor(async () => {
      expect((await app.inject({ method: 'GET', url: '/style-profile' })).json())
        .toMatchObject({ status: 'error', error: 'ffmpeg exploded' });
    });
    await app.close();
  });
});

describe('style profiles per user', () => {
  let database: EditifyDatabase;
  let styles: StyleService;
  beforeEach(() => {
    database = createDatabase(':memory:');
    const assets = new AssetStore(database);
    for (const [id, owner] of [['alice-clip', 'alice'], ['bob-clip', 'bob']] as const) {
      assets.insert({
        id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 6, width: 1080, height: 1920, fps: 30, hasAudio: true,
        originalPath: '/fine.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
        originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
      }, owner);
    }
    styles = styleService(database, assets);
  });
  afterEach(() => { scan.release(); database.close(); });

  /** Stands in for the auth hook: `x-user` becomes request.userId. */
  function serve() {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      const user = request.headers['x-user'];
      if (typeof user === 'string') request.userId = user;
    });
    registerStyleRoutes(app, styles);
    return app;
  }

  it('runs each user\'s analysis on its own, and each lands only in its owner\'s list', async () => {
    scan.hold();
    const alice = styles.start(['alice-clip'], {}, 'alice');
    // Bob does not join Alice's run; the same user still does.
    expect(styles.start(['bob-clip'], {}, 'bob')).toEqual({ status: 'processing' });
    expect(styles.start(['alice-clip'], { name: 'ignored' }, 'alice')).toEqual(alice);
    expect(styles.state('carol')).toEqual({ status: 'idle' });
    scan.release();
    await vi.waitFor(() => {
      expect(styles.state('alice').status).toBe('idle');
      expect(styles.state('bob').status).toBe('idle');
    });
    expect(styles.list('alice').map((profile) => profile.assetIds)).toEqual([['alice-clip']]);
    expect(styles.list('bob').map((profile) => profile.assetIds)).toEqual([['bob-clip']]);
    expect(styles.selected('alice')?.id).not.toBe(styles.selected('bob')?.id);
    expect(styles.list('carol')).toEqual([]);
    expect(styles.selected('carol')).toBeUndefined();
  });

  it('keeps selection per user and 404s another user\'s profile or asset', async () => {
    const mine = await styles.analyze(['alice-clip'], { name: 'Mine' }, 'alice');
    const older = await styles.analyze(['alice-clip'], { name: 'Older' }, 'alice');
    const theirs = await styles.analyze(['bob-clip'], { name: 'Theirs' }, 'bob');
    expect(styles.select(mine.id, 'alice')?.id).toBe(mine.id);
    expect(styles.selectedId('alice')).toBe(mine.id);
    expect(styles.selectedId('bob')).toBe(theirs.id);
    expect(styles.missingAsset(['alice-clip', 'bob-clip'], 'alice')).toBe('bob-clip');
    expect(older.name).toBe('Older');

    const app = serve();
    const asBob = { 'x-user': 'bob' };
    expect((await app.inject({ method: 'POST', url: '/style-profile/analyze', headers: asBob, payload: { assetIds: ['alice-clip'] } })).statusCode).toBe(404);
    for (const [method, url] of [
      ['POST', `/style-profiles/${mine.id}/select`], ['POST', `/style-profiles/${mine.id}/duplicate`], ['DELETE', `/style-profiles/${mine.id}`],
    ] as const) {
      expect((await app.inject({ method, url, headers: asBob })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'PATCH', url: `/style-profiles/${mine.id}`, headers: asBob, payload: { name: 'x' } })).statusCode).toBe(404);
    const bobsList = (await app.inject({ method: 'GET', url: '/style-profiles', headers: asBob })).json();
    expect(bobsList).toEqual({ profiles: [expect.objectContaining({ id: theirs.id })], selectedId: theirs.id });
    expect(styles.get(mine.id, 'alice')?.name).toBe('Mine');
    await app.close();
  });

  it('keeps nothing from a run still going when the account is deleted', async () => {
    scan.hold();
    styles.start(['alice-clip'], {}, 'alice');
    await deleteUserData(database, 'alice', styles);
    expect(styles.state('alice')).toEqual({ status: 'idle' });
    scan.release();
    // The run finishes in the background; give it every chance to (wrongly) save.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(styles.list('alice')).toEqual([]);
    expect(styles.state('alice')).toEqual({ status: 'idle' });
    expect(database.prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE '%:alice'").get()).toEqual({ count: 0 });
  });
});

describe('empty JSON bodies', () => {
  // The client sets Content-Type: application/json on every call; fastify's
  // default parser 500s when such a request carries no body, which broke
  // POST /style-profiles/:id/select from the app.
  it('reads a bodyless application/json request as {}', async () => {
    const app = await buildApp({ database: createDatabase(':memory:') });
    const response = await app.inject({
      method: 'DELETE', url: '/style-profiles/nope', headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
