import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, RenderQa } from '@editify/shared';
import { createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { MockToolProvider } from '../src/agent/providers.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { TranscriptStore, type TranscriptWord } from '../src/db/transcript-store.js';
import { runProcess } from '../src/media/process.js';
import { FaceService, type FaceTrack } from '../src/services/face-service.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

/** Take 1 of a line, a restart, take 2 run straight into the next line, then a closing line. */
const RAW_WORDS: TranscriptWord[] = [
  { w: 'Launches', s: 1, e: 1.4 }, { w: 'fail.', s: 1.45, e: 1.9 },
  { w: 'okay,', s: 3, e: 3.3 }, { w: 'again.', s: 3.35, e: 3.7 },
  { w: 'Launches', s: 5, e: 5.4 }, { w: 'fail.', s: 5.45, e: 5.9 },
  { w: 'Here', s: 6.2, e: 6.5 }, { w: 'is', s: 6.55, e: 6.7 }, { w: 'why.', s: 6.75, e: 7.1 },
  { w: 'Thanks.', s: 12, e: 12.5 },
];

describe('reel tools', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;
  let transcripts: TranscriptService;
  let insights: InsightService;
  let faceRuns: number;

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    assets = new AssetStore(database);
    transcripts = new TranscriptService(new TranscriptStore(database), async () => {
      throw new Error('Whisper must not run in unit tests');
    }, async () => {
      throw new Error('ffmpeg must not run in unit tests');
    });
    insights = new InsightService(new InsightStore(database), transcripts, async () => new MockToolProvider());
    faceRuns = 0;
    for (const [id, duration] of [['raw', 20], ['outro', 2]] as const) {
      assets.insert({
        id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration, width: 1080, height: 1920, fps: 30, hasAudio: true,
        originalPath: `/not/${id}.mp4`, proxyPath: '/not/proxy.mp4', thumbnailPath: '/not/thumb.jpg',
        originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
      });
    }
    new TranscriptStore(database).put('raw', { language: 'en', durationProcessedSeconds: 20, words: RAW_WORDS, segments: [] });
  });

  afterEach(() => database.close());

  function seedProject(): Project {
    return projects.insert({
      id: 'reel', title: 'Reel', format: '9:16', fps: 30, duration: 22, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [
          { id: 'raw-1', assetId: 'raw', start: 0, in: 0, out: 20 },
          { id: 'outro-1', assetId: 'outro', start: 20, in: 0, out: 2 },
        ] },
        { id: 'audio-main', kind: 'audio', clips: [] },
        { id: 'captions', kind: 'caption', clips: [
          { id: 'cap-raw-1-1', start: 1, in: 0, out: 1, text: 'LAUNCHES FAIL.',
            style: { font: 'Montserrat', size: 64, color: '#FFFF00', position: 'bottom', emphasis: 'bold', words: [{ w: 'LAUNCHES', s: 1, e: 1.4 }] } },
          { id: 'cap-outro', start: 20.5, in: 0, out: 1, text: 'BYE' },
        ] },
      ],
    });
  }

  function context(extra: Partial<ToolContext> = {}): ToolContext {
    const project = projects.get('reel') ?? seedProject();
    return {
      projectId: project.id, projects, assets, styleDoc: null, currentVersion: project.version,
      transcripts, insights, appliedOperations: [], ...extra,
    };
  }

  function tool(name: string) {
    const found = createToolRegistry().find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  }

  it('maps the takes, drops the restart, and suggests the cut', async () => {
    const result = await tool('get_take_map').execute(context(), { assetId: 'raw' }) as {
      sentences: Array<[number, number, number, string, string]>;
      takes: Array<{ start: number; end: number; sentences: number[] }>;
    };
    expect(result.sentences.map((row) => row[4])).toEqual(['retake', 'restart', '', '', '']);
    expect(result.takes).toEqual([
      { start: 4.88, end: 7.35, sentences: [2, 3], text: 'Launches fail. Here is why.' },
      { start: 11.88, end: 12.75, sentences: [4], text: 'Thanks.' },
    ]);
  });

  it('assembles the takes, closes up later clips and captions, and recaptions in the old look', async () => {
    const ctx = context();
    const result = await tool('assemble_takes').execute(ctx, {
      clipId: 'raw-1', takes: [{ start: 4.9, end: 7.2 }, { start: 11.9, end: 12.6 }],
    }) as { ok: boolean; takes: Array<{ clipId: string; in: number; out: number }>; captionsAdded: number; notes: string[] };
    expect(result.ok).toBe(true);
    expect(result.takes).toEqual([
      { clipId: 'take-1', in: 4.88, out: 7.35 },
      { clipId: 'take-2', in: 11.88, out: 12.75 },
    ]);
    const project = projects.get('reel') as Project;
    const video = [...(project.tracks.find((track) => track.id === 'video-main')?.clips ?? [])].sort((left, right) => left.start - right.start);
    expect(video.map((clip) => [clip.id, clip.start, clip.in, clip.out])).toEqual([
      ['take-1', 0, 4.88, 7.35],
      ['take-2', expect.closeTo(2.47, 6), 11.88, 12.75],
      ['outro-1', expect.closeTo(3.34, 6), 0, 2],
    ]);
    const captions = project.tracks.find((track) => track.id === 'captions')?.clips ?? [];
    expect(captions.find((clip) => clip.id === 'cap-outro')?.start).toBeCloseTo(3.84, 6);
    expect(captions.some((clip) => clip.id === 'cap-raw-1-1')).toBe(false);
    expect(result.captionsAdded).toBeGreaterThan(0);
    const regenerated = captions.filter((clip) => clip.id.startsWith('cap-take-'));
    expect(regenerated.map((clip) => clip.text)).toEqual(['LAUNCHES FAIL. HERE', 'IS WHY.', 'THANKS.']);
    // The old caption colour carries over; its anchor is recomputed for the safe area.
    expect(regenerated.every((clip) => clip.style?.color === '#FFFF00' && clip.style.anchorPct !== undefined)).toBe(true);
  });

  it('refuses a take with no words in it rather than cutting blind', async () => {
    const result = await tool('assemble_takes').execute(context(), { clipId: 'raw-1', takes: [{ start: 15, end: 18 }] });
    expect(result).toMatchObject({ ok: false });
    expect(projects.get('reel')?.version).toBe(0);
  });

  it('places captions off a tracked face and records the delivery platform', async () => {
    const face: FaceTrack = { fps: 5, width: 1080, height: 1920, samples: Array.from({ length: 111 }, (_unused, index) => [index * 0.2, 0.2, 0.45, 0.3, 0.7]) };
    const faces = new FaceService(database, async () => {
      faceRuns += 1;
      return face;
    });
    const ctx = context({ faces });
    const project = projects.get('reel') as Project;
    projects.applyOperations('reel', [{ type: 'update_caption', params: {
      clipId: 'cap-outro', start: 5, style: { font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'center', emphasis: 'bold', anchorPct: 35, sizePct: 4 },
    } }], project.version);
    ctx.currentVersion = (projects.get('reel') as Project).version;
    const result = await tool('place_captions').execute(ctx, { platform: 'tiktok' }) as {
      ok: boolean; platform: string; moved: Array<{ clipId: string; reason: string; toPct: number }>;
    };
    expect(result).toMatchObject({ ok: true, platform: 'TikTok' });
    expect(result.moved.find((placement) => placement.clipId === 'cap-outro')).toMatchObject({ reason: 'below-face' });
    const after = projects.get('reel') as Project;
    expect(after.platform).toBe('tiktok');
    const outro = after.tracks.find((track) => track.id === 'captions')?.clips.find((clip) => clip.id === 'cap-outro');
    expect(outro?.style?.anchorPct).toBeGreaterThan(45);
    // Each of the two sources is tracked once, then read from the cache.
    expect(faceRuns).toBe(2);
    await tool('place_captions').execute(ctx, {});
    expect(faceRuns).toBe(2);
  });

  describe('with measured sound', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'editify-mix-'));
      const hit = join(directory, 'hit.wav');
      await runProcess('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=f=90:d=0.5:sample_rate=48000', '-af', 'volume=-3dB', hit]);
      assets.insert({
        id: 'sound-impact-test', originalName: 'hit.wav', mimeType: 'audio/wav', duration: 0.5, width: 0, height: 0, fps: 0, hasAudio: true,
        originalPath: hit, proxyPath: hit, thumbnailPath: hit,
        originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
      });
      // Voice energy rides on the transcript, the way import stores it.
      new TranscriptStore(database).put('raw', { language: 'en', durationProcessedSeconds: 20, words: RAW_WORDS, segments: [] },
        { cellSeconds: 0.05, rmsDb: Array.from({ length: 400 }, () => -22) });
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('checks the hit against the voice and fixes its volume on request', async () => {
      const ctx = context();
      const base = projects.get('reel') as Project;
      projects.applyOperations('reel', [{ type: 'add_clip', params: {
        trackId: 'audio-main', clip: { id: 'boom', assetId: 'sound-impact-test', start: 2, in: 0, out: 0.5 },
      } }], base.version);
      ctx.currentVersion = (projects.get('reel') as Project).version;
      const report = await tool('check_mix').execute(ctx, {}) as { readOnly: boolean; hits: Array<{ verdict: string; suggestedVolume: number }> };
      expect(report.readOnly).toBe(true);
      expect(report.hits[0]).toMatchObject({ verdict: 'loud' });
      const fixed = await tool('check_mix').execute(ctx, { fix: true }) as { ok: boolean; rebalanced: number; warnings: string[] };
      expect(fixed).toMatchObject({ ok: true, rebalanced: 1 });
      const boom = (projects.get('reel') as Project).tracks.find((track) => track.id === 'audio-main')?.clips[0];
      expect(boom?.volume).toBe(report.hits[0]?.suggestedVolume);
      expect(fixed.warnings.filter((line) => line.startsWith('boom'))).toEqual([]);
    }, 30_000);
  });

  it('reads back the latest export QA', async () => {
    const renders = new RenderStore(database);
    const ctx = context({ renders });
    expect(await tool('get_render_qa').execute(ctx, {})).toMatchObject({ ok: false });
    const render = renders.create('reel', '1080p');
    const qa: RenderQa = {
      targetLufs: -16, loudnessLufs: -16.2, truePeakDb: -1.4, normalized: { fromLufs: -24, gainDb: 8 },
      deadAir: [], mix: null, contactSheet: true, warnings: [], checkedAt: new Date(0).toISOString(),
    };
    renders.setQa(render.id, qa);
    renders.update(render.id, 'done', { outputPath: '/not/output.mp4' });
    const result = await tool('get_render_qa').execute(ctx, {}) as { renderId: string; qa: RenderQa; contactSheetUrl: string };
    expect(result.renderId).toBe(render.id);
    expect(result.qa).toEqual(qa);
    expect(result.contactSheetUrl).toMatch(new RegExp(`/renders/${render.id}/contact.jpg$`));
  });
});
