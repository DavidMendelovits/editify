import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDITING_PRESETS, presetSchema } from '@editify/shared';
import { MockToolProvider } from '../src/agent/providers.js';
import {
  buildTimelineTranscript,
  chunkTranscriptForClip,
  createToolRegistry,
  planWordCutRanges,
  type ToolContext,
} from '../src/agent/tools.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

describe('Wave 2 presets and planners', () => {
  it('parses all five presets and honors preset word and duration caps', () => {
    expect(EDITING_PRESETS).toHaveLength(5);
    EDITING_PRESETS.forEach((preset) => expect(presetSchema.safeParse(preset).success).toBe(true));
    const preset = EDITING_PRESETS.find((candidate) => candidate.name === 'vlog_montage') as (typeof EDITING_PRESETS)[number];
    const words = Array.from({ length: 8 }, (_, index) => ({ w: `word${index}`, s: index * 0.7, e: index * 0.7 + 0.3 }));
    const chunks = chunkTranscriptForClip(words, { start: 0, in: 0, out: 8, speed: 1 }, {
      wordsPerChunk: preset.captions.wordsPerChunk.target,
      maxWordsPerChunk: preset.captions.wordsPerChunk.max,
      minDurationSec: preset.captions.chunkDurationSec.min,
      maxDurationSec: preset.captions.chunkDurationSec.max,
      maxCharsPerSecond: preset.captions.maxCharsPerSecond,
    });
    expect(chunks.every((chunk) => chunk.words.length <= preset.captions.wordsPerChunk.max)).toBe(true);
    expect(chunks.every((chunk) => chunk.sourceEnd - chunk.sourceStart <= preset.captions.chunkDurationSec.max)).toBe(true);
  });

  it('retains half the configured word gap on both sides, merges runs, and clamps boundaries', () => {
    const ranges = planWordCutRanges([
      { start: 0.02, end: 0.2, selected: true },
      { start: 0.25, end: 0.45, selected: true },
      { start: 0.6, end: 0.8, selected: false },
      { start: 1, end: 1.2, selected: true },
      { start: 1.3, end: 1.98, selected: true },
    ], 0, 2, 150);
    expect(ranges).toEqual([{ start: 0, end: 0.525 }, { start: 0.925, end: 2 }]);
    expect(ranges.reduce((sum, range) => sum + range.end - range.start, 0)).toBeCloseTo(1.6);
  });
});

