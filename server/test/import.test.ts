import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase } from '../src/db/database.js';
import { TranscriptStore } from '../src/db/transcript-store.js';

describe('local media import', () => {
  it('rejects path traversal', async () => {
    const app = await buildApp({ database: createDatabase(':memory:') });
    const response = await app.inject({
      method: 'POST',
      url: '/assets/import',
      payload: { name: '../secret' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('serves stored transcripts and rejects transcription for silent assets without spawning Whisper', async () => {
    const database = createDatabase(':memory:');
    const assets = new AssetStore(database);
    for (const [id, hasAudio] of [['speech', true], ['silent', false]] as const) {
      assets.insert({
        id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1,
        width: 100, height: 100, fps: 30, hasAudio,
        originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
        originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
      });
    }
    new TranscriptStore(database).put('speech', {
      language: 'en', durationProcessedSeconds: 0.5,
      words: [{ w: 'hello', s: 0, e: 0.5 }], segments: [{ text: 'hello', s: 0, e: 0.5 }],
    });
    const app = await buildApp({ database });
    const transcript = await app.inject({ method: 'GET', url: '/assets/speech/transcript' });
    expect(transcript.statusCode).toBe(200);
    expect(transcript.json()).toMatchObject({ assetId: 'speech', language: 'en' });
    const silent = await app.inject({ method: 'POST', url: '/assets/silent/transcribe', payload: {} });
    expect(silent.statusCode).toBe(422);
    await app.close();
  });

  // Imports respond before the proxy exists, so the library carries a status and
  // the media routes have to answer "not yet" instead of throwing on a missing file.
  it('reports processing assets and refuses their generated media until it lands', async () => {
    const database = createDatabase(':memory:');
    const assets = new AssetStore(database);
    assets.insert({
      id: 'fresh', originalName: 'fresh.mp4', mimeType: 'video/mp4', duration: 12,
      width: 100, height: 100, fps: 30, hasAudio: true, status: 'processing',
      originalPath: '/not/read.mp4', proxyPath: '/not/written-proxy.mp4', thumbnailPath: '/not/written.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
    const app = await buildApp({ database });

    const listed = (await app.inject({ method: 'GET', url: '/assets' })).json();
    expect(listed[0]).toMatchObject({ id: 'fresh', status: 'processing', duration: 12 });

    for (const path of ['proxy.mp4', 'thumb.jpg', 'filmstrip.jpg']) {
      const response = await app.inject({ method: 'GET', url: `/assets/fresh/${path}` });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ status: 'processing' });
    }

    // Processing finished: the row is ready, and old rows read back as ready too.
    assets.setStatus('fresh', 'ready', { proxyPath: '/other/proxy.mp4', thumbnailPath: '/other/thumb.jpg' });
    expect(assets.get('fresh')).toMatchObject({ status: 'ready', proxyPath: '/other/proxy.mp4' });
    await app.close();
  });
});

describe('media library', () => {
  it('lists every asset newest-first and round-trips labels', async () => {
    const database = createDatabase(':memory:');
    const assets = new AssetStore(database);
    for (const id of ['first', 'second']) {
      assets.insert({
        id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1,
        width: 100, height: 100, fps: 30, hasAudio: false,
        originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
        originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
      });
    }
    const app = await buildApp({ database });

    const list = await app.inject({ method: 'GET', url: '/assets' });
    expect(list.json().map((asset: { id: string }) => asset.id)).toEqual(['second', 'first']);

    const named = await app.inject({ method: 'PATCH', url: '/assets/first', payload: { label: '  b-roll  ' } });
    expect(named.json()).toMatchObject({ id: 'first', label: 'b-roll' });
    // Blank clears the label so the card falls back to the file name.
    const cleared = await app.inject({ method: 'PATCH', url: '/assets/first', payload: { label: '   ' } });
    expect(cleared.json().label).toBeUndefined();

    expect((await app.inject({ method: 'PATCH', url: '/assets/nope', payload: { label: 'x' } })).statusCode).toBe(404);
    await app.close();
  });

  it('keeps each project to its own media, and adopts a clip only when asked', async () => {
    const database = createDatabase(':memory:');
    const assets = new AssetStore(database);
    for (const id of ['reel-clip', 'doc-clip']) {
      assets.insert({
        id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1,
        width: 100, height: 100, fps: 30, hasAudio: false,
        originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
        originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
      });
    }
    const app = await buildApp({ database });
    const reel = (await app.inject({ method: 'POST', url: '/projects', payload: { title: 'Reel' } })).json();
    const doc = (await app.inject({ method: 'POST', url: '/projects', payload: { title: 'Doc' } })).json();
    assets.link(reel.id, 'reel-clip');
    assets.link(doc.id, 'doc-clip');

    const ids = async (query: string): Promise<string[]> =>
      (await app.inject({ method: 'GET', url: `/assets${query}` })).json().map((asset: { id: string }) => asset.id);

    expect(await ids(`?projectId=${reel.id}`)).toEqual(['reel-clip']);
    expect(await ids(`?projectId=${doc.id}`)).toEqual(['doc-clip']);
    expect((await ids('')).sort()).toEqual(['doc-clip', 'reel-clip']);

    // Borrowing across projects is explicit, and repeating it is harmless.
    const link = await app.inject({ method: 'POST', url: '/assets/doc-clip/link', payload: { projectId: reel.id } });
    expect(link.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/assets/doc-clip/link', payload: { projectId: reel.id } });
    expect((await ids(`?projectId=${reel.id}`)).sort()).toEqual(['doc-clip', 'reel-clip']);
    expect(await ids(`?projectId=${doc.id}`)).toEqual(['doc-clip']);

    expect((await app.inject({ method: 'GET', url: '/assets?projectId=nope' })).statusCode).toBe(404);
    await app.close();
  });

  // Mirrors what the app sends after a multi-file photo import: one batch of
  // add_clip ops laid end to end, so nothing overlaps and no gap opens up.
  it('accepts a multi-clip import batch back-to-back on the video track', async () => {
    const database = createDatabase(':memory:');
    const assets = new AssetStore(database);
    const durations = [4, 2.5, 3];
    durations.forEach((duration, index) => {
      assets.insert({
        id: `a${index}`, originalName: `a${index}.mp4`, mimeType: 'video/mp4', duration,
        width: 100, height: 100, fps: 30, hasAudio: false,
        originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
        originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
      });
    });
    const app = await buildApp({ database });
    const project = (await app.inject({ method: 'POST', url: '/projects', payload: { title: 'Batch import' } })).json();
    durations.forEach((_duration, index) => assets.link(project.id, `a${index}`));

    let start = project.duration;
    const ops = durations.map((duration, index) => {
      const clip = { id: `clip-${index}`, assetId: `a${index}`, start, in: 0, out: duration, volume: 1, speed: 1 };
      start += duration;
      return { type: 'add_clip', params: { trackId: 'video-main', clip } };
    });
    const updated = (await app.inject({
      method: 'POST', url: `/projects/${project.id}/ops`, payload: { ops, baseVersion: project.version },
    })).json();

    const clips = updated.tracks.find((track: { id: string }) => track.id === 'video-main').clips;
    expect(clips.map((clip: { start: number }) => clip.start)).toEqual([0, 4, 6.5]);
    expect(updated.duration).toBe(9.5);
    await app.close();
  });
});
