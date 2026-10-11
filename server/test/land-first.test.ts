import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { buildApp } from '../src/app.js';
import { assetsRoot } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';

/*
 * Land first: the phone registers a clip it measured itself (POST /assets/register), puts it
 * on the timeline, and sends the original afterwards (PUT /assets/:id/original). Until then
 * everything that reads the original says it hasn't arrived, and nothing crashes.
 */
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const scratch = mkdtempSync(join(tmpdir(), 'editify-land-first-'));
const created: string[] = [];

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const id of created) rmSync(join(assetsRoot, id), { recursive: true, force: true });
});

/** 160 x 284 test pattern at 30 fps, no audio. */
function clip(name: string, seconds: number): Buffer {
  const path = join(scratch, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=160x284:r=30:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path]);
  return readFileSync(path);
}

const PHONE_PROBE = { name: 'IMG_0001.MOV', mimeType: 'video/quicktime', duration: 1, width: 160, height: 284, hasAudio: false };

let app: FastifyInstance;
let projectId: string;

beforeEach(async () => {
  app = await buildApp({ database: createDatabase(':memory:') });
  projectId = (await app.inject({ method: 'POST', url: '/projects', payload: { title: 'Land first' } })).json<{ id: string }>().id;
  return async () => { await app.close(); };
});

async function put(id: string, payload: Buffer) {
  return await app.inject({
    method: 'PUT',
    url: `/assets/${id}/original?projectId=${projectId}&name=IMG_0001.MOV`,
    headers: { 'content-type': 'video/quicktime' },
    payload,
  });
}

/** Waits for the background work an arrived original queued, so the database outlives it. */
async function settle(id: string): Promise<string> {
  let status = 'processing';
  for (let tries = 0; status === 'processing' && tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = (await app.inject({ method: 'GET', url: `/assets/${id}` })).json<{ status: string }>().status;
  }
  return status;
}

async function register(body: object = PHONE_PROBE, project = projectId) {
  return await app.inject({ method: 'POST', url: `/assets/register${project ? `?projectId=${project}` : ''}`, payload: body });
}

