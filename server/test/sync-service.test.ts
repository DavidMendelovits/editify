import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clip, Project } from '@editify/shared';
import { createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { MockToolProvider } from '../src/agent/providers.js';
import { AgentService } from '../src/agent/service.js';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { runProcess } from '../src/media/process.js';
import { InsightService } from '../src/services/insight-service.js';
import { SyncService } from '../src/services/sync-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

const WAV_RATE = 16000;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bursts and gaps of band-limited noise: attacks for the envelope, detail for the fine stage. */
function performance(seconds: number, seed: number): Float32Array {
  const next = random(seed);
  const samples = new Float32Array(Math.round(seconds * WAV_RATE));
  let cursor = 0;
  let low = 0;
  while (cursor < samples.length) {
    const burst = Math.round((0.08 + next() * 0.5) * WAV_RATE);
    const gap = Math.round((0.03 + next() * 0.4) * WAV_RATE);
    const level = 0.1 + next() * 0.5;
    for (let index = 0; index < burst && cursor + index < samples.length; index += 1) {
      low = 0.6 * low + 0.4 * (next() * 2 - 1);
      samples[cursor + index] = level * low;
    }
    cursor += burst + gap;
  }
  return samples;
}

async function writeWav(path: string, samples: Float32Array, gain = 1): Promise<void> {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample * gain)) * 32767), index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(WAV_RATE, 24); header.writeUInt32LE(WAV_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}

/** Memo rolls first; the camera starts this many seconds into the show. */
const CAMERA_STARTS = 7.25;
const MEMO_SECONDS = 40;
const VIDEO_SECONDS = 20;

