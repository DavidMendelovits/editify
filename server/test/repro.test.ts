import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ToolProvider } from '../src/agent/providers.js';
import { AssetStore } from '../src/db/asset-store.js';
import { ChatStore } from '../src/db/chat-store.js';
import { createDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { ReportStore } from '../src/db/report-store.js';
import { SettingsStore } from '../src/db/settings-store.js';
import { registerTelemetryRoutes } from '../src/routes/telemetry.js';
import { chooseSubstitute, ReproService, type ReproBundle } from '../src/services/repro-service.js';
import { TelemetryService } from '../src/services/telemetry-service.js';

const brokenProvider = async (): Promise<ToolProvider> => { throw new Error('no provider configured'); };

/** A server holding one real project, the way a reporter's server would. */
function serveWithProject() {
  const insightsPath = join(mkdtempSync(join(tmpdir(), 'editify-repro-')), 'user-insights.md');
  const database = createDatabase(':memory:');
  const projects = new ProjectStore(database);
  const assets = new AssetStore(database);
  const reports = new ReportStore(database);

  const asset = assets.insert({
    id: 'asset-1',
    originalName: 'deli-baby.mov',
    mimeType: 'video/quicktime',
    duration: 12,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    originalPath: '/tmp/deli-baby.mov',
    proxyPath: '/tmp/proxy.mp4',
    thumbnailPath: '/tmp/thumb.jpg',
    originalUrl: '/assets/asset-1/original',
    proxyUrl: '/assets/asset-1/proxy.mp4',
    thumbnailUrl: '/assets/asset-1/thumb.jpg',
    filmstripUrl: '/assets/asset-1/filmstrip.jpg',
    createdAt: new Date().toISOString(),
  });
  const project = projects.create({ title: 'Reel edit', format: '9:16', fps: 30 });
  projects.applyOperations(project.id, [{
    type: 'add_clip',
    params: { trackId: 'video-main', clip: { id: 'clip-1', assetId: asset.id, start: 0, in: 0, out: 6, volume: 1, speed: 1 } },
  }], 0);

  const app = Fastify();
  const telemetry = new TelemetryService(
    reports,
    brokenProvider,
    insightsPath,
    new ReproService(projects, assets, new ChatStore(database), new SettingsStore(database)),
  );
  registerTelemetryRoutes(app, telemetry);
  return { app, insightsPath, projectId: project.id, reports };
}

describe('repro bundles', () => {
  it('attaches the project, its assets and its recent ops to a report from that project', async () => {
    const { app, insightsPath, projectId, reports } = serveWithProject();

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry',
      payload: {
        sessionId: 's1',
        kind: 'feedback',
        platform: 'web',
        events: [],
        feedback: 'Let me select more than one clip.',
        context: { screen: 'editor', projectId },
      },
    });

    expect(response.statusCode).toBe(200);
    const written = readFileSync(insightsPath, 'utf8');
    expect(written).toContain('npm run repro -- --report');
    expect(written).toContain('9:16 at 30fps, 1 clip');

    const bundle = reports.getRepro(response.json().reportId) as ReproBundle;
    expect(bundle.project.id).toBe(projectId);
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.assets[0]).toMatchObject({ originalName: 'deli-baby.mov', duration: 12 });
    expect(bundle.recentOps.map((entry) => entry.operation.type)).toEqual(['add_clip']);
  });

  it('files a report with no project without a bundle rather than failing', async () => {
    const { app, reports } = serveWithProject();

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry',
      payload: {
        sessionId: 's1', kind: 'feedback', platform: 'web', events: [],
        feedback: 'The home screen is slow.', context: { screen: 'home' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(reports.getRepro(response.json().reportId)).toBeUndefined();
  });
});

describe('media substitution', () => {
  const wanted = { id: 'gone', originalName: 'missing.mov', mimeType: 'video/quicktime', duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true, status: 'ready' };
  const pool = [
    { id: 'a', originalName: 'landscape.mov', duration: 10, width: 1920, height: 1080 },
    { id: 'b', originalName: 'short-portrait.mov', duration: 4, width: 1080, height: 1920 },
    { id: 'c', originalName: 'long-portrait.mov', duration: 30, width: 1080, height: 1920 },
  ];

  it('keeps the orientation and takes the shortest clip that still covers the source', () => {
    expect(chooseSubstitute(wanted, pool)?.id).toBe('c');
  });

  it('prefers the same media when this machine already has it', () => {
    expect(chooseSubstitute({ ...wanted, originalName: 'landscape.mov' }, pool)?.id).toBe('a');
  });

  it('falls back to the nearest duration when nothing matches the orientation', () => {
    expect(chooseSubstitute(wanted, [pool[0]!])?.id).toBe('a');
  });
});
