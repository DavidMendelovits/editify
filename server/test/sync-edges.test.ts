import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, Project } from '@editify/shared';
import { createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { MockToolProvider } from '../src/agent/providers.js';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { SYNC_SAMPLE_RATE, SyncError, measureSync, type SyncMeasurement } from '../src/media/sync.js';
import { InsightService } from '../src/services/insight-service.js';
import { SyncService } from '../src/services/sync-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

/**
 * The service's branches, with the measurement stubbed: what it does with an
 * answer is independent of how the answer was found, and needs no ffmpeg.
 */
function measurement(overrides: Partial<SyncMeasurement> = {}): SyncMeasurement {
  return { lag: -7.25, anchor: 0, rate: 1, coarseRatio: 10, fineScore: 20, confident: true, overlapSec: 20, windows: [], ...overrides };
}

describe('sync service edges', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;
  let calls: number;
  let answer: () => Promise<SyncMeasurement>;
  let syncs: SyncService;

  function insertAsset(id: string, duration: number, options: { video?: boolean; hasAudio?: boolean } = {}): void {
    const video = options.video ?? false;
    assets.insert({
      id, originalName: id, mimeType: video ? 'video/mp4' : 'audio/mp4', duration,
      width: video ? 320 : 0, height: video ? 240 : 0, fps: video ? 30 : 0, hasAudio: options.hasAudio ?? true,
      originalPath: `/nowhere/${id}`, proxyPath: `/nowhere/${id}`, thumbnailPath: `/nowhere/${id}`,
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
  }

  function setUp(
    videoClips: Array<Pick<Clip, 'id' | 'start' | 'in' | 'out'> & { speed?: number; assetId?: string }>,
    memo: { assetId?: string; out?: number } = {},
  ): Project {
    const project = projects.create({ title: 'Set', format: '9:16', fps: 30 });
    return projects.applyOperations(project.id, [
      ...videoClips.map((clip) => ({ type: 'add_clip' as const, params: { trackId: 'video-main', clip: { assetId: 'standup', ...clip } } })),
      { type: 'add_clip', params: { trackId: 'audio-main', clip: { id: 'memo-clip', assetId: memo.assetId ?? 'memo', start: 0, in: 0, out: memo.out ?? 40 } } },
    ], project.version);
  }

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    assets = new AssetStore(database);
    calls = 0;
    answer = async () => measurement();
    syncs = new SyncService(assets, async () => { calls += 1; return await answer(); });
    insertAsset('standup', 20, { video: true });
    insertAsset('mute-cam', 20, { video: true, hasAudio: false });
    insertAsset('memo', 40);
    insertAsset('silent-memo', 40, { hasAudio: false });
    insertAsset('short-memo', 10);
  });

  it('refuses clips it cannot measure, without measuring', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: 20 }]);
    expect(await syncs.plan(project, { audioClipId: 'nope' })).toMatchObject({ ok: false, error: expect.stringContaining('not on the timeline') });
    expect(await syncs.plan(project, { audioClipId: 'shot' })).toMatchObject({ ok: false, error: expect.stringContaining('Only a clip on the audio track') });
    expect(await syncs.plan(project, { audioClipId: 'memo-clip', videoClipId: 'ghost' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('That video clip is not on the timeline') });

    const silent = setUp([{ id: 'shot', start: 0, in: 0, out: 20 }], { assetId: 'silent-memo' });
    expect(await syncs.plan(silent, { audioClipId: 'memo-clip' })).toMatchObject({ ok: false, error: expect.stringContaining('no audio to sync') });
    expect(calls).toBe(0);
  });

  it('needs a video clip with its own sound, and not the memo\'s own asset', async () => {
    const mute = setUp([{ id: 'shot', start: 0, in: 0, out: 20, assetId: 'mute-cam' }]);
    expect(await syncs.plan(mute, { audioClipId: 'memo-clip' })).toMatchObject({ ok: false, error: expect.stringContaining('no video clip with its own sound') });
    expect(await syncs.plan(mute, { audioClipId: 'memo-clip', videoClipId: 'shot' })).toMatchObject({ ok: false, error: expect.stringContaining('no sound of its own') });

    // The video's soundtrack dropped on the audio track is not a second recording.
    const own = setUp([{ id: 'shot', start: 0, in: 0, out: 20 }], { assetId: 'standup', out: 20 });
    expect(await syncs.plan(own, { audioClipId: 'memo-clip' })).toMatchObject({ ok: false, error: expect.stringContaining('no video clip with its own sound') });
    expect(await syncs.plan(own, { audioClipId: 'memo-clip', videoClipId: 'shot' })).toMatchObject({ ok: false, error: expect.stringContaining('own soundtrack') });
    expect(calls).toBe(0);
  });

  it('skips sped-up shots and shots the memo never heard, and fails when none are left', async () => {
    answer = async () => measurement({ lag: 0 });
    const project = setUp([
      { id: 'fast', start: 0, in: 0, out: 4, speed: 2 },
      { id: 'heard', start: 2, in: 0, out: 8 },
      { id: 'after', start: 10, in: 12, out: 20 },
    ], { assetId: 'short-memo', out: 10 });
    const plan = await syncs.plan(project, { audioClipId: 'memo-clip', videoClipId: 'heard' });
    expect(plan).toMatchObject({ ok: true, pieces: 1 });
    if (!plan.ok) return;
    expect(plan.notes).toEqual([
      expect.stringContaining('Skipped fast: it plays at 2×'),
      expect.stringContaining('Skipped after: the memo was not recording'),
    ]);
    expect(plan.ops).toHaveLength(1);

    const none = setUp([{ id: 'after', start: 0, in: 12, out: 20 }], { assetId: 'short-memo', out: 10 });
    expect(await syncs.plan(none, { audioClipId: 'memo-clip' })).toMatchObject({ ok: false, error: expect.stringContaining('does not overlap') });
  });

  it('starts the piece partway into the shot when the memo rolled late', async () => {
    answer = async () => measurement({ lag: 5 });
    const project = setUp([{ id: 'shot', start: 3, in: 0, out: 20 }]);
    const plan = await syncs.plan(project, { audioClipId: 'memo-clip' });
    expect(plan).toMatchObject({ ok: true, offsetSec: 5, speed: 1, pieces: 1 });
    if (!plan.ok) return;
    const synced = projects.applyOperations(project.id, plan.ops, project.version);
    const memo = synced.tracks.find((track) => track.kind === 'audio')?.clips[0];
    expect(memo).toMatchObject({ start: 8, in: 0, out: 15 });
  });

  it('plays a drifting memo at the corrected speed and says so', async () => {
    answer = async () => measurement({ lag: -7.25, anchor: 10, rate: 1 + 60e-6, driftSec: 0.036, fineScore: 12.34 });
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: 20 }]);
    const plan = await syncs.plan(project, { audioClipId: 'memo-clip' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.speed).toBe(1.00006);
    expect(plan.driftMs).toBe(36);
    expect(plan.confidence).toBe(12.3);
    expect(plan.offsetSec).toBeCloseTo(10 - 17.25 / (1 + 60e-6), 5);
    expect(plan.notes.at(-1)).toContain('drift 36ms apart');
    expect(plan.ops[0]).toMatchObject({ type: 'set_clip_properties', params: { updates: [{ clipId: 'memo-clip', speed: 1.00006 }] } });
  });

  it('reuses a measurement, forgets a failed one, and refuses an unconfident one', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: 20 }]);
    await syncs.plan(project, { audioClipId: 'memo-clip' });
    await syncs.plan(project, { audioClipId: 'memo-clip' });
    expect(calls).toBe(1);

    const fresh = new SyncService(assets, async () => { calls += 1; return await answer(); });
    calls = 0;
    answer = async () => { throw new SyncError('One of the recordings is silent'); };
    expect(await fresh.plan(project, { audioClipId: 'memo-clip' })).toEqual({ ok: false, error: 'One of the recordings is silent' });
    answer = async () => measurement({ confident: false });
    expect(await fresh.plan(project, { audioClipId: 'memo-clip' })).toMatchObject({ ok: false, error: expect.stringContaining('Could not find where') });
    expect(calls).toBe(2);

    // Anything that is not a sync verdict (ffmpeg missing, a bad file) is a real error.
    const broken = new SyncService(assets, async () => { throw new Error('ffmpeg exited with 1'); });
    await expect(broken.plan(project, { audioClipId: 'memo-clip' })).rejects.toThrow('ffmpeg exited with 1');

    // At most 16 measurements are kept, oldest out first.
    answer = async () => measurement();
    calls = 0;
    const withMemo = (assetId: string): Project => ({
      ...project,
      tracks: project.tracks.map((track) => (track.kind === 'audio'
        ? { ...track, clips: track.clips.map((clip) => ({ ...clip, assetId })) }
        : track)),
    });
    for (let index = 0; index < 17; index += 1) {
      insertAsset(`m${index}`, 40);
      await fresh.plan(withMemo(`m${index}`), { audioClipId: 'memo-clip' });
    }
    expect(calls).toBe(17);
    await fresh.plan(withMemo('m16'), { audioClipId: 'memo-clip' });
    expect(calls).toBe(17);
    await fresh.plan(withMemo('m0'), { audioClipId: 'memo-clip' });
    expect(calls).toBe(18);
  });

  it('reports sync as unavailable to the agent, and 404s an unknown project over HTTP', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: 20 }]);
    const transcripts = new TranscriptService(new TranscriptStore(database), async () => {
      throw new Error('Whisper must not run in unit tests');
    });
    const ctx: ToolContext = {
      projectId: project.id, projects, assets, styleDoc: null, currentVersion: project.version,
      transcripts, insights: new InsightService(new InsightStore(database), transcripts, async () => new MockToolProvider()),
      appliedOperations: [],
    };
    const tool = createToolRegistry().find((candidate) => candidate.name === 'sync_audio');
    expect(await tool?.execute(ctx, { audioClipId: 'memo-clip' })).toEqual({ ok: false, error: 'Audio sync is not available' });
    expect(await tool?.execute(ctx, { audioClipId: '' })).toMatchObject({ ok: false });
    expect(ctx.appliedOperations).toHaveLength(0);

    const app = await buildApp({ database });
    const missing = await app.inject({ method: 'GET', url: '/projects/no-such-project/sync?audioClipId=memo-clip' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('re-syncing replaces the pieces a previous sync made instead of stacking them', async () => {
    let project = setUp([
      { id: 'shot-a', start: 0, in: 0, out: 8 },
      { id: 'shot-b', start: 8, in: 12, out: 20 },
    ]);
    for (let round = 0; round < 3; round += 1) {
      const plan = await syncs.plan(project, { audioClipId: round === 2 ? 'memo-clip-sync-1' : 'memo-clip' });
      if (!plan.ok) throw new Error(plan.error);
      project = projects.applyOperations(project.id, plan.ops, plan.version);
      const audio = project.tracks.find((track) => track.kind === 'audio')?.clips ?? [];
      // The regression: every sync used to add another full set, doubling the memo under shot B.
      expect(audio.map((clip) => clip.id).sort()).toEqual(['memo-clip', 'memo-clip-sync-1']);
    }
  });

  it('reports the version it planned against, so a stale plan fails instead of misplacing the memo', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: 20 }]);
    const plan = await syncs.plan(project, { audioClipId: 'memo-clip' });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.version).toBe(project.version);
    const moved = projects.applyOperations(project.id, [{ type: 'move_clip', params: { clipId: 'shot', start: 10 } }], project.version);
    expect(() => projects.applyOperations(project.id, plan.ops, plan.version)).toThrow();
    expect(moved.version).toBeGreaterThan(plan.version);
  });

  it('refuses recordings too long to measure safely, before decoding anything', async () => {
    insertAsset('marathon', 4 * 60 * 60);
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: 20 }], { assetId: 'marathon' });
    expect(await syncs.plan(project, { audioClipId: 'memo-clip' })).toMatchObject({ ok: false, error: expect.stringContaining('up to 3 hours') });
    expect(calls).toBe(0);
  });

  it('runs one measurement at a time and turns away a burst past the queue', async () => {
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const slow = new SyncService(assets, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
      return measurement();
    });
    const memos = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    for (const id of memos) insertAsset(id, 40);
    const plans = memos.map((id) => slow.plan(setUp([{ id: 'shot', start: 0, in: 0, out: 20 }], { assetId: id }), { audioClipId: 'memo-clip' }));
    // Let the busy ones settle, then drain the queue one job at a time.
    await new Promise((resolve) => setImmediate(resolve));
    while (release.length) {
      release.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const results = await Promise.all(plans);
    expect(peak).toBe(1);
    expect(results.filter((result) => result.ok)).toHaveLength(4);
    expect(results.filter((result) => !result.ok && result.error.includes('busy'))).toHaveLength(2);
  });

  it('refuses a sync that would not fit in one batch of operations', async () => {
    insertAsset('long-cam', 400, { video: true });
    insertAsset('long-memo', 400);
    answer = async () => measurement({ lag: 0 });
    const shots = Array.from({ length: 120 }, (_, index) => ({ id: `s${index}`, start: index * 3, in: index * 3, out: index * 3 + 2, assetId: 'long-cam' }));
    const project = setUp(shots, { assetId: 'long-memo', out: 400 });
    expect(await syncs.plan(project, { audioClipId: 'memo-clip' })).toMatchObject({ ok: false, error: expect.stringContaining('120 shots') });
  });
});

describe('measureSync on a short clip', () => {
  it('skips the fine stage when the overlap cannot hold a window', () => {
    // 0.5s of clicks: long enough for an envelope, too short for a 4096-sample window plus search room.
    const memo = new Float32Array(Math.round(0.5 * SYNC_SAMPLE_RATE));
    for (let at = 400; at < memo.length; at += 1300) memo.fill(0.5, at, at + 200);
    const result = measureSync(memo.slice(), memo);
    expect(result.windows).toHaveLength(0);
    expect(result.fineScore).toBe(0);
    expect(result.rate).toBe(1);
    expect(result.driftSec).toBeUndefined();
    expect(result.lag).toBe(0);
  });
});