let dir: string;
let videoPath: string;
let memoPath: string;
let strangerPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'editify-sync-'));
  const show = performance(MEMO_SECONDS, 21);
  const cameraWav = join(dir, 'camera.wav');
  const memoWav = join(dir, 'memo.wav');
  const strangerWav = join(dir, 'stranger.wav');
  await writeWav(cameraWav, show.subarray(Math.round(CAMERA_STARTS * WAV_RATE), Math.round((CAMERA_STARTS + VIDEO_SECONDS) * WAV_RATE)), 0.4);
  await writeWav(memoWav, show, 1.2);
  await writeWav(strangerWav, performance(MEMO_SECONDS, 99));
  videoPath = join(dir, 'standup.mp4');
  memoPath = join(dir, 'memo.m4a');
  strangerPath = join(dir, 'stranger.m4a');
  // AAC on both sides, like an iPhone video and a Voice Memos export: the
  // encoder's priming delay must not leak into the measured offset.
  await runProcess('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30:duration=${VIDEO_SECONDS}`, '-i', cameraWav,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', videoPath,
  ]);
  await runProcess('ffmpeg', ['-y', '-i', memoWav, '-c:a', 'aac', '-b:a', '64k', memoPath]);
  await runProcess('ffmpeg', ['-y', '-i', strangerWav, '-c:a', 'aac', '-b:a', '64k', strangerPath]);
}, 60000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('audio sync', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;
  let syncs: SyncService;

  function insertAsset(id: string, path: string, duration: number, video: boolean): void {
    assets.insert({
      id, originalName: `${id}`, mimeType: video ? 'video/mp4' : 'audio/mp4', duration,
      width: video ? 320 : 0, height: video ? 240 : 0, fps: video ? 30 : 0, hasAudio: true,
      originalPath: path, proxyPath: path, thumbnailPath: path,
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
  }

  /** A project with the stand-up video on the video track and a memo dropped at 0 on the audio track. */
  function setUp(videoClips: Array<Pick<Clip, 'id' | 'start' | 'in' | 'out'>>, memoAssetId = 'memo'): Project {
    const project = projects.create({ title: 'Set', format: '9:16', fps: 30 });
    return projects.applyOperations(project.id, [
      ...videoClips.map((clip) => ({ type: 'add_clip' as const, params: { trackId: 'video-main', clip: { ...clip, assetId: 'standup' } } })),
      { type: 'add_clip', params: { trackId: 'audio-main', clip: { id: 'memo-clip', assetId: memoAssetId, start: 0, in: 0, out: MEMO_SECONDS } } },
    ], project.version);
  }

  function memoPieces(project: Project): Clip[] {
    return project.tracks.filter((track) => track.kind === 'audio').flatMap((track) => track.clips)
      .sort((left, right) => left.start - right.start);
  }

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    assets = new AssetStore(database);
    syncs = new SyncService(assets);
    insertAsset('standup', videoPath, VIDEO_SECONDS, true);
    insertAsset('memo', memoPath, MEMO_SECONDS, false);
    insertAsset('stranger', strangerPath, MEMO_SECONDS, false);
  });

  it('lines the memo up under the video and trims it to the shot', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: VIDEO_SECONDS }]);
    const plan = await syncs.plan(project, { audioClipId: 'memo-clip' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.videoClipId).toBe('shot');
    expect(plan.offsetSec).toBeCloseTo(-CAMERA_STARTS, 2);
    expect(plan.speed).toBe(1);
    expect(plan.pieces).toBe(1);

    const synced = projects.applyOperations(project.id, plan.ops, project.version);
    const [memo] = memoPieces(synced);
    expect(memo?.start).toBe(0);
    // Within 2ms: a frame is 33ms, and lips read as late somewhere past 45.
    expect(Math.abs((memo?.in ?? 0) - CAMERA_STARTS)).toBeLessThan(0.002);
    expect(Math.abs((memo?.out ?? 0) - (CAMERA_STARTS + VIDEO_SECONDS))).toBeLessThan(0.002);
    // Levels are the user's call: the camera audio is untouched.
    const video = synced.tracks.find((track) => track.kind === 'video')?.clips[0];
    expect(video?.volume).toBeUndefined();
  }, 30000);

  it('gives every shot cut from the footage its own matching piece', async () => {
    // A 4s cut already taken out of the middle.
    const project = setUp([
      { id: 'shot-a', start: 0, in: 0, out: 8 },
      { id: 'shot-b', start: 8, in: 12, out: VIDEO_SECONDS },
    ]);
    const plan = await syncs.plan(project, { audioClipId: 'memo-clip' });
    expect(plan.ok && plan.pieces).toBe(2);
    if (!plan.ok) return;
    const synced = projects.applyOperations(project.id, plan.ops, project.version);
    const pieces = memoPieces(synced);
    expect(pieces.map((clip) => clip.id)).toEqual(['memo-clip', 'memo-clip-sync-1']);
    expect(pieces.map((clip) => clip.start)).toEqual([0, 8]);
    expect(Math.abs((pieces[0]?.in ?? 0) - CAMERA_STARTS)).toBeLessThan(0.002);
    expect(Math.abs((pieces[1]?.in ?? 0) - (CAMERA_STARTS + 12))).toBeLessThan(0.002);
  }, 30000);

  it('refuses to move a memo from a different night', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: VIDEO_SECONDS }], 'stranger');
    const plan = await syncs.plan(project, { audioClipId: 'memo-clip' });
    expect(plan.ok).toBe(false);
  }, 30000);

  it('applies through the agent tool as one undoable step', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: VIDEO_SECONDS }]);
    const transcripts = new TranscriptService(new TranscriptStore(database), async () => {
      throw new Error('Whisper must not run in unit tests');
    });
    const ctx: ToolContext = {
      projectId: project.id, projects, assets, styleDoc: null, currentVersion: project.version,
      transcripts, insights: new InsightService(new InsightStore(database), transcripts, async () => new MockToolProvider()),
      syncs, appliedOperations: [],
    };
    const tool = createToolRegistry().find((candidate) => candidate.name === 'sync_audio');
    const result = await tool?.execute(ctx, { audioClipId: 'memo-clip' }) as { ok?: boolean; offsetSec?: number };
    expect(result.ok).not.toBe(false);
    expect(result.offsetSec).toBeCloseTo(-CAMERA_STARTS, 2);
    expect(ctx.appliedOperations).toHaveLength(1);
    const synced = projects.get(project.id) as Project;
    expect(memoPieces(synced)[0]?.in).toBeGreaterThan(7);
    const undone = projects.applyOperations(project.id, [{ type: 'undo', params: {} }], synced.version);
    expect(memoPieces(undone)[0]?.in).toBe(0);
  }, 30000);

  it('syncs from a plain chat message with no model key', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: VIDEO_SECONDS }]);
    const transcripts = new TranscriptService(new TranscriptStore(database), async () => {
      throw new Error('Whisper must not run in unit tests');
    });
    const agent = new AgentService(async () => new MockToolProvider());
    const response = await agent.edit({
      projectId: project.id, projects, assets, styleDoc: null, currentVersion: project.version,
      transcripts, insights: new InsightService(new InsightStore(database), transcripts, async () => new MockToolProvider()),
      syncs,
    }, 'sync the voice memo to the video');
    expect(response.reply).toContain('7.25s before the camera');
    expect(Math.abs((memoPieces(response.doc)[0]?.in ?? 0) - CAMERA_STARTS)).toBeLessThan(0.002);
  }, 30000);

  it('measures over HTTP without touching the project', async () => {
    const project = setUp([{ id: 'shot', start: 0, in: 0, out: VIDEO_SECONDS }]);
    const app = await buildApp({ database });
    const response = await app.inject({ method: 'GET', url: `/projects/${project.id}/sync?audioClipId=memo-clip&k=query-token` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, videoClipId: 'shot', pieces: 1 });
    expect(projects.get(project.id)?.version).toBe(project.version);
    const missing = await app.inject({ method: 'GET', url: `/projects/${project.id}/sync?audioClipId=nope` });
    expect(missing.json()).toMatchObject({ ok: false });
    await app.close();
  }, 30000);
});
