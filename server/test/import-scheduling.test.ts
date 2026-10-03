import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetStore, type StoredAsset } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { TranscriptStore, type TranscriptResult } from '../src/db/transcript-store.js';
import type { ProbeResult } from '../src/media/process.js';
import { pendingAssetWork, queueAssetWork } from '../src/routes/assets.js';
import { FaceService, type FaceTrack } from '../src/services/face-service.js';
import { setMediaJobLogger, type MediaJobLogger } from '../src/services/media-jobs.js';
import { mediaSlots } from '../src/services/media-slots.js';
import { TranscriptService } from '../src/services/transcript-service.js';

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** What the fakes did, in order, plus the busiest the pool got while they ran. */
const timeline = vi.hoisted(() => ({
  events: [] as string[],
  peak: 0,
  proxyMs: new Map<string, number>(),
  proxyFails: new Set<string>(),
}));

vi.mock('../src/media/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media/process.js')>();
  const { mediaSlots: slots } = await import('../src/services/media-slots.js');
  return {
    ...actual,
    createProxyAndThumbnail: async (originalPath: string, directory: string) => {
      const id = originalPath.split('/').pop()?.replace('.mp4', '') ?? '';
      timeline.events.push(`proxy:start ${id}`);
      timeline.peak = Math.max(timeline.peak, slots.active().length);
      await delay(timeline.proxyMs.get(id) ?? 20);
      if (timeline.proxyFails.has(id)) throw new Error('ffmpeg died');
      timeline.events.push(`proxy:end ${id}`);
      return { proxyPath: `${directory}/proxy.mp4`, thumbnailPath: `${directory}/thumb.jpg` };
    },
  };
});

const transcript: TranscriptResult = {
  language: 'en', durationProcessedSeconds: 0.5,
  words: [{ w: 'hello', s: 0, e: 0.5 }],
  segments: [{ text: 'hello', s: 0, e: 0.5 }],
};
const track: FaceTrack = { fps: 2, width: 1920, height: 1080, samples: [[0, 0.2, 0.6, 0.4, 0.6]] };
const probe: ProbeResult = { duration: 1, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true };
const quiet = { error: () => undefined, warn: () => undefined };

let database: EditifyDatabase;
let assets: AssetStore;
let faces: FaceService;

function whisper(ms: number) {
  return vi.fn(async (path: string) => {
    const id = path.split('/').pop()?.replace('.mp4', '') ?? '';
    timeline.events.push(`whisper:start ${id}`);
    timeline.peak = Math.max(timeline.peak, mediaSlots.active().length);
    await delay(ms);
    timeline.events.push(`whisper:end ${id}`);
    return transcript;
  });
}

function service(runner: ReturnType<typeof whisper>): TranscriptService {
  return new TranscriptService(new TranscriptStore(database), runner, async () => ({ cellSeconds: 0.05 as const, rmsDb: [-30] }));
}

function insertAsset(id: string): StoredAsset {
  return assets.insert({
    id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1,
    width: 1920, height: 1080, fps: 30, hasAudio: true, status: 'processing',
    originalPath: `/not/read/${id}.mp4`, proxyPath: `/not/written/${id}/proxy.mp4`, thumbnailPath: `/not/written/${id}/thumb.jpg`,
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
  });
}

function startImport(transcripts: TranscriptService, id: string): { asset: StoredAsset; done: Promise<void> } {
  const asset = insertAsset(id);
  queueAssetWork(quiet, assets, transcripts, asset, probe, faces);
  return { asset, done: pendingAssetWork.get(id) as Promise<void> };
}

beforeEach(() => {
  database = createDatabase(':memory:');
  assets = new AssetStore(database);
  faces = new FaceService(database, async () => {
    timeline.events.push('faces');
    return track;
  });
  timeline.events = [];
  timeline.peak = 0;
  timeline.proxyMs.clear();
  timeline.proxyFails.clear();
});
afterEach(async () => {
  // A failed test must not leave its jobs holding the shared pool for the next one.
  await Promise.allSettled([...pendingAssetWork.values()]);
  setMediaJobLogger(undefined);
  database.close();
});

