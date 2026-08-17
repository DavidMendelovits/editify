import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../src/agent/service.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { registerStyleRoutes } from '../src/routes/style.js';
import { StyleService } from '../src/services/style-service.js';

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

function buildStyleApp(database: EditifyDatabase, originalPath = '/fine.mp4') {
  const assets = new AssetStore(database);
  assets.insert({
    id: 'a1', originalName: 'a1.mp4', mimeType: 'video/mp4', duration: 6,
    width: 1080, height: 1920, fps: 30, hasAudio: true,
    originalPath, proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
  });
  const app = Fastify();
  registerStyleRoutes(app, new StyleService(database, assets, agent));
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
      expect(done.json()).toMatchObject({ assetIds: ['a1'], styleDoc: 'fast-punch pacing', status: 'idle' });
    });
    const rows = database.prepare('SELECT COUNT(*) AS count FROM style_profiles').get() as { count: number };
    expect(rows.count).toBe(1);
    await app.close();
  });

  it('rejects unknown asset ids before starting any work', async () => {
    const app = buildStyleApp(database);
    const response = await app.inject({ method: 'POST', url: '/style-profile/analyze', payload: { assetIds: ['a1', 'nope'] } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Asset nope was not found' });
    expect((await app.inject({ method: 'GET', url: '/style-profile' })).json()).toMatchObject({ status: 'idle' });
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