describe('POST /assets/register', () => {
  it('makes a processing row from the phone\'s probe, linked to the project, before any bytes', async () => {
    const response = await register();
    expect(response.statusCode).toBe(201);
    const asset = response.json<{ id: string; status: string; fps: number; duration: number }>();
    created.push(asset.id);
    expect(asset).toMatchObject({ originalName: 'IMG_0001.MOV', status: 'processing', fps: 0, duration: 1, width: 160, height: 284 });
    const library = (await app.inject({ method: 'GET', url: `/assets?projectId=${projectId}` })).json<Array<{ id: string }>>();
    expect(library.map((item) => item.id)).toEqual([asset.id]);
    // Nothing runs for it, so a drain is not held up by an upload that may never come.
    expect((await app.inject({ method: 'GET', url: '/health' })).json<{ jobs: { imports: number } }>().jobs.imports).toBe(0);
  });

  it('refuses a missing project, a still and a video without its size', async () => {
    expect((await register(PHONE_PROBE, '')).statusCode).toBe(400);
    expect((await register(PHONE_PROBE, 'no-such-project')).statusCode).toBe(404);
    expect((await register({ ...PHONE_PROBE, mimeType: 'image/png' })).statusCode).toBe(400);
    expect((await register({ ...PHONE_PROBE, width: 0 })).statusCode).toBe(400);
    expect((await register({ ...PHONE_PROBE, duration: 0 })).statusCode).toBe(400);
    // Past the upload cap: refused now, so the pick says so instead of landing a clip that can never upload.
    expect((await register({ ...PHONE_PROBE, bytes: 3 * 1024 ** 3 })).statusCode).toBe(413);
    expect((await register({ ...PHONE_PROBE, bytes: 1024 })).statusCode).toBe(201);
  });

  it('says "still uploading" wherever the original would be read, and renders wait for it', async () => {
    const asset = (await register()).json<{ id: string }>();
    created.push(asset.id);
    for (const url of [`/assets/${asset.id}/original`, `/assets/${asset.id}/thumb.jpg`, `/assets/${asset.id}/proxy.mp4`, `/assets/${asset.id}/dissect`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(409);
      expect(response.json(), url).toMatchObject({ code: 'uploading' });
    }
    const availability = await app.inject({ method: 'POST', url: `/projects/${projectId}/assets/availability`, payload: { assetIds: [asset.id] } });
    expect(availability.json()).toEqual({ assets: [{ id: asset.id, status: 'missing' }] });

    const project = (await app.inject({ method: 'GET', url: `/projects/${projectId}` })).json<{ version: number }>();
    const added = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/ops`,
      payload: { baseVersion: project.version, ops: [{ type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'c1', assetId: asset.id, start: 0, in: 0, out: 1 } } }] },
    });
    expect(added.statusCode).toBe(200);
    const render = await app.inject({ method: 'POST', url: `/projects/${projectId}/render`, payload: { resolution: '1080p' } });
    expect(render.statusCode).toBe(409);
    expect(render.json<{ error: string; code: string }>()).toMatchObject({ code: 'uploading' });
    expect(render.json<{ error: string }>().error).toContain('"IMG_0001.MOV" hasn\'t reached the server from the phone yet');
  });

  it('keeps Whisper and sync off a clip whose original is on its way, and tells the agent', async () => {
    const video = (await register({ ...PHONE_PROBE, hasAudio: true })).json<{ id: string }>();
    const memo = (await register({ name: 'Memo.m4a', mimeType: 'audio/mp4', duration: 4, width: 0, height: 0, hasAudio: true })).json<{ id: string }>();
    created.push(video.id, memo.id);
    const transcribe = await app.inject({ method: 'POST', url: `/assets/${video.id}/transcribe`, payload: {} });
    expect(transcribe.statusCode).toBe(409);
    expect(transcribe.json()).toMatchObject({ code: 'uploading' });
    expect((await app.inject({ method: 'GET', url: `/assets/${video.id}/waveform` })).json()).toMatchObject({ code: 'uploading' });

    const project = (await app.inject({ method: 'GET', url: `/projects/${projectId}` })).json<{ version: number }>();
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/ops`,
      payload: {
        baseVersion: project.version,
        ops: [
          { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'v1', assetId: video.id, start: 0, in: 0, out: 1 } } },
          { type: 'add_clip', params: { trackId: 'audio-main', clip: { id: 'm1', assetId: memo.id, start: 0, in: 0, out: 4 } } },
        ],
      },
    });
    const sync = await app.inject({ method: 'GET', url: `/projects/${projectId}/sync?audioClipId=m1` });
    expect(sync.json()).toMatchObject({ ok: false });
    expect(sync.json<{ error: string }>().error).toContain('hasn\'t reached the server');

    // The agent sees which clips are still uploading, so it can say what has to wait.
    const listAssets = createToolRegistry().find((tool) => tool.name === 'list_assets');
    const stored = (id: string, originalPath: string, status: string) => ({ id, originalName: `${id}.mov`, duration: 1, width: 1, height: 1, hasAudio: true, mimeType: 'video/quicktime', originalPath, status });
    const ctx = {
      projectId, styleDoc: null, currentVersion: 1,
      assets: { listForProject: () => [stored('here', '/media/here.mov', 'ready'), stored('coming', '', 'processing')] },
    } as unknown as ToolContext;
    expect(await listAssets?.execute(ctx, {})).toEqual([
      expect.not.objectContaining({ uploading: true }),
      expect.objectContaining({ id: 'coming', uploading: true }),
    ]);
  });

  it.skipIf(!hasFfmpeg)('refuses only another kind of media for a registered clip, and lets the server\'s probe win', async () => {
    // Registered as audio, sent a picture with no sound: another kind, refused, still waiting.
    const memo = (await register({ name: 'Memo.m4a', mimeType: 'audio/mp4', duration: 1, width: 0, height: 0, hasAudio: true })).json<{ id: string }>();
    created.push(memo.id);
    const wrongKind = await put(memo.id, clip('picture.mp4', 1));
    expect(wrongKind.statusCode).toBe(409);
    expect(wrongKind.json()).toMatchObject({ code: 'mismatch' });
    expect((await app.inject({ method: 'GET', url: `/assets/${memo.id}/original` })).json()).toMatchObject({ code: 'uploading' });

    // The phone measured 1 s at another size and with sound (AVFoundation and ffprobe can disagree):
    // the server's numbers replace them rather than refusing the clip forever.
    const video = (await register({ ...PHONE_PROBE, duration: 1, width: 1080, height: 1920, hasAudio: true })).json<{ id: string }>();
    created.push(video.id);
    const landed = await put(video.id, clip('three.mp4', 3));
    expect(landed.statusCode).toBe(200);
    expect(landed.json()).toMatchObject({ duration: 3, width: 160, height: 284, fps: 30, hasAudio: false });
    await settle(video.id);
  });

  it.skipIf(!hasFfmpeg)('lands one of two uploads racing for the same clip, and queues its work once', async () => {
    const asset = (await register()).json<{ id: string }>();
    created.push(asset.id);
    const body = clip('race.mp4', 1);
    const [a, b] = await Promise.all([put(asset.id, body), put(asset.id, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((response) => response.statusCode === 409)?.json()).toMatchObject({ code: 'in_progress' });
    // The phone checks again: the original is there now.
    expect((await put(asset.id, body)).statusCode).toBe(200);
    expect(readdirSync(join(assetsRoot, asset.id)).filter((file) => file.startsWith('original') || file.startsWith('incoming'))).toEqual(['original.MOV']);
    await settle(asset.id);
  });

  it.skipIf(!hasFfmpeg)('takes the original through PUT, then makes the proxy like an import', async () => {
    const asset = (await register()).json<{ id: string }>();
    created.push(asset.id);

    const landed = await app.inject({
      method: 'PUT',
      url: `/assets/${asset.id}/original?projectId=${projectId}&name=IMG_0001.MOV`,
      headers: { 'content-type': 'video/quicktime' },
      payload: clip('one.mp4', 1),
    });
    expect(landed.statusCode).toBe(200);
    expect(landed.json<{ fps: number }>().fps).toBe(30);
    expect(await settle(asset.id)).toBe('ready');
    expect((await app.inject({ method: 'GET', url: `/assets/${asset.id}/thumb.jpg` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/assets/${asset.id}/original` })).statusCode).toBe(200);
  });
});

describe('the render queue', () => {
  it('fails a queued render whose clip was registered after it, instead of running ffmpeg with no input', async () => {
    const { AssetStore } = await import('../src/db/asset-store.js');
    const { ProjectStore } = await import('../src/db/project-store.js');
    const { RenderStore } = await import('../src/db/render-store.js');
    const { RenderQueue } = await import('../src/services/render-queue.js');
    const database = createDatabase(':memory:');
    const assets = new AssetStore(database);
    const projects = new ProjectStore(database);
    const renders = new RenderStore(database);
    const project = projects.create({ title: 'Queued', format: '9:16', fps: 30 });
    assets.insert({
      id: 'coming', originalName: 'IMG_0002.MOV', mimeType: 'video/quicktime', duration: 1, width: 160, height: 284, fps: 0,
      hasAudio: false, status: 'processing', originalPath: '', proxyPath: '/nowhere/proxy.mp4', thumbnailPath: '/nowhere/thumb.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
    assets.link(project.id, 'coming');
    projects.applyOperations(project.id, [{ type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'c1', assetId: 'coming', start: 0, in: 0, out: 1 } } }], project.version);
    // Only the first of two landings takes the row (the second upload of a race loses cleanly).
    const measured = { duration: 1, width: 160, height: 284, fps: 30, hasAudio: false };
    expect(assets.landOriginal('nobody', '/a', measured)).toBe(false);
    const render = new RenderQueue(renders, projects, assets).enqueue(project.id, '1080p');
    for (let tries = 0; renders.get(render.id)?.status !== 'error' && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renders.get(render.id)).toMatchObject({ status: 'error', error: expect.stringContaining('"IMG_0002.MOV" hasn\'t reached the server') });
    expect(assets.landOriginal('coming', '/media/coming/original.MOV', measured)).toBe(true);
    expect(assets.landOriginal('coming', '/media/coming/other.MOV', measured)).toBe(false);
    expect(assets.get('coming')?.originalPath).toBe('/media/coming/original.MOV');
  });
});