describe('import scheduling', () => {
  it('transcribes alongside the proxy, so a slow encode no longer holds the transcript back', async () => {
    timeline.proxyMs.set('clip', 80);
    const runner = whisper(20);
    const transcripts = service(runner);
    const { done } = startImport(transcripts, 'clip');

    // The transcript lands while the encode is still going.
    await vi.waitFor(() => expect(transcripts.get('clip')).toBeDefined());
    expect(assets.get('clip')?.status).toBe('processing');
    await done;

    expect(timeline.events).toEqual([
      'proxy:start clip', 'whisper:start clip', 'whisper:end clip', 'proxy:end clip', 'faces',
    ]);
    expect(assets.get('clip')?.status).toBe('ready');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(mediaSlots.active()).toEqual([]);
  });

  it('keeps previews first in line: waiting encodes always go before waiting transcriptions', async () => {
    const runner = whisper(150);
    const transcripts = service(runner);
    const imports = ['a', 'b', 'c'].map((id) => startImport(transcripts, id));
    // The first clip's encode and Whisper take the two free slots. After that
    // b and c encode back to back on the slot a's encode frees, ahead of b's
    // and c's transcriptions, which were queued first.
    expect(mediaSlots.queued()).toEqual(['import b', 'import c', 'transcribe b', 'transcribe c']);
    await vi.waitFor(() => expect(assets.get('c')?.status).toBe('ready'));
    expect(timeline.events.filter((event) => event.startsWith('whisper:end'))).toEqual([]);
    expect(timeline.events.slice(0, 2)).toEqual(['proxy:start a', 'whisper:start a']);

    await Promise.all(imports.map((entry) => entry.done));
    expect(timeline.events.indexOf('whisper:start b')).toBeGreaterThan(timeline.events.indexOf('proxy:end c'));
    expect(['a', 'b', 'c'].map((id) => assets.get(id)?.status)).toEqual(['ready', 'ready', 'ready']);
    expect(['a', 'b', 'c'].every((id) => transcripts.get(id))).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(timeline.peak).toBe(2);
    expect(mediaSlots.active()).toEqual([]);
    expect(mediaSlots.queued()).toEqual([]);
  });

  it('never runs more than the pool allows, and never deadlocks, across three imports on two slots', async () => {
    timeline.proxyMs.set('x', 30).set('y', 5).set('z', 15);
    const runner = whisper(10);
    const transcripts = service(runner);
    const imports = ['x', 'y', 'z'].map((id) => startImport(transcripts, id));
    await Promise.all(imports.map((entry) => entry.done));
    expect(timeline.peak).toBeLessThanOrEqual(2);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(mediaSlots.active()).toEqual([]);
  });

  it('lets an on-demand transcription join the import\'s run instead of starting a second Whisper', async () => {
    timeline.proxyMs.set('talk', 40);
    const runner = whisper(30);
    const transcripts = service(runner);
    const { done } = startImport(transcripts, 'talk');
    await delay(5);
    const asked = await transcripts.transcribe(assets.get('talk') as StoredAsset);
    await done;
    expect(asked.assetId).toBe('talk');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('promotes an import transcription someone asks for out of the background lane', async () => {
    const runner = whisper(5);
    const transcripts = service(runner);
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const blockers = Array.from({ length: mediaSlots.capacity }, (_, index) => mediaSlots.run(`render ${index}`, () => held));
    const first = startImport(transcripts, 'first');
    const second = startImport(transcripts, 'second');
    expect(mediaSlots.queued()).toEqual(['import first', 'import second', 'transcribe first', 'transcribe second']);

    const asked = transcripts.transcribe(assets.get('second') as StoredAsset);
    expect(mediaSlots.queued()).toEqual(['import first', 'import second', 'transcribe second', 'transcribe first']);

    release();
    await Promise.all([...blockers, first.done, second.done, asked]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('still transcribes a clip whose encode failed, and marks the row as an error', async () => {
    timeline.proxyFails.add('bad');
    const runner = whisper(5);
    const transcripts = service(runner);
    await startImport(transcripts, 'bad').done;
    expect(assets.get('bad')?.status).toBe('error');
    expect(timeline.events).not.toContain('faces');
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe('media job log lines', () => {
  it('logs one line per finished job with its wall time, its wait for a slot and whether it worked', async () => {
    const lines: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const logger: MediaJobLogger = { info: (fields, msg) => lines.push({ fields: fields as Record<string, unknown>, msg }) };
    setMediaJobLogger(logger);
    timeline.proxyMs.set('logged', 30);
    timeline.proxyFails.add('broken');
    const transcripts = service(whisper(10));
    await Promise.all([startImport(transcripts, 'logged').done, startImport(transcripts, 'broken').done]);

    expect(lines.every((line) => line.msg === 'media job')).toBe(true);
    const line = (job: string, assetId: string) => lines.find((entry) => entry.fields.job === job && entry.fields.assetId === assetId)?.fields;
    for (const [job, assetId] of [['proxy', 'logged'], ['transcribe', 'logged'], ['faces', 'logged'], ['energy', 'logged']]) {
      expect(line(job as string, assetId as string)).toEqual({
        job, assetId, ms: expect.any(Number), waitMs: expect.any(Number), ok: true,
      });
    }
    expect(line('proxy', 'logged')?.ms).toBeGreaterThanOrEqual(25);
    expect(line('proxy', 'broken')).toMatchObject({ job: 'proxy', assetId: 'broken', ok: false });
    // The first import takes both free slots at once; the second import's
    // transcription waited for one of them.
    expect(line('proxy', 'logged')?.waitMs).toBeLessThan(5);
    expect(line('transcribe', 'logged')?.waitMs).toBeLessThan(5);
    expect(line('transcribe', 'broken')?.waitMs).toBeGreaterThanOrEqual(5);
  });
});
