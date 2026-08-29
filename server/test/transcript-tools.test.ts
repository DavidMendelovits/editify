import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockToolProvider } from '../src/agent/providers.js';
import { chunkTranscriptForClip, createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore, type TranscriptResult } from '../src/db/transcript-store.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

const transcript: TranscriptResult = {
  language: 'en',
  durationProcessedSeconds: 3,
  words: [
    { w: 'partial', s: 0.3, e: 0.6 },
    { w: 'hello', s: 0.6, e: 0.8 },
    { w: 'there', s: 0.9, e: 1.1 },
    { w: 'friend', s: 1.8, e: 2.1 },
    { w: 'again', s: 2.2, e: 2.3 },
    { w: 'now', s: 2.35, e: 2.45 },
  ],
  segments: [{ text: 'Hello there, friend again!', s: 0.6, e: 2.8 }],
};

describe('transcript caption chunking', () => {
  it('groups by word count and pauses, excludes a word crossing clip.in, and maps speed', () => {
    const chunks = chunkTranscriptForClip(transcript.words, { start: 10, in: 0.5, out: 2.5, speed: 2 }, 2);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['hello there', 'friend again', 'now']);
    expect(chunks[0]).toMatchObject({ sourceStart: 0.6, sourceEnd: 1.1, start: 10.05, duration: 0.25 });
    expect(chunks[1]).toMatchObject({ sourceStart: 1.8, sourceEnd: 2.3, start: 10.65, duration: 0.25 });
    expect(chunks[2]?.start).toBeCloseTo(10.925);
    expect((chunks[2]?.start ?? 0) + (chunks[2]?.duration ?? 0)).toBeLessThanOrEqual(11);
  });

  it('returns no chunks for an empty source range', () => {
    expect(chunkTranscriptForClip(transcript.words, { start: 0, in: 5, out: 6, speed: 1 }, 3)).toEqual([]);
  });
});

describe('transcript agent tools', () => {
  let database: EditifyDatabase;
  let assets: AssetStore;
  let projects: ProjectStore;
  let transcriptStore: TranscriptStore;
  let ctx: ToolContext;

  beforeEach(() => {
    database = createDatabase(':memory:');
    assets = new AssetStore(database);
    projects = new ProjectStore(database);
    transcriptStore = new TranscriptStore(database);
    const transcripts = new TranscriptService(transcriptStore, async () => {
      throw new Error('Whisper must not run in unit tests');
    }, async () => {
      throw new Error('ffmpeg must not run in unit tests');
    });
    const insights = new InsightService(new InsightStore(database), transcripts, async () => new MockToolProvider());
    assets.insert({
      id: 'asset-1', originalName: 'speech.mp4', mimeType: 'video/mp4', duration: 3,
      width: 1080, height: 1920, fps: 30, hasAudio: true,
      originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
    const project = projects.insert({
      id: 'transcript-project', title: 'Transcript tools', format: '9:16', fps: 30, duration: 2,
      version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [{ id: 'clip-a', assetId: 'asset-1', start: 4, in: 0.5, out: 2.5, speed: 2 }] },
        { id: 'captions', kind: 'caption', clips: [{ id: 'cap-clip-a-1', start: 0, in: 0, out: 1, text: 'OLD' }] },
      ],
    });
    ctx = { projectId: project.id, projects, assets, transcripts, insights, styleDoc: null, currentVersion: 0 };
  });

  afterEach(() => database.close());

  it('replaces generated captions using a seeded transcript row', async () => {
    transcriptStore.put('asset-1', transcript);
    const tool = createToolRegistry().find((candidate) => candidate.name === 'caption_clip_from_transcript');
    const result = await tool?.execute(ctx, { clipId: 'clip-a', wordsPerChunk: 2 });
    expect(result).toMatchObject({ ok: true, captionsAdded: 3, version: 1 });
    const captions = projects.get(ctx.projectId)?.tracks.find((track) => track.kind === 'caption')?.clips ?? [];
    expect(captions.map((caption) => caption.id)).toEqual(['cap-clip-a-1', 'cap-clip-a-2', 'cap-clip-a-3']);
    expect(captions[0]).toMatchObject({ text: 'HELLO THERE', start: 4.05, out: 0.25 });
    expect(captions[0]?.style).toMatchObject({ font: 'Montserrat', size: 64, position: 'bottom', emphasis: 'bold' });
  });

  it('returns errors for missing transcripts and insights without changing the project', async () => {
    const registry = createToolRegistry();
    for (const name of ['get_transcript', 'get_insights']) {
      const result = await registry.find((tool) => tool.name === name)?.execute(ctx, { assetId: 'asset-1' });
      expect(result).toMatchObject({ ok: false });
    }
    const result = await registry.find((tool) => tool.name === 'caption_clip_from_transcript')
      ?.execute(ctx, { clipId: 'clip-a' });
    expect(result).toMatchObject({ ok: false });
    expect(projects.get(ctx.projectId)?.version).toBe(0);
  });

  it('transcribes on demand when captioning, and a failed run is retried on the next call', async () => {
    let runs = 0;
    ctx.transcripts = new TranscriptService(transcriptStore, async () => {
      runs += 1;
      if (runs === 1) throw new Error('whisper crashed');
      return transcript;
    }, async () => { throw new Error('ffmpeg must not run in unit tests'); });
    const tool = createToolRegistry().find((candidate) => candidate.name === 'caption_clip_from_transcript');
    const failed = await tool?.execute(ctx, { clipId: 'clip-a', wordsPerChunk: 2 });
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining('whisper crashed') });
    const retried = await tool?.execute(ctx, { clipId: 'clip-a', wordsPerChunk: 2 });
    expect(retried).toMatchObject({ ok: true, captionsAdded: 3 });
    expect(runs).toBe(2);
    expect(transcriptStore.get('asset-1')?.words).toHaveLength(6);
  });
});
