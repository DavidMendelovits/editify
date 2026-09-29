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
import { anonymizeName, chooseSubstitute, ReproService, type ReproBundle } from '../src/services/repro-service.js';
import { TelemetryService } from '../src/services/telemetry-service.js';

const brokenProvider = async (): Promise<ToolProvider> => { throw new Error('no provider configured'); };

const REPORTER = 'user-1';

/** A server holding one real project, the way a reporter's server would. */
function serveWithProject() {
  const insightsPath = join(mkdtempSync(join(tmpdir(), 'editify-repro-')), 'user-insights.md');
  const database = createDatabase(':memory:');
  const projects = new ProjectStore(database);
  const assets = new AssetStore(database);
  const reports = new ReportStore(database);

  const asset = assets.insert({
    id: 'asset-1',
    originalName: 'uncle-dave-wedding-speech.mov',
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
  }, REPORTER);
  const project = projects.create({ title: "Dad's 70th", format: '9:16', fps: 30 }, REPORTER);
  assets.link(project.id, asset.id);
  projects.applyOperations(project.id, [{
    type: 'add_clip',
    params: { trackId: 'video-main', clip: { id: 'clip-1', assetId: asset.id, start: 0, in: 0, out: 6, volume: 1, speed: 1 } },
  }], 0);
  projects.applyOperations(project.id, [{
    type: 'add_caption',
    params: {
      trackId: 'captions',
      clip: {
        id: 'cap-1', start: 0, in: 0, out: 3, text: 'thanks for coming everyone',
        // Karaoke timing: the same speech again, one word at a time.
        style: {
          font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold',
          words: [{ w: 'thanks', s: 0, e: 0.4 }, { w: 'for', s: 0.4, e: 0.6 }, { w: 'coming', s: 0.6, e: 1 }],
        },
      },
    },
  }], 1);

  const app = Fastify();
  // Stands in for the auth hook: POST /telemetry resolves a token when one is
  // offered, and the bundle is scoped to whoever that turns out to be.
  app.addHook('onRequest', async (request) => {
    if (request.headers.authorization === `Bearer ${REPORTER}`) request.userId = REPORTER;
  });
  const telemetry = new TelemetryService(
    reports,
    brokenProvider,
    insightsPath,
    new ReproService(projects, assets, new ChatStore(database), new SettingsStore(database)),
  );
  registerTelemetryRoutes(app, telemetry);
  return { app, insightsPath, projectId: project.id, reports, projects, database };
}

