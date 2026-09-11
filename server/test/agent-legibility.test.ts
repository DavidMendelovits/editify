import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSystem, runAgentLoop, summarizeAssets } from '../src/agent/loop.js';
import { MockToolProvider, type ToolProvider } from '../src/agent/providers.js';
import { createToolRegistry, describeProject, findTimelineIssues, formatZodError, type ToolContext } from '../src/agent/tools.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';
import { operationParamsSchemas } from '@editify/shared';

/**
 * What the agent sees is the product: these tests pin the shape of the system
 * prompt, the mutation receipts, and the error text the model has to recover
 * from, so a refactor cannot quietly make the editor harder to drive.
 */
describe('agent legibility', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;
  let ctx: ToolContext;

  function scripted(turns: Array<{ text?: string; toolCalls?: Array<{ name: string; input: unknown }> }>): ToolProvider {
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

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    assets = new AssetStore(database);
    const transcripts = new TranscriptService(new TranscriptStore(database), async () => {
      throw new Error('Whisper must not run in unit tests');
    }, async () => {
      throw new Error('ffmpeg must not run in unit tests');
    });
    const insights = new InsightService(new InsightStore(database), transcripts, async () => new MockToolProvider());
    assets.insert({
      id: 'asset-talk', originalName: 'talk.mp4', mimeType: 'video/mp4', duration: 12,
      width: 1080, height: 1920, fps: 30, hasAudio: true,
      originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
    assets.insert({
      id: 'asset-unlinked', originalName: 'other-project.mp4', mimeType: 'video/mp4', duration: 5,
      width: 1080, height: 1920, fps: 30, hasAudio: true,
      originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
    const project = projects.insert({
      id: 'legible', title: 'Legible', format: '9:16', fps: 30, duration: 8, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [
          { id: 'clip-a', assetId: 'asset-talk', start: 0, in: 0, out: 4 },
          { id: 'clip-b', assetId: 'asset-talk', start: 4, in: 4, out: 8 },
        ] },
        { id: 'audio-main', kind: 'audio', clips: [] },
        { id: 'captions', kind: 'caption', clips: [
          { id: 'cap-1', start: 0, in: 0, out: 2, text: 'Hello', style: {
            font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'bottom', emphasis: 'bold',
            words: [{ w: 'Hello', s: 0, e: 0.5 }],
          } },
        ] },
      ],
    });
    assets.link(project.id, 'asset-talk');
    ctx = { projectId: project.id, projects, assets, transcripts, insights, styleDoc: null, currentVersion: 0 };
  });

  afterEach(() => database.close());

  it('opens the turn with the units, the timeline, and the linked assets', () => {
    const project = projects.get(ctx.projectId);
    if (!project) throw new Error('project missing');
    const system = buildSystem(project, summarizeAssets(ctx), null);
    expect(system).toContain('start + (out - in) / speed');
    expect(system).toContain('video-main is the cut');
    // Every clip is there with its timeline span, so no read call is needed to plan.
    expect(system).toContain('"id":"clip-b","assetId":"asset-talk","start":4,"end":8,"in":4,"out":8');
    // Caption word timings collapse to a count; the style object is only flagged.
    expect(system).toContain('"wordTimings":1');
    expect(system).not.toContain('"words":[');
    // Only media linked to this project is offered.
    expect(system).toContain('"id":"asset-talk","name":"talk.mp4","kind":"video","duration":12');
    expect(system).not.toContain('asset-unlinked');
    expect(system).toContain('call get_project or list_assets only after an error');
  });

  it('describes a large project as a summary instead of a full timeline', () => {
    const project = projects.get(ctx.projectId);
    if (!project) throw new Error('project missing');
    const huge = {
      ...project,
      tracks: [{ id: 'video-main', kind: 'video' as const, clips: Array.from({ length: 200 }, (_unused, index) => ({
        id: `clip-${index}`, assetId: 'asset-talk', start: index, in: 0, out: 1,
      })) }],
    };
    const system = buildSystem(huge, summarizeAssets(ctx), null);
    expect(system).toContain('Call get_project and list_assets before editing');
    expect(system).toContain('"clipCount":200');
    expect(system).not.toContain('"id":"clip-150"');
  });

  it('reports gaps and overlaps on the video track, nowhere else', () => {
    const project = projects.get(ctx.projectId);
    if (!project) throw new Error('project missing');
    expect(findTimelineIssues(project)).toEqual([]);
    const gapped = {
      ...project,
      tracks: [
        { id: 'video-main', kind: 'video' as const, clips: [
          { id: 'a', assetId: 'asset-talk', start: 0, in: 0, out: 2 },
          { id: 'b', assetId: 'asset-talk', start: 3, in: 0, out: 2 },
          { id: 'c', assetId: 'asset-talk', start: 4, in: 0, out: 2 },
        ] },
        { id: 'audio-main', kind: 'audio' as const, clips: [
          { id: 'bed', assetId: 'asset-talk', start: 0, in: 0, out: 1 },
          { id: 'hit', assetId: 'asset-talk', start: 5, in: 0, out: 1 },
        ] },
      ],
    };
    expect(findTimelineIssues(gapped)).toEqual([
      { kind: 'gap', trackId: 'video-main', from: 2, to: 3 },
      { kind: 'overlap', trackId: 'video-main', from: 4, to: 5 },
    ]);
    expect(describeProject(gapped).issues).toHaveLength(2);
  });

  it('tells the agent about the gap a speed change just opened', async () => {
    const tool = createToolRegistry().find((candidate) => candidate.name === 'set_speed');
    const result = await tool?.execute(ctx, { clipId: 'clip-a', speed: 2 }) as { changedClips: unknown[]; duration: number; notes: string[] };
    expect(result.changedClips).toMatchObject([{ id: 'clip-a', start: 0, end: 2, speed: 2 }]);
    expect(result.duration).toBe(8);
    expect(result.notes.join(' ')).toContain('gap on video-main 2s to 4s');
    expect(result.notes.join(' ')).toContain('close_gaps');

    const closer = createToolRegistry().find((candidate) => candidate.name === 'close_gaps');
    const closed = await closer?.execute(ctx, { trackId: 'video-main' }) as { duration: number; notes: string[] };
    expect(closed.duration).toBe(6);
    expect(closed.notes.join(' ')).not.toContain('gap');
  });

  it('names the existing ids when a clip or track is unknown', async () => {
    const registry = createToolRegistry();
    const trim = registry.find((candidate) => candidate.name === 'trim_clip');
    const missingClip = await trim?.execute(ctx, { clipId: 'clip-z', in: 0, out: 1 }) as { ok: boolean; error: string };
    expect(missingClip.ok).toBe(false);
    expect(missingClip.error).toBe('Clip clip-z was not found. Existing clips: clip-a, clip-b, cap-1.');

    const gaps = registry.find((candidate) => candidate.name === 'close_gaps');
    const missingTrack = await gaps?.execute(ctx, { trackId: 'video' }) as { ok: boolean; error: string };
    expect(missingTrack.error).toBe('Track video was not found. Existing tracks: video-main (video), audio-main (audio), captions (caption).');
  });

  it('turns schema failures into one readable line per field', async () => {
    const parsed = operationParamsSchemas.set_clip_properties.safeParse({ updates: [{ clipId: 'clip-a', speed: 40, out: -1 }] });
    if (parsed.success) throw new Error('expected a validation failure');
    expect(formatZodError(parsed.error)).toBe(
      'Invalid input. updates.0.speed: Number must be less than or equal to 8; updates.0.out: Number must be greater than 0',
    );

    // The same wording reaches the model when the loop rejects a call up front.
    const response = await runAgentLoop(scripted([
      { toolCalls: [{ name: 'set_speed', input: { clipId: 'clip-a', speed: 'fast' } }] },
      { text: 'Stopping.' },
    ]), ctx, 'speed it up');
    expect(response.trace[0]?.ok).toBe(false);
    expect(response.trace[0]?.summary).toBe('Invalid input. speed: Expected number, received string');
  });
});
