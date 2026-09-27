import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetStore, type StoredAsset } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { TranscriptStore, type TranscriptResult } from '../src/db/transcript-store.js';
import { MediaSlots, mediaSlots, withMediaSlot } from '../src/services/media-slots.js';
import { RenderQueue } from '../src/services/render-queue.js';
import { TranscriptService } from '../src/services/transcript-service.js';

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Every fake job reports in here, so the test can see the pool from inside. */
const peak = vi.hoisted(() => ({ value: 0, sample(active: number) { this.value = Math.max(this.value, active); } }));

vi.mock('../src/media/render.js', async () => {
  const { mediaSlots: slots } = await import('../src/services/media-slots.js');
  return {
    renderProject: async (_project: unknown, _resolution: unknown, renderId: string) => {
      peak.sample(slots.active().length);
      await new Promise((done) => setTimeout(done, 30));
      return `/renders/${renderId}/output.mp4`;
    },
  };
});

const transcript: TranscriptResult = {
  language: 'en', durationProcessedSeconds: 0.5,
  words: [{ w: 'hello', s: 0, e: 0.5 }],
  segments: [{ text: 'hello', s: 0, e: 0.5 }],
};
const energy = async () => ({ cellSeconds: 0.05 as const, rmsDb: [-30] });

let database: EditifyDatabase;
let assets: AssetStore;

function insertAsset(id: string): StoredAsset {
  return assets.insert({
    id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1,
    width: 1920, height: 1080, fps: 30, hasAudio: true,
    originalPath: `/not/read/${id}.mp4`, proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
  });
}

/** Mirrors `queueAssetWork`: encode inside a slot, then transcribe without letting go of it. */
function importWork(transcripts: TranscriptService, asset: StoredAsset, encodeMs = 20): Promise<unknown> {
  return withMediaSlot(`import ${asset.id}`, async () => {
    peak.sample(mediaSlots.active().length);
    await delay(encodeMs);
    return await transcripts.transcribe(asset);
  });
}

beforeEach(() => {
  database = createDatabase(':memory:');
  assets = new AssetStore(database);
  peak.value = 0;
});
afterEach(() => database.close());

describe('media slot pool', () => {
  it('never runs more than its capacity across imports, renders and on-demand transcriptions', async () => {
    expect(mediaSlots.capacity).toBe(2);
    const runner = vi.fn(async () => {
      peak.sample(mediaSlots.active().length);
      await delay(25);
      return transcript;
    });
    const transcripts = new TranscriptService(new TranscriptStore(database), runner, energy);
    const projects = new ProjectStore(database);
    const renders = new RenderStore(database);
    const queue = new RenderQueue(renders, projects, assets);
    const secondQueue = new RenderQueue(renders, projects, assets);
    const project = projects.create({ title: 'Load', format: '9:16', fps: 30 });

    const imported = [insertAsset('import-1'), insertAsset('import-2'), insertAsset('import-3')];
    const onDemand = [insertAsset('ask-1'), insertAsset('ask-2')];
    const renderIds = [queue.enqueue(project.id, '1080p').id, secondQueue.enqueue(project.id, '720p').id];
    await Promise.all([
      ...imported.map((asset) => importWork(transcripts, asset)),
      ...onDemand.map((asset) => transcripts.transcribe(asset)),
      vi.waitFor(() => {
        for (const id of renderIds) expect(renders.get(id)?.status).toBe('done');
      }, { timeout: 5000 }),
    ]);

    expect(peak.value).toBe(2);
    expect(runner).toHaveBeenCalledTimes(5);
    expect(mediaSlots.active()).toEqual([]);
    expect(mediaSlots.queued()).toEqual([]);
  });

  it('hands out slots in arrival order', async () => {
    const slots = new MediaSlots(1);
    const order: string[] = [];
    const job = (label: string) => slots.run(label, async () => {
      order.push(label);
      await delay(5);
    });
    await Promise.all(['a', 'b', 'c', 'd'].map(job));
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lets a job already holding a slot transcribe without taking a second one', async () => {
    const runner = vi.fn(async () => {
      await delay(10);
      return transcript;
    });
    const transcripts = new TranscriptService(new TranscriptStore(database), runner, energy);
    // Three imports on two slots: if transcription nested a second acquire, the
    // two running imports would each wait on a slot the other holds.
    const results = await Promise.all(['a', 'b', 'c'].map((id) => importWork(transcripts, insertAsset(id))));
    expect(results).toHaveLength(3);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(mediaSlots.active()).toEqual([]);
  });

  it('takes over an on-demand run still queued behind the imports that need it', async () => {
    const runner = vi.fn(async () => {
      await delay(10);
      return transcript;
    });
    const transcripts = new TranscriptService(new TranscriptStore(database), runner, energy);
    const first = insertAsset('first');
    const second = insertAsset('second');
    // Both slots go to imports; the agent then asks for the same two clips.
    // Joining those queued runs from inside the imports would wait forever.
    const imports = [importWork(transcripts, first, 20), importWork(transcripts, second, 20)];
    await delay(5);
    const asked = [transcripts.transcribe(first), transcripts.transcribe(second)];
    expect(mediaSlots.queued()).toEqual(['transcribe first', 'transcribe second']);

    const [importedFirst, , askedFirst] = await Promise.all([...imports, ...asked]);
    expect(askedFirst).toBe(importedFirst);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(mediaSlots.active()).toEqual([]);
  });

  it('releases the slot when a job throws', async () => {
    const slots = new MediaSlots(1);
    await expect(slots.run('boom', async () => { throw new Error('ffmpeg died'); })).rejects.toThrow('ffmpeg died');
    expect(slots.active()).toEqual([]);
    await expect(slots.run('next', async () => 'ran')).resolves.toBe('ran');
  });

  it('frees the slot of a transcription that fails', async () => {
    const failing = new TranscriptService(new TranscriptStore(database), async () => { throw new Error('no whisper'); }, energy);
    await expect(failing.transcribe(insertAsset('broken'))).rejects.toThrow('no whisper');
    expect(mediaSlots.active()).toEqual([]);
  });
});