describe('repro bundles', () => {
  it('attaches the project, its assets and its recent ops to a report from that project', async () => {
    const { app, insightsPath, projectId, reports } = serveWithProject();

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry',
      headers: { authorization: `Bearer ${REPORTER}` },
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
    expect(written).toContain('9:16 at 30fps, 2 clips');

    const bundle = reports.getRepro(response.json().reportId) as ReproBundle;
    expect(bundle.project.id).toBe(projectId);
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.recentOps.map((entry) => entry.operation.type)).toEqual(['add_clip', 'add_caption']);
    // The shape a repro needs is all there.
    expect(bundle.assets[0]).toMatchObject({ duration: 12, width: 1080, height: 1920, fps: 30 });
  });

  it('carries no footage, filename, title or caption wording out of the server', async () => {
    const { app, projectId, reports } = serveWithProject();

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry',
      headers: { authorization: `Bearer ${REPORTER}` },
      payload: {
        sessionId: 's1', kind: 'feedback', platform: 'web', events: [],
        feedback: 'Captions overflow.', context: { screen: 'editor', projectId },
      },
    });

    const bundle = reports.getRepro(response.json().reportId) as ReproBundle;
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('uncle-dave');
    expect(serialized).not.toContain("Dad's 70th");
    expect(serialized).not.toContain('thanks for coming');
    // Masked, not dropped: a caption bug about wrapping still reproduces.
    const caption = bundle.project.tracks.flatMap((track) => track.clips).find((clip) => clip.text);
    expect(caption?.text).toBe('xxxxxx xxx xxxxxx xxxxxxxx');
    expect(bundle.assets[0]?.originalName).toMatch(/^clip-[0-9a-f]{8}\.mov$/);
    // Karaoke timing carries the transcript one word at a time; the timings
    // stay, the words do not.
    expect(caption?.style?.words?.map((word) => word.w)).toEqual(['xxxxxx', 'xxx', 'xxxxxx']);
    expect(caption?.style?.words?.[0]).toMatchObject({ s: 0, e: 0.4 });
  });

  it('leaves out an asset the reporter does not own, even from their own timeline', async () => {
    const { app, database, projects, projectId, reports } = serveWithProject();

    // Someone else's upload, referenced from a clip in the reporter's project:
    // the doc is theirs, the asset row is not.
    new AssetStore(database).insert({
      id: 'theirs', originalName: 'not-mine.mov', mimeType: 'video/quicktime', duration: 5,
      width: 1080, height: 1920, fps: 30, hasAudio: true, originalPath: '/x', proxyPath: '/p', thumbnailPath: '/t',
      originalUrl: '/assets/theirs/original', proxyUrl: '/assets/theirs/proxy.mp4',
      thumbnailUrl: '/assets/theirs/thumb.jpg', filmstripUrl: '/assets/theirs/filmstrip.jpg',
      createdAt: new Date().toISOString(),
    }, 'someone-else');
    // Linked the way pre-scoping data could be: the grant lets the clip in, the
    // bundle still has to check the owner.
    new AssetStore(database).link(projectId, 'theirs');
    const current = projects.get(projectId)!;
    projects.applyOperations(projectId, [{
      type: 'add_clip',
      params: { trackId: 'video-main', clip: { id: 'clip-2', assetId: 'theirs', start: 20, in: 0, out: 4, volume: 1, speed: 1 } },
    }], current.version);

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry',
      headers: { authorization: `Bearer ${REPORTER}` },
      payload: {
        sessionId: 's4', kind: 'feedback', platform: 'web', events: [],
        feedback: 'anything', context: { screen: 'editor', projectId },
      },
    });

    const bundle = reports.getRepro(response.json().reportId) as ReproBundle;
    expect(bundle.assets.map((asset) => asset.id)).toEqual(['asset-1']);
  });

  it('will not attach a project the reporter does not own', async () => {
    const { app, projectId, reports } = serveWithProject();

    // Same project id, a different signed-in user: the lookup is scoped, so
    // there is nothing to attach and nothing to leak.
    const response = await app.inject({
      method: 'POST',
      url: '/telemetry',
      headers: { authorization: 'Bearer someone-else' },
      payload: {
        sessionId: 's2', kind: 'feedback', platform: 'web', events: [],
        feedback: 'give me their timeline', context: { screen: 'editor', projectId },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(reports.getRepro(response.json().reportId)).toBeUndefined();
  });

  it('attaches nothing to an unauthenticated report, such as a crash on sign-in', async () => {
    const { app, projectId, reports } = serveWithProject();

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry',
      payload: {
        sessionId: 's3', kind: 'error', platform: 'web', events: [],
        error: { message: 'sign-in blew up' }, context: { screen: 'editor', projectId },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(reports.getRepro(response.json().reportId)).toBeUndefined();
  });

  it('files a report with no project without a bundle rather than failing', async () => {
    const { app, reports } = serveWithProject();

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry',
      headers: { authorization: `Bearer ${REPORTER}` },
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
    expect(chooseSubstitute({ ...wanted, originalName: anonymizeName('landscape.mov') }, pool)?.id).toBe('a');
  });

  it('falls back to the nearest duration when nothing matches the orientation', () => {
    expect(chooseSubstitute(wanted, [pool[0]!])?.id).toBe('a');
  });
});
