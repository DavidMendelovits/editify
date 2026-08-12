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
});
