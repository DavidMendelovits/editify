import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATION_CATALOG, type Operation } from '@editify/shared';
import { createToolRegistry, type ToolContext } from '../src/agent/tools.js';
import { MockToolProvider } from '../src/agent/providers.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

const inputs: Record<Operation['type'], unknown> = {
  add_clip: { trackId: 'video-main', clip: { id: 'clip-new', assetId: 'asset-2', start: 4, in: 0, out: 2 } },
  remove_clip: { clipId: 'clip-a' },
  split_clip: { clipId: 'clip-a', at: 2, newClipId: 'clip-split' },
  trim_clip: { clipId: 'clip-a', in: 0.5, out: 3.5 },
  move_clip: { clipId: 'clip-a', start: 2 },
  reorder_clips: { trackId: 'video-main', clipIds: ['clip-b', 'clip-a'] },
  set_volume: { clipId: 'clip-a', volume: 0.5 },
  set_speed: { clipId: 'clip-a', speed: 1.25 },
  set_transform: { clipId: 'clip-a', transform: { scale: 1.2, x: 0, y: 0 } },
  add_caption: { trackId: 'captions', clip: { id: 'caption-new', start: 0, in: 0, out: 2, text: 'Hello' } },
  update_caption: { clipId: 'caption-a', text: 'Updated' },
  remove_caption: { clipId: 'caption-a' },
  ripple_delete_ranges: { trackId: 'video-main', ranges: [{ start: 1, end: 2 }] },
  set_clip_properties: { updates: [{ clipId: 'clip-a', speed: 1.1, start: 0 }] },
  set_format: { format: '1:1' },
  undo: {},
};

describe('agent tool registry', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;
  let transcripts: TranscriptService;
  let insights: InsightService;

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    assets = new AssetStore(database);
    transcripts = new TranscriptService(new TranscriptStore(database), async () => {
      throw new Error('Whisper must not run in unit tests');
    }, async () => {
      throw new Error('ffmpeg must not run in unit tests');
    });
    insights = new InsightService(new InsightStore(database), transcripts, () => new MockToolProvider());
  });

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
          { id: 'clip-b', assetId: 'asset-2', start: 4, in: 0, out: 1, volume: 1, speed: 1 },
        ] },
        { id: 'audio-main', kind: 'audio', clips: [] },
        { id: 'captions', kind: 'caption', clips: [
          { id: 'caption-a', start: 0, in: 0, out: 2, text: 'Original' },
        ] },
      ],
    });
    if (type === 'undo') {
      const changed = projects.applyOperations(project.id, [{ type: 'set_format', params: { format: '16:9' } }], 0);
      return { projectId: project.id, projects, assets, transcripts, insights, styleDoc: null, currentVersion: changed.version };
    }
    return { projectId: project.id, projects, assets, transcripts, insights, styleDoc: null, currentVersion: project.version };
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
});
