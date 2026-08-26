import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetStore, type StoredAsset } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { TranscriptService } from '../src/services/transcript-service.js';
import { WaveformService } from '../src/services/waveform-service.js';

const NEVER_RUNS = async (): Promise<never> => { throw new Error('transcription must not run'); };

describe('waveform service', () => {
  let database: EditifyDatabase;
  let assets: AssetStore;
  let asset: StoredAsset;
  let transcripts: TranscriptService;

  function insert(id: string, hasAudio: boolean): StoredAsset {
    return assets.insert({
      id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1,
      width: 1920, height: 1080, fps: 30, hasAudio,
      originalPath: `/not/read-${id}.mp4`, proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
  }

  beforeEach(() => {
    database = createDatabase(':memory:');
    assets = new AssetStore(database);
    asset = insert('asset-1', true);
    transcripts = new TranscriptService(new TranscriptStore(database), NEVER_RUNS);
  });

  afterEach(() => database.close());

  it('analyses once, then serves the cached envelope', async () => {
    const analyzer = vi.fn(async () => ({ cellSeconds: 0.05 as const, rmsDb: [-30, -20] }));
    const service = new WaveformService(database, transcripts, analyzer);
    expect(await service.getOrCreate(asset)).toEqual({ cellSeconds: 0.05, rmsDb: [-30, -20] });
    expect(await service.getOrCreate(asset)).toEqual({ cellSeconds: 0.05, rmsDb: [-30, -20] });
    expect(analyzer).toHaveBeenCalledTimes(1);
    // A fresh service reads the same row — the cache lives in SQLite, not memory.
    expect(new WaveformService(database, transcripts, analyzer).get(asset.id))
      .toEqual({ cellSeconds: 0.05, rmsDb: [-30, -20] });
  });

  it('shares one analysis between concurrent requests', async () => {
    const analyzer = vi.fn(async () => {
      await new Promise((done) => setTimeout(done, 20));
      return { cellSeconds: 0.05 as const, rmsDb: [-40] };
    });
    const service = new WaveformService(database, transcripts, analyzer);
    const [first, second] = await Promise.all([service.getOrCreate(asset), service.getOrCreate(asset)]);
    expect(analyzer).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    // The map must not leak the settled run, or the cache below would never be hit.
    await service.getOrCreate(asset);
    expect(analyzer).toHaveBeenCalledTimes(1);
  });

  it('prefers the transcript energy and never analyses a silent asset', async () => {
    const analyzer = vi.fn(async () => ({ cellSeconds: 0.05 as const, rmsDb: [-30] }));
    new TranscriptStore(database).put(
      asset.id,
      { language: 'en', durationProcessedSeconds: 0.5, words: [], segments: [{ text: 'hi', s: 0, e: 0.5 }] },
      { cellSeconds: 0.05, rmsDb: [-12, -9] },
    );
    const service = new WaveformService(database, transcripts, analyzer);
    expect(await service.getOrCreate(asset)).toEqual({ cellSeconds: 0.05, rmsDb: [-12, -9] });
    expect(await service.getOrCreate(insert('asset-2', false))).toEqual({ cellSeconds: 0.05, rmsDb: [] });
    expect(analyzer).not.toHaveBeenCalled();
  });
});
