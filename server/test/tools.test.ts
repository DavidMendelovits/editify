import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATION_CATALOG, type Operation } from '@editify/shared';
import { createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { MockToolProvider } from '../src/agent/providers.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { DissectService } from '../src/services/dissect-service.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

// Keyed by the catalog: revert_run is client-only and has no tool.
const inputs: Record<(typeof OPERATION_CATALOG)[number], unknown> = {
  add_clip: { trackId: 'video-main', clip: { id: 'clip-new', assetId: 'asset-2', start: 4, in: 0, out: 2 } },
  remove_clip: { clipId: 'clip-a' },
  split_clip: { clipId: 'clip-a', at: 2, newClipId: 'clip-split' },
  trim_clip: { clipId: 'clip-a', in: 0.5, out: 3.5 },
  move_clip: { clipId: 'clip-a', start: 2 },
  reorder_clips: { trackId: 'video-main', clipIds: ['clip-b', 'clip-a'] },
  set_volume: { clipId: 'clip-a', volume: 0.5 },
  set_speed: { clipId: 'clip-a', speed: 1.25 },
  set_transform: { clipId: 'clip-a', transform: { scale: 1.2, x: 0, y: 0 } },
  set_overlay: { clipId: 'sticker-a', overlay: { x: 0.5, y: 0.3, width: 0.2, rotation: 15 } },
  set_transition: { clipId: 'clip-b', transition: { type: 'crossfade', duration: 0.4 } },
  add_caption: { trackId: 'captions', clip: { id: 'caption-new', start: 0, in: 0, out: 2, text: 'Hello' } },
  update_caption: { clipId: 'caption-a', text: 'Updated' },
  remove_caption: { clipId: 'caption-a' },
  ripple_delete_ranges: { trackId: 'video-main', ranges: [{ start: 1, end: 2 }] },
  set_clip_properties: { updates: [{ clipId: 'clip-a', speed: 1.1, start: 0 }] },
  set_format: { format: '1:1' },
  undo: {},
  redo: {},
};

describe('agent tool registry', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;
  let transcripts: TranscriptService;
  let insights: InsightService;
  let dissections: DissectService;

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
    dissections = new DissectService(database);
  });

  /**
   * A measured dissection, written straight to the cache table so
   * `getOrCreate` returns it without ever shelling out to ffmpeg.
   */
  function seedDissection(assetId: string, energyPeaks: number[]): void {
    assets.insert({
      id: assetId, originalName: `${assetId}.mp4`, mimeType: 'video/mp4', duration: 4,
      width: 1080, height: 1920, fps: 30, hasAudio: true,
      originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
    database.prepare('INSERT INTO dissections (asset_id, dissection_json, created_at) VALUES (?, ?, ?)').run(
      assetId,
      JSON.stringify({
        assetId, duration: 4, cuts: [], averageShotLength: 4, cutDensity: 0, tempoBpm: 120, loudnessLufs: -14,
        energy: { cellSeconds: 0.25, rmsDb: [] }, energyPeaks, overlayActivity: [],
        summary: 'seeded', generatedAt: new Date(0).toISOString(),
      }),
      new Date(0).toISOString(),
    );
  }

  /**
   * Library sound rows, written straight to the asset table so
   * `apply_style_packet` resolves them without ever synthesizing with ffmpeg.
   */
  function seedSounds(): void {
    for (const id of ['sound-music-drive', 'sound-music-dream', 'sound-pop-bubble', 'sound-whoosh-soft']) {
      assets.insert({
        id, originalName: `sfx-${id}.m4a`, mimeType: 'audio/mp4', duration: 2,
        width: 0, height: 0, fps: 0, hasAudio: true,
        originalPath: '/not/read.m4a', proxyPath: '/not/read.m4a', thumbnailPath: '/not/read.jpg',
        originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
      });
    }
  }

  afterEach(() => database.close());

  function context(type: Operation['type']): ToolContext {
    const project = projects.insert({
      id: `project-${type}`,
      title: 'Tool test',
      format: '9:16',
      fps: 30,
      duration: 5,
      version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [
          { id: 'clip-a', assetId: 'asset-1', start: 0, in: 0, out: 4, volume: 1, speed: 1 },
          { id: 'clip-b', assetId: 'asset-2', start: 4, in: 0, out: 1, volume: 1, speed: 1,
            transition: { type: 'crossfade', duration: 0.5 } },
        ] },
        { id: 'audio-main', kind: 'audio', clips: [] },
        { id: 'overlays', kind: 'overlay', clips: [
          { id: 'sticker-a', start: 0, in: 0, out: 2, text: '🔥', overlay: { x: 0.5, y: 0.35, width: 0.28, rotation: 0 } },
        ] },
        { id: 'captions', kind: 'caption', clips: [
          { id: 'caption-a', start: 0, in: 0, out: 2, text: 'Original' },
          { id: 'caption-b', start: 2, in: 0, out: 2, text: 'lower case line',
            style: { font: 'Montserrat', size: 64, color: '#EEEEEE', position: 'center', emphasis: 'bold',
              words: [{ w: 'lower', s: 2, e: 2.5 }, { w: 'case', s: 2.5, e: 3 }, { w: 'line', s: 3, e: 4 }] } },
        ] },
      ],
    });
    if (type === 'undo' || type === 'redo') {
      let changed = projects.applyOperations(project.id, [{ type: 'set_format', params: { format: '16:9' } }], 0);
      // Redo needs an undo standing in front of it.
      if (type === 'redo') changed = projects.applyOperations(project.id, [{ type: 'undo', params: {} }], changed.version);
      return { projectId: project.id, projects, assets, transcripts, insights, dissections, styleDoc: null, currentVersion: changed.version };
    }
    return { projectId: project.id, projects, assets, transcripts, insights, dissections, styleDoc: null, currentVersion: project.version };
  }

  it.each(OPERATION_CATALOG)('%s validates, applies, and bumps the live version', async (name) => {
    const tool = createToolRegistry().find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    expect(tool?.schema.safeParse(inputs[name]).success).toBe(true);
    const ctx = context(name);
    const before = ctx.currentVersion;
    const result = await tool?.execute(ctx, inputs[name]);
    expect(result).toMatchObject({ ok: true, version: before + 1 });
    expect(projects.get(ctx.projectId)?.version).toBe(before + 1);
  });

  it('returns operation errors as tool results without bumping version', async () => {
    const tool = createToolRegistry().find((candidate) => candidate.name === 'split_clip');
    const ctx = context('split_clip');
    const result = await tool?.execute(ctx, { clipId: 'clip-a', at: 99 });
    expect(result).toMatchObject({ ok: false });
    expect(projects.get(ctx.projectId)?.version).toBe(0);
  });

  it('returns zod errors as tool results without bumping version', async () => {
    const tool = createToolRegistry().find((candidate) => candidate.name === 'set_speed');
    const ctx = context('set_speed');
    const result = await tool?.execute(ctx, { clipId: 'clip-a', speed: 0 });
    expect(result).toMatchObject({ ok: false });
    expect(projects.get(ctx.projectId)?.version).toBe(0);
  });

  it('applies add_clips as one versioned batch and returns a structural delta', async () => {
    const ctx = context('set_format');
    const tool = createToolRegistry().find((candidate) => candidate.name === 'add_clips');
    const result = await tool?.execute(ctx, {
      trackId: 'video-main',
      clips: [
        { id: 'batch-1', start: 5, in: 0, out: 1 },
        { id: 'batch-2', start: 6, in: 0, out: 1 },
      ],
    });
    expect(result).toMatchObject({ ok: true, version: 1, removedClipIds: [], shifted: [] });
    expect((result as { changedClips: unknown[] }).changedClips).toHaveLength(2);
    expect(result).not.toHaveProperty('tracks');
    expect(projects.get(ctx.projectId)?.version).toBe(1);
  });

  it('cuts a clip on its energy peaks, skipping onsets too close to an edge or each other', async () => {
    const ctx = context('set_format');
    // clip-a covers timeline 0–4: 0.1 hugs the head, 1.2 trails 1.0, 3.95 hugs the tail.
    seedDissection('asset-1', [0.1, 1, 1.2, 2, 3, 3.95]);
    const tool = createToolRegistry().find((candidate) => candidate.name === 'cut_to_beats');
    const result = await tool?.execute(ctx, { clipId: 'clip-a' });
    expect(result).toMatchObject({ ok: true, version: 1, cutTimes: [1, 2, 3], removedClipIds: [] });
    const clips = projects.get(ctx.projectId)?.tracks.find((track) => track.id === 'video-main')?.clips ?? [];
    expect(clips.map((clip) => [clip.id, clip.start, clip.in, clip.out])).toEqual([
      ['clip-a', 0, 0, 1],
      ['clip-a-beat-1', 1, 1, 2],
      ['clip-a-beat-2', 2, 2, 3],
      ['clip-a-beat-3', 3, 3, 4],
      ['clip-b', 4, 0, 1],
    ]);
  });

  it('thins beats evenly to honour maxCuts', async () => {
    const ctx = context('set_format');
    seedDissection('asset-1', [1, 2, 3]);
    const tool = createToolRegistry().find((candidate) => candidate.name === 'cut_to_beats');
    const result = await tool?.execute(ctx, { clipId: 'clip-a', maxCuts: 2 });
    expect(result).toMatchObject({ ok: true, cutTimes: [1, 3] });
  });

  it('reports a missing asset instead of splitting', async () => {
    const ctx = context('set_format');
    const tool = createToolRegistry().find((candidate) => candidate.name === 'cut_to_beats');
    expect(await tool?.execute(ctx, { clipId: 'clip-a' })).toMatchObject({ ok: false });
    expect(projects.get(ctx.projectId)?.version).toBe(0);
  });

  it('lists the built-in style packets', async () => {
    const tool = createToolRegistry().find((candidate) => candidate.name === 'get_style_packets');
    const result = await tool?.execute(context('set_format'), {}) as Array<{ id: string }>;
    expect(result.map((packet) => packet.id)).toEqual(['daily-vlog', 'branded-explainer']);
  });

  it('sweeps the branded-explainer packet over captions, cuts, sound, and zoom in one batch', async () => {
    const ctx = context('set_format');
    seedSounds();
    const tool = createToolRegistry().find((candidate) => candidate.name === 'apply_style_packet');
    const result = await tool?.execute(ctx, { packetId: 'branded-explainer' }) as { ok: boolean; guidance: string[] };
    expect(result).toMatchObject({ ok: true, version: 1, removedClipIds: [] });

    const project = projects.get(ctx.projectId);
    const captions = project?.tracks.find((track) => track.id === 'captions')?.clips ?? [];
    expect(captions.map((caption) => caption.text)).toEqual(['ORIGINAL', 'LOWER CASE LINE']);
    // The merged style keeps the seeded karaoke timing — update_caption replaces
    // the whole style object, so a lost `words` array would show up right here.
    expect(captions[1]?.style).toEqual({
      font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'center', emphasis: 'highlight',
      sizePct: 4.6, anchorPct: 58, emphasisColor: '#FACC15', strokeColor: '#000000', strokePx: 4,
      words: [{ w: 'lower', s: 2, e: 2.5 }, { w: 'case', s: 2.5, e: 3 }, { w: 'line', s: 3, e: 4 }],
    });
    expect(captions[0]?.style).toMatchObject({ sizePct: 4.6, color: '#FFFFFF', emphasis: 'highlight' });

    const video = project?.tracks.find((track) => track.id === 'video-main')?.clips ?? [];
    // Packet transition is `cut`, so the seeded crossfade is cleared, not replaced.
    expect(video.map((clip) => clip.transition)).toEqual([undefined, undefined]);
    expect(video.map((clip) => clip.transformEnd)).toEqual([
      { scale: 1.1, x: 0, y: 0 }, { scale: 1.1, x: 0, y: 0 },
    ]);

    const audio = project?.tracks.find((track) => track.id === 'audio-main')?.clips ?? [];
    expect(audio.map((clip) => [clip.id, clip.assetId, clip.start, clip.out, clip.volume])).toEqual([
      ['music-bed-1', 'sound-music-drive', 0, 2, 0.15],
      ['music-bed-2', 'sound-music-drive', 2, 2, 0.15],
      ['music-bed-3', 'sound-music-drive', 4, 1, 0.15],
      ['sfx-cut-1', 'sound-pop-bubble', 4, 2, 0.5],
    ]);

    expect(result.guidance.some((line) => line.startsWith('Callouts (every-line'))).toBe(true);
    expect(result.guidance.some((line) => line.includes('caption_clip_from_transcript'))).toBe(true);
  });

  it('sets the daily-vlog crossfade and sparse punch-ins without uppercasing', async () => {
    const ctx = context('set_format');
    seedSounds();
    const tool = createToolRegistry().find((candidate) => candidate.name === 'apply_style_packet');
    const result = await tool?.execute(ctx, { packetId: 'daily-vlog' }) as { ok: boolean; guidance: string[] };
    expect(result).toMatchObject({ ok: true, version: 1 });

    const project = projects.get(ctx.projectId);
    const video = project?.tracks.find((track) => track.id === 'video-main')?.clips ?? [];
    expect(video.map((clip) => clip.transition)).toEqual([undefined, { type: 'crossfade', duration: 0.4 }]);
    // sparse == every third clip, so only clip-a takes the punch-in.
    expect(video.map((clip) => clip.transformEnd)).toEqual([{ scale: 1.06, x: 0, y: 0 }, undefined]);
    const captions = project?.tracks.find((track) => track.id === 'captions')?.clips ?? [];
    expect(captions.map((caption) => caption.text)).toEqual(['Original', 'lower case line']);
    expect(captions[1]?.style).toMatchObject({ sizePct: 3.6, anchorPct: 78, emphasis: 'none' });
    expect(captions[1]?.style?.emphasisColor).toBeUndefined();
    expect(result.guidance.some((line) => line.startsWith('B-roll (frequent'))).toBe(true);
  });

  it('sweeps an inline packet that is in no built-in table', async () => {
    const ctx = context('set_format');
    const tool = createToolRegistry().find((candidate) => candidate.name === 'apply_style_packet');
    const result = await tool?.execute(ctx, {
      packet: {
        id: 'profile-1', name: 'My style', description: 'Derived from the saved style profile.',
        typography: { sizePct: 5, color: '#FFFFFF', anchorPct: 40, emphasis: 'bold', uppercase: true, karaoke: false },
        colors: { accent: '#8B5CF6' },
        music: { soundId: null, volume: 0.2 },
        transition: { type: 'crossfade', duration: 0.6, soundId: null },
        zoom: { cadence: 'off', scale: 1.06 },
        callouts: { density: 'off' },
        broll: { density: 'off' },
        pacing: { targetShotSeconds: 1.2 },
      },
    }) as { ok: boolean; guidance: string[] };
    expect(result).toMatchObject({ ok: true, version: 1 });

    const project = projects.get(ctx.projectId);
    const captions = project?.tracks.find((track) => track.id === 'captions')?.clips ?? [];
    expect(captions.map((caption) => caption.text)).toEqual(['ORIGINAL', 'LOWER CASE LINE']);
    expect(captions[0]?.style).toMatchObject({ sizePct: 5, anchorPct: 40, emphasis: 'bold' });
    const video = project?.tracks.find((track) => track.id === 'video-main')?.clips ?? [];
    expect(video.map((clip) => clip.transition)).toEqual([undefined, { type: 'crossfade', duration: 0.6 }]);
    // 2.5s average against a 1.2s target — the pacing note is the derived half.
    expect(result.guidance.some((line) => line.startsWith('Pacing:'))).toBe(true);
  });

  it('rejects an empty input with the valid ids', async () => {
    const tool = createToolRegistry().find((candidate) => candidate.name === 'apply_style_packet');
    const result = await tool?.execute(context('set_format'), {}) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('daily-vlog, branded-explainer');
  });

  it('rejects an unknown packet id without touching the timeline', async () => {
    const ctx = context('set_format');
    const tool = createToolRegistry().find((candidate) => candidate.name === 'apply_style_packet');
    const result = await tool?.execute(ctx, { packetId: 'not-a-packet' }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('daily-vlog, branded-explainer');
    expect(projects.get(ctx.projectId)?.version).toBe(0);
  });
});
