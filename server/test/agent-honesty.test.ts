import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/agent/loop.js';
import { MockToolProvider, createProvider, parseCliTurn, type ToolProvider } from '../src/agent/providers.js';
import { createToolRegistry, type ToolContext } from '../src/agent/tools.js';
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
    { w: 'hello', s: 0.1, e: 0.4 },
    { w: 'there', s: 0.5, e: 0.9 },
    { w: 'friend', s: 1.1, e: 1.6 },
    { w: 'again', s: 1.8, e: 2.4 },
  ],
  segments: [{ text: 'Hello there, friend again!', s: 0.1, e: 2.4 }],
};

function scriptedProvider(turns: Array<{ text?: string; toolCalls?: Array<{ name: string; input: unknown }> }>): ToolProvider {
  let index = 0;
  return {
    name: 'mock',
    async runTurn() {
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return {
        ...(turn?.text ? { text: turn.text } : {}),
        toolCalls: (turn?.toolCalls ?? []).map((call, i) => ({ id: `t${index}-${i}`, ...call })),
      };
    },
    async completeText() { return ''; },
  };
}

describe('agent honesty and batching', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let transcriptStore: TranscriptStore;
  let ctx: ToolContext;

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    const assets = new AssetStore(database);
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
      id: 'honesty-project', title: 'Honesty', format: '9:16', fps: 30, duration: 6, version: 0,
      tracks: [{ id: 'video-main', kind: 'video', clips: [
        { id: 'clip-a', assetId: 'asset-1', start: 0, in: 0, out: 3 },
        { id: 'clip-b', assetId: 'asset-1', start: 3, in: 0, out: 3 },
      ] }],
    });
    ctx = { projectId: project.id, projects, assets, transcripts, insights, styleDoc: null, currentVersion: 0 };
  });

  afterEach(() => database.close());

  it('corrects a final reply that claims edits when zero ops were applied', async () => {
    const provider = scriptedProvider([{ text: 'Done! I trimmed all the clips and tightened the pacing.' }]);
    const response = await runAgentLoop(provider, ctx, 'trim everything');
    expect(response.opsApplied).toHaveLength(0);
    expect(response.reply).toContain('no edits were actually applied');
  });

  it('never fabricates success for an empty reply', async () => {
    const silent = await runAgentLoop(scriptedProvider([{}]), ctx, 'trim everything');
    expect(silent.reply).toContain('didn’t make any changes');

    const edited = await runAgentLoop(scriptedProvider([
      { toolCalls: [{ name: 'set_volume', input: { clipId: 'clip-a', volume: 0.5 } }] },
      {},
    ]), ctx, 'quieter please');
    expect(edited.opsApplied).toHaveLength(1);
    expect(edited.reply).toContain('1 edit applied');
  });

  it('treats an operation with no effect as no edit at all', async () => {
    // Establish the value first, so the second identical set_volume changes nothing.
    await runAgentLoop(scriptedProvider([
      { toolCalls: [{ name: 'set_volume', input: { clipId: 'clip-a', volume: 0.5 } }] },
      {},
    ]), ctx, 'quieter please');
    const settledVersion = projects.get(ctx.projectId)?.version;

    const response = await runAgentLoop(scriptedProvider([
      { toolCalls: [{ name: 'set_volume', input: { clipId: 'clip-a', volume: 0.5 } }] },
      { text: 'Done! I adjusted the volume for you.' },
    ]), ctx, 'quieter please');
    expect(projects.get(ctx.projectId)?.version).toBe(settledVersion);
    expect(response.opsApplied).toHaveLength(0);
    expect(response.reply).toContain('no edits were actually applied');
  });

  it('flags a no-op beside a real edit as a partial result', async () => {
    await runAgentLoop(scriptedProvider([
      { toolCalls: [{ name: 'set_volume', input: { clipId: 'clip-a', volume: 0.5 } }] },
      {},
    ]), ctx, 'quieter please');

    const response = await runAgentLoop(scriptedProvider([
      { toolCalls: [
        { name: 'set_volume', input: { clipId: 'clip-a', volume: 0.5 } },
        { name: 'set_format', input: { format: '16:9' } },
      ] },
      { text: 'Done — I adjusted the audio and changed the format.' },
    ]), ctx, 'quieter and widescreen');
    expect(response.opsApplied).toHaveLength(1);
    expect(response.opsApplied[0]?.type).toBe('set_format');
    expect(response.reply).toContain('(Partial: set_volume made no change');
    expect(response.doc.format).toBe('16:9');
  });

  it('leaves an honest question-answer reply alone', async () => {
    const response = await runAgentLoop(scriptedProvider([{ text: 'The project has two clips of three seconds each.' }]), ctx, 'what is on the timeline?');
    expect(response.reply).toBe('The project has two clips of three seconds each.');
  });

  it('batch-trims many clips in one set_clip_properties call', async () => {
    const tool = createToolRegistry().find((candidate) => candidate.name === 'set_clip_properties');
    const result = await tool?.execute(ctx, { updates: [
      { clipId: 'clip-a', in: 0.5, out: 2.5 },
      { clipId: 'clip-b', out: 2 },
    ] });
    expect(result).toMatchObject({ ok: true, version: 1 });
    const clips = projects.get(ctx.projectId)?.tracks[0]?.clips ?? [];
    expect(clips[0]).toMatchObject({ in: 0.5, out: 2.5 });
    expect(clips[1]).toMatchObject({ in: 0, out: 2 });
  });

  it('captions many clips in one caption_clip_from_transcript call', async () => {
    transcriptStore.put('asset-1', transcript);
    const tool = createToolRegistry().find((candidate) => candidate.name === 'caption_clip_from_transcript');
    const result = await tool?.execute(ctx, { clipIds: ['clip-a', 'clip-b'], wordsPerChunk: 2 }) as {
      ok: boolean; captionsAdded: number; results: Array<{ clipId: string; ok: boolean }>;
    };
    expect(result.ok).toBe(true);
    expect(result.captionsAdded).toBeGreaterThanOrEqual(4);
    expect(result.results.map((entry) => entry.clipId)).toEqual(['clip-a', 'clip-b']);
    const captions = projects.get(ctx.projectId)?.tracks.find((track) => track.kind === 'caption')?.clips ?? [];
    expect(captions.some((caption) => caption.id.startsWith('cap-clip-a-'))).toBe(true);
    expect(captions.some((caption) => caption.id.startsWith('cap-clip-b-'))).toBe(true);
    const failing = await tool?.execute(ctx, { clipId: 'clip-a', clipIds: ['clip-b'] });
    expect(failing).toMatchObject({ ok: false });
  });

  it('accepts snake_case tool_calls from a drifting CLI model', () => {
    const turn = parseCliTurn('{"text":"on it","tool_calls":[{"name":"get_project","input":{}}]}');
    expect(turn.toolCalls).toEqual([{ id: 'cli-0', name: 'get_project', input: {} }]);
  });

  it('refuses to build a key-based provider without its key', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createProvider('anthropic')).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
