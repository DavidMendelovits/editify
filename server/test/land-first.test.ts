import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
 * everything that reads the original says it is still uploading, and nothing crashes.
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
    expect(render.json<{ error: string }>().error).toContain('"IMG_0001.MOV" is still uploading');
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
    expect(sync.json<{ error: string }>().error).toContain('is still uploading');

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

  it.skipIf(!hasFfmpeg)('takes the original through PUT, then makes the proxy like an import', async () => {
    const asset = (await register()).json<{ id: string }>();
    created.push(asset.id);
    const wrong = await app.inject({
      method: 'PUT',
      url: `/assets/${asset.id}/original?projectId=${projectId}&name=IMG_0001.MOV`,
      headers: { 'content-type': 'video/quicktime' },
      payload: clip('long.mp4', 3),
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ code: 'mismatch' });
    expect((await app.inject({ method: 'GET', url: `/assets/${asset.id}/original` })).json()).toMatchObject({ code: 'uploading' });

    const landed = await app.inject({
      method: 'PUT',
      url: `/assets/${asset.id}/original?projectId=${projectId}&name=IMG_0001.MOV`,
      headers: { 'content-type': 'video/quicktime' },
      payload: clip('one.mp4', 1),
    });
    expect(landed.statusCode).toBe(200);
    let current = landed.json<{ status: string; fps: number }>();
    expect(current.fps).toBe(30);
    for (let tries = 0; current.status === 'processing' && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = (await app.inject({ method: 'GET', url: `/assets/${asset.id}` })).json();
    }
    expect(current.status).toBe('ready');
    expect((await app.inject({ method: 'GET', url: `/assets/${asset.id}/thumb.jpg` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/assets/${asset.id}/original` })).statusCode).toBe(200);
  });
});
