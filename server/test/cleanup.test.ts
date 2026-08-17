import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';

function seedAsset(database: ReturnType<typeof createDatabase>, id: string): void {
  new AssetStore(database).insert({
    id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 6,
    width: 1080, height: 1920, fps: 30, hasAudio: true,
    originalPath: '/never/read.mp4', proxyPath: '/never/read-proxy.mp4', thumbnailPath: '/never/read.jpg',
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
  });
}

function seedProject(database: ReturnType<typeof createDatabase>, id: string, assetId: string): void {
  new ProjectStore(database).insert({
    id, title: 'Cleanup', format: '9:16', fps: 30, duration: 6, version: 0,
    tracks: [
      { id: 'video-main', kind: 'video', clips: [{ id: 'clip-a', assetId, start: 0, in: 0, out: 6 }] },
      { id: 'captions', kind: 'caption', clips: [] },
    ],
  });
}

describe('cleanup plan endpoint', () => {
  it('counts filler words and a quiet gap from a seeded transcript without touching the project', async () => {
    const database = createDatabase(':memory:');
    seedAsset(database, 'speech');
    // Quiet only between 1.1s and 2.0s, so exactly one gap survives the loud-gap guard.
    const rmsDb = Array.from({ length: 120 }, () => -20);
    for (let index = 22; index < 40; index += 1) rmsDb[index] = -50;
    new TranscriptStore(database).put('speech', {
      language: 'en', durationProcessedSeconds: 3.3,
      words: [
        { w: 'So', s: 0, e: 0.3 }, { w: 'um,', s: 0.35, e: 0.55 }, { w: 'this', s: 0.6, e: 0.9 },
        { w: 'is', s: 0.95, e: 1.1 }, { w: 'the', s: 2, e: 2.3 }, { w: 'plan', s: 2.35, e: 2.6 },
        { w: 'Uh', s: 2.7, e: 2.9 }, { w: 'right', s: 3, e: 3.3 },
      ],
      segments: [{ text: 'So um, this is the plan. Uh right', s: 0, e: 3.3 }],
    }, { cellSeconds: 0.05, rmsDb });
    seedProject(database, 'cleanup-project', 'speech');
    const app = await buildApp({ database });

    const response = await app.inject({ method: 'GET', url: '/projects/cleanup-project/cleanup' });
    expect(response.statusCode).toBe(200);
    const plan = response.json() as {
      transcribed: boolean;
      fillers: { ranges: Array<{ start: number; end: number }>; words: string[]; seconds: number };
      silences: { ranges: Array<{ start: number; end: number }>; seconds: number };
      trackId: string;
    };
    expect(plan.transcribed).toBe(true);
    expect(plan.trackId).toBe('video-main');
    // 'So' is never filler — the lexicon stays conservative on purpose.
    expect(plan.fillers.words).toEqual(['uh', 'um']);
    expect(plan.fillers.ranges).toHaveLength(2);
    expect(plan.fillers.ranges[0]?.start).toBeCloseTo(0.3);
    expect(plan.fillers.ranges[0]?.end).toBeCloseTo(0.6);
    expect(plan.fillers.seconds).toBeCloseTo(0.65);
    expect(plan.silences.ranges).toEqual([{ start: 1.25, end: 1.85 }]);
    expect(plan.silences.seconds).toBeCloseTo(0.6);

    const project = await app.inject({ method: 'GET', url: '/projects/cleanup-project' });
    expect(project.json()).toMatchObject({ version: 0 });
    await app.close();
  });

  it('reports an untranscribed project as empty and 404s an unknown project', async () => {
    const database = createDatabase(':memory:');
    seedAsset(database, 'silent');
    seedProject(database, 'no-transcript', 'silent');
    const app = await buildApp({ database });

    const response = await app.inject({ method: 'GET', url: '/projects/no-transcript/cleanup' });
    expect(response.json()).toEqual({
      transcribed: false,
      fillers: { ranges: [], words: [], seconds: 0 },
      silences: { ranges: [], seconds: 0 },
      trackId: 'video-main',
    });
    expect((await app.inject({ method: 'GET', url: '/projects/nope/cleanup' })).statusCode).toBe(404);
    await app.close();
  });
});
