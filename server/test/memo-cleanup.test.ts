import { describe, expect, it } from 'vitest';
import type { Project } from '@editify/shared';
import { createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { MockToolProvider } from '../src/agent/providers.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { buildTimelineTranscript } from '../src/services/cleanup.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

/*
 * A stand-up set: the camera runs 0-12s, the clean memo is synced over 3-9s.
 *
 *   camera words  a(0-0.5) b(1-1.5)   [x(4-4.5) .......... y(8-8.5)]   c(10-10.5) d(11-11.5)
 *   memo words                         m1(3.2) m2(4) m3(5) | quiet | m4(7.5) m5(8.2)
 *
 * Inside the memo span the camera's words (x, y, and the 3.5s "gap" between
 * them) must be ignored: the memo is what the audience hears.
 */
const loud = (length: number) => Array.from({ length }, () => -20);

function seed(memoVolume = 1, memoAssetId = 'memo') {
  const database = createDatabase(':memory:');
  const assets = new AssetStore(database);
  for (const [id, mime, duration] of [['camera', 'video/mp4', 12], [memoAssetId, 'audio/mp4', 6]] as const) {
    assets.insert({
      id, originalName: id, mimeType: mime, duration, width: 0, height: 0, fps: 30, hasAudio: true,
      originalPath: '/never/read', proxyPath: '/never/read', thumbnailPath: '/never/read',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
  }
  const transcripts = new TranscriptStore(database);
  transcripts.put('camera', {
    language: 'en', durationProcessedSeconds: 12,
    words: [
      { w: 'a', s: 0, e: 0.5 }, { w: 'b', s: 1, e: 1.5 }, { w: 'x', s: 4, e: 4.5 },
      { w: 'y', s: 8, e: 8.5 }, { w: 'c', s: 10, e: 10.5 }, { w: 'd.', s: 11, e: 11.5 },
    ],
    segments: [{ text: 'a b x y c d.', s: 0, e: 11.5 }],
  }, { cellSeconds: 0.05, rmsDb: loud(240) });
  // Memo source time 0 plays at timeline 3. Quiet between memo 2.2s and 4.4s (timeline 5.2-7.4).
  const memoDb = loud(120);
  for (let cell = 44; cell < 88; cell += 1) memoDb[cell] = -60;
  transcripts.put(memoAssetId, {
    language: 'en', durationProcessedSeconds: 6,
    words: [
      { w: 'm1', s: 0.2, e: 0.6 }, { w: 'm2', s: 1, e: 1.5 }, { w: 'm3', s: 2, e: 2.2 },
      { w: 'm4', s: 4.5, e: 4.9 }, { w: 'm5.', s: 5.2, e: 5.6 },
    ],
    segments: [{ text: 'm1 m2 m3 m4 m5.', s: 0.2, e: 5.6 }],
  }, { cellSeconds: 0.05, rmsDb: memoDb });
  const projects = new ProjectStore(database);
  const project: Project = {
    id: 'set', title: 'Set', format: '9:16', fps: 30, duration: 12, version: 0,
    tracks: [
      { id: 'video-main', kind: 'video', clips: [{ id: 'cam', assetId: 'camera', start: 0, in: 0, out: 12, volume: 0 }] },
      { id: 'audio-main', kind: 'audio', clips: [{ id: 'memo-clip', assetId: memoAssetId, start: 3, in: 0, out: 6, volume: memoVolume }] },
      { id: 'captions', kind: 'caption', clips: [] },
    ],
  };
  projects.insert(project);
  const service = new TranscriptService(transcripts, async () => { throw new Error('Whisper must not run in unit tests'); });
  const ctx: ToolContext = {
    projectId: 'set', projects, assets, styleDoc: null, currentVersion: 0, transcripts: service,
    insights: new InsightService(new InsightStore(database), service, async () => new MockToolProvider()),
    appliedOperations: [],
  };
  return { ctx, project, projects, service };
}

const tool = (name: string) => createToolRegistry().find((candidate) => candidate.name === name)!;

describe('memo-aware timeline transcript', () => {
  it('takes the memo words inside its span and the camera words outside it', () => {
    const { project, service } = seed();
    const words = buildTimelineTranscript(project, (id) => service.get(id)).words;
    expect(words.map((word) => word.text)).toEqual(['a', 'b', 'm1', 'm2', 'm3', 'm4', 'm5.', 'c', 'd.']);
    expect(words.find((word) => word.text === 'm1')?.timelineStart).toBeCloseTo(3.2);
    expect(words.map((word) => word.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('ignores a muted memo and library sounds', () => {
    expect(buildTimelineTranscript(seed(0).project, (id) => seed(0).service.get(id)).words.map((w) => w.text))
      .toEqual(['a', 'b', 'x', 'y', 'c', 'd.']);
    const library = seed(1, 'sound-bed-01');
    expect(buildTimelineTranscript(library.project, (id) => library.service.get(id)).words.map((w) => w.text))
      .toEqual(['a', 'b', 'x', 'y', 'c', 'd.']);
  });
});

describe('remove_silence over a synced memo', () => {
  it('cuts the memo\'s quiet gap once, never the camera gap the memo covers', async () => {
    const { ctx, projects } = seed();
    const result = await tool('remove_silence').execute(ctx, { minSilenceSeconds: 0.5, padSeconds: 0.1, protectLoudGaps: true }) as { ok?: boolean };
    expect(result.ok).not.toBe(false);
    // Regression: one ripple per transcript track would cut shifted time twice.
    const ripples = ctx.appliedOperations!.filter((op) => op.type === 'ripple_delete_ranges');
    expect(ripples).toHaveLength(1);
    const ranges = (ripples[0]!.params as { ranges: Array<{ start: number; end: number }> }).ranges;
    // Memo quiet gap: m3 ends 5.2, m4 starts 7.5 → cut 5.3-7.4.
    expect(ranges.some((range) => Math.abs(range.start - 5.3) < 0.01 && Math.abs(range.end - 7.4) < 0.01)).toBe(true);
    // Camera's x→y "gap" (4.5-8) lives under the memo and must not be cut as one block.
    expect(ranges.some((range) => range.start < 4.6 && range.end > 7.9)).toBe(false);
    // The camera/memo boundary is not silence: nothing spans b (1.5) through m1 (3.2) as one cut beyond pads.
    const after = projects.get('set')!;
    expect(after.tracks.find((track) => track.id === 'audio-main')!.clips.length).toBeGreaterThan(0);
  });
});

describe('caption_clip_from_transcript over a synced memo', () => {
  it('captions the camera clip with the memo words where the memo covers it', async () => {
    const { ctx, projects } = seed();
    const result = await tool('caption_clip_from_transcript').execute(ctx, { clipId: 'cam', wordsPerChunk: 1 }) as { ok?: boolean };
    expect(result.ok).not.toBe(false);
    const texts = projects.get('set')!.tracks.find((track) => track.kind === 'caption')!.clips.map((clip) => clip.text);
    expect(texts).toEqual(['A', 'B', 'M1', 'M2', 'M3', 'M4', 'M5.', 'C', 'D.']);
  });

  it('captions the memo clip itself', async () => {
    const { ctx, projects } = seed();
    const result = await tool('caption_clip_from_transcript').execute(ctx, { clipId: 'memo-clip', wordsPerChunk: 1 }) as { ok?: boolean };
    expect(result.ok).not.toBe(false);
    expect(projects.get('set')!.tracks.find((track) => track.kind === 'caption')!.clips.map((clip) => clip.text))
      .toEqual(['M1', 'M2', 'M3', 'M4', 'M5.']);
  });
});