describe('Wave 2 timeline tools', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;
  let transcriptStore: TranscriptStore;
  let transcripts: TranscriptService;
  let ctx: ToolContext;

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    assets = new AssetStore(database);
    transcriptStore = new TranscriptStore(database);
    transcripts = new TranscriptService(transcriptStore, async () => { throw new Error('Whisper must not run'); }, async () => {
      throw new Error('ffmpeg must not run');
    });
    const insights = new InsightService(new InsightStore(database), transcripts, new MockToolProvider());
    assets.insert({
      id: 'speech', originalName: 'speech.mp4', mimeType: 'video/mp4', duration: 5,
      width: 1920, height: 1080, fps: 30, hasAudio: true,
      originalPath: '/never/read', proxyPath: '/never/read', thumbnailPath: '/never/read',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', createdAt: new Date(0).toISOString(),
    });
    ctx = { projectId: '', projects, assets, transcripts, insights, styleDoc: null, currentVersion: 0 };
  });

  afterEach(() => database.close());

  it('maps a timeline transcript through multiple clip in/out/speed transforms', () => {
    transcriptStore.put('speech', {
      language: 'en', durationProcessedSeconds: 5,
      words: [{ w: 'zero', s: 0, e: 0.2 }, { w: 'one', s: 1, e: 1.2 }, { w: 'two', s: 2, e: 2.2 }],
      segments: [{ text: 'zero one two', s: 0, e: 2.3 }],
    });
    const project = projects.insert({
      id: 'mapping', title: 'Mapping', format: '9:16', fps: 30, duration: 6, version: 0,
      tracks: [{ id: 'video-main', kind: 'video', clips: [
        { id: 'first', assetId: 'speech', start: 0, in: 1, out: 3, speed: 2 },
        { id: 'second', assetId: 'speech', start: 5, in: 0, out: 2, speed: 1 },
      ] }],
    });
    const result = buildTimelineTranscript(project, (assetId) => transcripts.get(assetId));
    expect(result.rows).toEqual([[0, 'one', 0], [1, 'two', 0.5], [2, 'zero', 5], [3, 'one', 6]]);
    expect(result.segments[0]?.slice(0, 3)).toEqual([0, 'one two', 0]);
    expect(result.segments[0]?.[3]).toBeCloseTo(0.6);
    expect(result.segments[1]?.slice(0, 3)).toEqual([2, 'zero one', 5]);
    expect(result.segments[1]?.[3]).toBeCloseTo(6.2);
  });

  it('cuts a quiet gap but protects a loud reaction using synthetic energy only', async () => {
    const rmsDb = Array.from({ length: 60 }, () => -20);
    for (let index = 4; index < 24; index += 1) rmsDb[index] = -50;
    transcriptStore.put('speech', {
      language: 'en', durationProcessedSeconds: 3,
      words: [
        { w: 'a', s: 0, e: 0.2 }, { w: 'b', s: 1.2, e: 1.4 }, { w: 'c', s: 2.4, e: 2.6 },
      ],
      segments: [{ text: 'a b c', s: 0, e: 2.6 }],
    }, { cellSeconds: 0.05, rmsDb });
    const project = projects.insert({
      id: 'silence', title: 'Silence', format: '9:16', fps: 30, duration: 3, version: 0,
      tracks: [{ id: 'video-main', kind: 'video', clips: [{ id: 'clip', assetId: 'speech', start: 0, in: 0, out: 3 }] }],
    });
    ctx.projectId = project.id;
    const tool = createToolRegistry().find((candidate) => candidate.name === 'remove_silence');
    const result = await tool?.execute(ctx, { minSilenceSeconds: 0.5, padSeconds: 0.1, protectLoudGaps: true });
    expect(result).toMatchObject({ ok: true, gapsCut: 1, gapsProtected: 1 });
    expect((result as { removedSec: number }).removedSec).toBeCloseTo(0.8);
    expect(projects.get(project.id)?.duration).toBeCloseTo(2.2);
  });

  it('closes speed-created gaps before generating aligned captions', async () => {
    transcriptStore.put('speech', {
      language: 'en', durationProcessedSeconds: 4,
      words: [{ w: 'first', s: 0.2, e: 0.5 }, { w: 'second', s: 2.2, e: 2.5 }],
      segments: [{ text: 'first second', s: 0.2, e: 2.5 }],
    });
    const project = projects.insert({
      id: 'gaps', title: 'Gaps', format: '9:16', fps: 30, duration: 4, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [{ id: 'clip', assetId: 'speech', start: 0, in: 0, out: 4 }] },
        { id: 'captions', kind: 'caption', clips: [] },
      ],
    });
    ctx.projectId = project.id;
    const registry = createToolRegistry();
    await registry.find((tool) => tool.name === 'split_clips')?.execute(ctx, { cuts: [{ clipId: 'clip', at: 2, newClipId: 'clip-2' }] });
    await registry.find((tool) => tool.name === 'set_clip_properties')?.execute(ctx, { updates: [{ clipId: 'clip', speed: 2 }] });
    await registry.find((tool) => tool.name === 'close_gaps')?.execute(ctx, { trackId: 'video-main' });
    const packed = projects.get(project.id);
    const video = packed?.tracks.find((track) => track.kind === 'video')?.clips ?? [];
    const first = video[0];
    const second = video[1];
    expect(first && second ? first.start + (first.out - first.in) / (first.speed ?? 1) : -1).toBeCloseTo(second?.start ?? -2);
    for (const clip of video) {
      await registry.find((tool) => tool.name === 'caption_clip_from_transcript')?.execute(ctx, { clipId: clip.id, wordsPerChunk: 1 });
    }
    const captions = projects.get(project.id)?.tracks.find((track) => track.kind === 'caption')?.clips ?? [];
    expect(captions).toHaveLength(2);
    expect(captions[0]?.start).toBeCloseTo(0.1);
    expect(captions[1]?.start).toBeCloseTo(1.2);
  });
});
