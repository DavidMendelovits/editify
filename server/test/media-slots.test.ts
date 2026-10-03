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

/**
 * A slot holder that transcribes inline, without letting go of its slot. Imports
 * no longer do this (`queueAssetWork` queues the transcription as its own job,
 * see import-scheduling.test.ts), but any caller inside a slot still may.
 */
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

  it('prefers waiting foreground jobs over waiting background ones', async () => {
    const slots = new MediaSlots(1);
    const order: string[] = [];
    const job = (label: string, lane: 'foreground' | 'background') => slots.run(label, async () => {
      order.push(label);
      await delay(5);
    }, { lane });
    await Promise.all([
      job('running', 'foreground'),
      job('transcribe early', 'background'),
      job('proxy', 'foreground'),
      job('transcribe late', 'background'),
      job('render', 'foreground'),
    ]);
    expect(order).toEqual(['running', 'proxy', 'render', 'transcribe early', 'transcribe late']);
  });

  it('gives waiting background work every third grant, so a run of foreground jobs cannot starve it', async () => {
    const slots = new MediaSlots(1);
    const order: string[] = [];
    const job = (label: string, lane: 'foreground' | 'background') => slots.run(label, async () => {
      order.push(label);
      await delay(2);
    }, { lane });
    await Promise.all([
      job('running', 'foreground'),
      job('transcribe', 'background'),
      ...['p1', 'p2', 'p3', 'p4'].map((label) => job(label, 'foreground')),
    ]);
    expect(order).toEqual(['running', 'p1', 'p2', 'transcribe', 'p3', 'p4']);
  });

  it('keeps one slot out of background hands, so a new preview never waits behind two Whispers', async () => {
    const slots = new MediaSlots(2);
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const whispers = [slots.run('transcribe a', () => held, { lane: 'background' }), slots.run('transcribe b', () => held, { lane: 'background' })];
    expect(slots.active()).toEqual(['transcribe a']);
    expect(slots.queued()).toEqual(['transcribe b']);

    let previewRan = false;
    await slots.run('import c', async () => { previewRan = true; });
    expect(previewRan).toBe(true);
    release();
    await Promise.all(whispers);
    expect(slots.active()).toEqual([]);
  });

  it('cancels a queued background job, but not one someone promoted', async () => {
    const slots = new MediaSlots(1);
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const running = slots.run('render', () => held);
    const dropped = slots.run('transcribe bad', async () => 'ran', { lane: 'background' });
    const wanted = slots.run('transcribe wanted', async () => 'ran', { lane: 'background' });
    expect(slots.promote('transcribe wanted')).toBe(true);
    expect(slots.cancel('transcribe wanted', new Error('nope'))).toBe(false);
    expect(slots.cancel('transcribe bad', new Error('undecodable'))).toBe(true);
    await expect(dropped).rejects.toThrow('undecodable');
    expect(slots.queued()).toEqual(['transcribe wanted']);
    release();
    await expect(wanted).resolves.toBe('ran');
    await running;
    expect(slots.active()).toEqual([]);
  });

  it('promotes a background waiter to the back of the foreground queue', async () => {
    const slots = new MediaSlots(1);
    const order: string[] = [];
    const job = (label: string, lane: 'foreground' | 'background') => slots.run(label, async () => {
      order.push(label);
      await delay(5);
    }, { lane });
    const all = [job('running', 'foreground'), job('transcribe', 'background'), job('proxy', 'foreground')];
    expect(slots.promote('transcribe')).toBe(true);
    const later = job('render', 'foreground');
    expect(slots.queued()).toEqual(['proxy', 'transcribe', 'render']);
    expect(slots.promote('running')).toBe(false);
    await Promise.all([...all, later]);
    expect(order).toEqual(['running', 'proxy', 'transcribe', 'render']);
  });

  it('queues work started through `detached` on its own instead of riding the caller\'s slot', async () => {
    const slots = new MediaSlots(1);
    let inner: Promise<void> | undefined;
    await slots.run('parent', async () => {
      inner = slots.detached(() => slots.run('child', async () => undefined));
      expect(slots.queued()).toEqual(['child']);
    });
    await inner;
    expect(slots.active()).toEqual([]);
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
