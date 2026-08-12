import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetStore, type StoredAsset } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { TranscriptService } from '../src/services/transcript-service.js';

describe('transcript service', () => {
  let database: EditifyDatabase;
  let asset: StoredAsset;

  beforeEach(() => {
    database = createDatabase(':memory:');
    asset = new AssetStore(database).insert({
      id: 'asset-1', originalName: 'speech.mp4', mimeType: 'video/mp4', duration: 1,
      width: 1920, height: 1080, fps: 30, hasAudio: true,
      originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
  });

  afterEach(() => database.close());

  it('is idempotent unless force is requested and never launches a real process', async () => {
    const runner = vi.fn(async () => ({
      language: 'en', durationProcessedSeconds: 0.5,
      words: [{ w: 'hello', s: 0, e: 0.5 }],
      segments: [{ text: 'hello', s: 0, e: 0.5 }],
    }));
    const energyRunner = vi.fn(async () => ({ cellSeconds: 0.05 as const, rmsDb: [-30, -20] }));
    const service = new TranscriptService(new TranscriptStore(database), runner, energyRunner);
    await service.transcribe(asset);
    await service.transcribe(asset);
    expect(runner).toHaveBeenCalledTimes(1);
    await service.transcribe(asset, true);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(energyRunner).toHaveBeenCalledTimes(2);
    expect(service.get(asset.id)).toMatchObject({ assetId: asset.id, language: 'en' });
  });
});
