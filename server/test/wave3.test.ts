import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@editify/shared';
import { MockToolProvider } from '../src/agent/providers.js';
import { chunkTranscriptForClip, createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore, type TranscriptResult, type TranscriptWord } from '../src/db/transcript-store.js';
import { generateAss } from '../src/media/ass.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWords(random: () => number, count: number): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    cursor += random() * 0.7;
    const end = cursor + 0.05 + random() * 0.5;
    words.push({ w: 'word'.repeat(1 + Math.floor(random() * 3)), s: cursor, e: end });
    cursor = end;
  }
  return words;
}

describe('caption chunk overlap clamp', () => {
  it('never lets a chunk run into the next one, for any seed', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = mulberry32(seed);
      const words = randomWords(random, 40);
      const chunks = chunkTranscriptForClip(words, {
        start: random() * 5,
        in: 0,
        out: (words.at(-1)?.e ?? 1) + 1,
        speed: [0.5, 1, 2][Math.floor(random() * 3)] ?? 1,
      }, {
        wordsPerChunk: 1 + Math.floor(random() * 4),
        minDurationSec: 0.2 + random() * 1.5,
        maxDurationSec: 4,
        maxCharsPerSecond: 40,
      });
      expect(chunks.length).toBeGreaterThan(0);
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.duration).toBeGreaterThanOrEqual(0.15);
        const next = chunks[index + 1];
        if (next) expect(next.start).toBeGreaterThanOrEqual(chunk.start + chunk.duration - 1e-9);
      }
    }
  });

  it('shortens a min-duration-extended chunk instead of overlapping its successor', () => {
    const chunks = chunkTranscriptForClip([
      { w: 'one', s: 0, e: 0.1 },
      { w: 'two', s: 0.4, e: 1.4 },
    ], { start: 0, in: 0, out: 2, speed: 1 }, { wordsPerChunk: 1, minDurationSec: 1.2 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.duration).toBeCloseTo(0.399, 6);
    expect(chunks[1]?.start).toBe(0.4);
  });
});

const transcript: TranscriptResult = {
  language: 'en',
  durationProcessedSeconds: 3,
  words: [
    { w: 'hello', s: 0.6, e: 0.8 },
    { w: 'there', s: 0.9, e: 1.1 },
    { w: 'friend', s: 1.8, e: 2.1 },
  ],
  segments: [{ text: 'Hello there friend', s: 0.6, e: 2.1 }],
};

describe('caption_clip_from_transcript replaces overlapping captions', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let ctx: ToolContext;

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    const assets = new AssetStore(database);
    const transcriptStore = new TranscriptStore(database);
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
    transcriptStore.put('asset-1', transcript);
    const project = projects.insert({
      id: 'replace-project', title: 'Replace', format: '9:16', fps: 30, duration: 12, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [{ id: 'clip-a', assetId: 'asset-1', start: 4, in: 0, out: 3, speed: 1 }] },
        { id: 'captions', kind: 'caption', clips: [
          { id: 'hand-written', start: 4.5, in: 0, out: 1, text: 'STALE' },
          { id: 'cap-other-clip-1', start: 10, in: 0, out: 1, text: 'ELSEWHERE' },
        ] },
      ],
    });
    ctx = { projectId: project.id, projects, assets, transcripts, insights, styleDoc: null, currentVersion: project.version };
  });

  afterEach(() => database.close());

  it('removes every caption intersecting the clip span, keeps the rest, and says so', async () => {
    const tool = createToolRegistry().find((candidate) => candidate.name === 'caption_clip_from_transcript');
    const result = await tool?.execute(ctx, { clipId: 'clip-a', wordsPerChunk: 2 });
    expect(result).toMatchObject({ ok: true, removedClipIds: ['hand-written'] });
    expect((result as { notes: string[] }).notes.join(' ')).toMatch(/Removed 1 existing caption clip/);
    const captions = projects.get(ctx.projectId)?.tracks.find((track) => track.kind === 'caption')?.clips ?? [];
    expect(captions.map((caption) => caption.id)).toEqual(['cap-other-clip-1', 'cap-clip-a-1', 'cap-clip-a-2']);
    for (const [index, caption] of captions.slice(1).entries()) {
      const next = captions.slice(1)[index + 1];
      if (next) expect(next.start).toBeGreaterThanOrEqual(caption.start + caption.out - caption.in);
    }
  });
});

function dialogueLines(ass: string): string[] {
  return ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
}

describe('ASS overlap defence', () => {
  function project(clips: Project['tracks'][number]['clips']): Project {
    return {
      id: 'ass-overlap', title: 'ASS', format: '9:16', fps: 30, duration: 10, version: 0,
      tracks: [{ id: 'captions', kind: 'caption', clips }],
    };
  }

  it('clamps an overlapping event that shares a vertical anchor', () => {
    const style = { font: 'Montserrat' as const, size: 52, color: '#FFFFFF', position: 'bottom' as const, emphasis: 'bold' as const };
    const ass = generateAss(project([
      { id: 'cap-1', start: 0, in: 0, out: 2, text: 'FIRST', style },
      { id: 'cap-2', start: 1, in: 0, out: 2, text: 'SECOND', style },
    ]), 1080, 1920, { fontFamily: 'Montserrat', safeAreaBottomPct: 12 });
    expect(dialogueLines(ass)).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:01.00,Caption1,,0,0,0,,FIRST',
      'Dialogue: 0,0:00:01.00,0:00:03.00,Caption2,,0,0,0,,SECOND',
    ]);
  });

  it('leaves overlapping events at different vertical anchors alone', () => {
    const ass = generateAss(project([
      { id: 'cap-top', start: 0, in: 0, out: 2, text: 'TOP', style: {
        font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'top', emphasis: 'bold',
      } },
      { id: 'cap-bottom', start: 1, in: 0, out: 2, text: 'BOTTOM', style: {
        font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold',
      } },
      { id: 'cap-anchored', start: 1.5, in: 0, out: 2, text: 'ANCHORED', style: {
        font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'center', emphasis: 'bold', anchorPct: 62,
      } },
    ]), 1080, 1920, { fontFamily: 'Montserrat', safeAreaBottomPct: 12 });
    expect(dialogueLines(ass)).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:02.00,Caption1,,0,0,0,,TOP',
      'Dialogue: 0,0:00:01.00,0:00:03.00,Caption2,,0,0,0,,BOTTOM',
      'Dialogue: 0,0:00:01.50,0:00:03.50,Caption3,,0,0,0,,{\\pos(540,1190)}ANCHORED',
    ]);
  });
});

describe('filmstrip endpoint', () => {
  it('publishes a filmstrip url in asset metadata and 404s for unknown assets', async () => {
    const database = createDatabase(':memory:');
    new AssetStore(database).insert({
      id: 'strip', originalName: 'strip.mp4', mimeType: 'video/mp4', duration: 4,
      width: 1080, height: 1920, fps: 30, hasAudio: false,
      originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
    const app = await buildApp({ database });
    const metadata = await app.inject({ method: 'GET', url: '/assets/strip' });
    expect(metadata.json()).toMatchObject({ filmstripUrl: expect.stringContaining('/assets/strip/filmstrip.jpg') });
    const missing = await app.inject({ method: 'GET', url: '/assets/nope/filmstrip.jpg' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
