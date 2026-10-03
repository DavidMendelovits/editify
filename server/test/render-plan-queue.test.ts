import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@editify/shared';
import { AssetStore, type StoredAsset } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';

/*
 * RENDER_PLAN (plan P6, 7A + OV12): off, the queue runs legacy render.ts
 * exactly as before; on, it renders the shared RenderPlan, with every asset
 * resolved through the project and its owner (the schema's SECURITY note),
 * and QA measures without normalizing again.
 */
// Plan renders make their render directory: keep it out of server/data.
vi.hoisted(() => { process.env.EDITIFY_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/editify-plan-queue-${process.pid}`; });
const calls = vi.hoisted(() => ({ legacy: [] as unknown[][], plan: [] as unknown[][], qa: [] as unknown[][], unavailable: false }));
vi.mock('../src/media/render.js', () => ({
  renderProject: async (...args: unknown[]) => {
    calls.legacy.push(args);
    return `/renders/${String(args[2])}/output.mp4`;
  },
}));
vi.mock('../src/media/plan/render.js', () => {
  class PlanRenderUnavailableError extends Error {}
  return {
  PlanRenderUnavailableError,
  renderPlan: async (...args: unknown[]) => {
    calls.plan.push(args);
    if (calls.unavailable) throw new PlanRenderUnavailableError('this ffmpeg lacks the filters: lut1d');
    const out = args[2] as { outputPath: string };
    return { outputPath: out.outputPath, frames: 30, notes: ['Emoji sticker s was left out.'], loudness: { measuredLufs: -20, truePeakDb: -3, decision: { gainDb: 4, limit: true } }, elapsed: 1 };
  },
  };
});
vi.mock('../src/media/plan/media.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/media/plan/media.js')>()),
  probePlanMedia: async (path: string, kind: string) => ({
    path, info: { kind, width: 1080, height: 1920, duration: 10, hasAudio: true, fps: 30 },
    color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' }, orientation: 1, hasVideo: true, audioChannels: 2, audioLayout: 'stereo',
  }),
}));
vi.mock('../src/services/render-qa.js', () => ({
  runRenderQa: async (...args: unknown[]) => {
    calls.qa.push(args);
    return undefined;
  },
}));

const { RenderQueue } = await import('../src/services/render-queue.js');
const { renderProjectFromPlan } = await import('../src/media/plan/project.js');

let database: EditifyDatabase;
let projects: ProjectStore;
let assets: AssetStore;
let renders: RenderStore;

function storedAsset(id: string): Omit<StoredAsset, 'status'> {
  return {
    id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true,
    originalPath: `/media/${id}.mp4`, proxyPath: '', thumbnailPath: '', originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date().toISOString(),
  };
}

function projectWith(owner: string, assetId: string): Project {
  const project = projects.create({ title: 'Plan', format: '9:16', fps: 30 }, owner);
  const doc: Project = {
    ...project,
    duration: 2,
    tracks: project.tracks.map((track) => (track.kind === 'video' ? { ...track, clips: [{ id: 'clip', assetId, start: 0, in: 0, out: 2 }] } : track)),
  };
  database.prepare('UPDATE projects SET doc_json = ? WHERE id = ?').run(JSON.stringify(doc), project.id);
  return doc;
}

beforeEach(() => {
  database = createDatabase(':memory:');
  projects = new ProjectStore(database);
  assets = new AssetStore(database);
  renders = new RenderStore(database);
  calls.legacy.length = 0;
  calls.plan.length = 0;
  calls.qa.length = 0;
  calls.unavailable = false;
});
afterAll(() => rmSync(process.env.EDITIFY_DATA_DIR!, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.RENDER_PLAN;
  database.close();
});

describe('RENDER_PLAN flag', () => {
  it('runs legacy render.ts, unchanged, when the flag is off (the default)', async () => {
    assets.insert(storedAsset('a1'), 'alice');
    const project = projectWith('alice', 'a1');
    assets.link(project.id, 'a1');
    const render = new RenderQueue(renders, projects, assets).enqueue(project.id, '720p', 'hdr', 'normalize');
    await vi.waitFor(() => expect(renders.get(render.id)?.status).toBe('done'));
    expect(calls.plan).toEqual([]);
    expect(calls.legacy).toHaveLength(1);
    expect(calls.legacy[0]!.slice(1, 3)).toEqual(['720p', render.id]);
    expect(calls.legacy[0]![4]).toBe('hdr');
    // Legacy QA normalizes the file it was handed, as before.
    expect(calls.qa[0]![3]).toBe('normalize');
    expect(calls.qa[0]![4]).toBeUndefined();
  });

  it('renders the RenderPlan when the flag is on, and QA only measures', async () => {
    process.env.RENDER_PLAN = '1';
    assets.insert(storedAsset('a1'), 'alice');
    const project = projectWith('alice', 'a1');
    assets.link(project.id, 'a1');
    const render = new RenderQueue(renders, projects, assets).enqueue(project.id, '1080p', 'sdr', 'normalize');
    await vi.waitFor(() => expect(renders.get(render.id)?.status).toBe('done'));
    expect(calls.legacy).toEqual([]);
    expect(calls.plan).toHaveLength(1);
    const plan = calls.plan[0]![0] as { size: { w: number; h: number }; color: string; loudness: { targetLufs: number | null }; revision: number };
    expect(plan.size).toEqual({ w: 1080, h: 1920 });
    expect(plan.color).toBe('sdr');
    expect(plan.loudness.targetLufs).toBe(-16);
    expect(calls.qa[0]![3]).toBe('off');
    expect(calls.qa[0]![4]).toEqual({ normalized: { fromLufs: -20, gainDb: 4 }, notes: ['Emoji sticker s was left out.'] });
  });

  it('turns loudness off in the plan when the request does', async () => {
    process.env.RENDER_PLAN = 'true';
    assets.insert(storedAsset('a1'), 'alice');
    const project = projectWith('alice', 'a1');
    assets.link(project.id, 'a1');
    const render = new RenderQueue(renders, projects, assets).enqueue(project.id, '720p', 'sdr', 'off');
    await vi.waitFor(() => expect(renders.get(render.id)?.status).toBe('done'));
    expect((calls.plan[0]![0] as { loudness: { targetLufs: number | null } }).loudness.targetLufs).toBeNull();
  });

  it('falls back to the legacy render, with a QA note, when this server cannot run the plan render', async () => {
    process.env.RENDER_PLAN = '1';
    calls.unavailable = true;
    assets.insert(storedAsset('a1'), 'alice');
    const project = projectWith('alice', 'a1');
    assets.link(project.id, 'a1');
    const render = new RenderQueue(renders, projects, assets).enqueue(project.id, '720p', 'sdr', 'normalize');
    await vi.waitFor(() => expect(renders.get(render.id)?.status).toBe('done'));
    expect(calls.plan).toHaveLength(1);
    expect(calls.legacy).toHaveLength(1);
    // Legacy QA normalizes as it always has, and says why the plan render was not used.
    expect(calls.qa[0]![3]).toBe('normalize');
    expect(calls.qa[0]![4]).toEqual({ normalized: null, notes: ['Rendered with the legacy renderer: this ffmpeg lacks the filters: lut1d'] });
  });
});

describe('plan render asset scoping', () => {
  it("resolves only the owner's assets linked to the project", async () => {
    assets.insert(storedAsset('mine'), 'alice');
    assets.insert(storedAsset('theirs'), 'bob');
    const project = projectWith('alice', 'mine');
    assets.link(project.id, 'mine');
    await renderProjectFromPlan(project, '720p', 'r1', assets, { hdr: 'sdr', loudness: 'normalize', ownerId: 'alice' });
    const resolve = calls.plan[0]![1] as (ref: { id: string; kind: string }) => string | undefined;
    expect(resolve({ id: 'mine', kind: 'video' })).toBe('/media/mine.mp4');
    // A plan naming someone else's asset (even one wrongly linked) or an unlinked one of the owner's gets nothing.
    assets.link(project.id, 'theirs');
    expect(resolve({ id: 'theirs', kind: 'video' })).toBeUndefined();
    assets.insert(storedAsset('unlinked'), 'alice');
    expect(resolve({ id: 'unlinked', kind: 'video' })).toBeUndefined();
  });

  it("fails a project whose clip names an asset the owner cannot read", async () => {
    assets.insert(storedAsset('theirs'), 'bob');
    const project = projectWith('alice', 'theirs');
    assets.link(project.id, 'theirs');
    await expect(renderProjectFromPlan(project, '720p', 'r2', assets, { hdr: 'sdr', loudness: 'normalize', ownerId: 'alice' }))
      .rejects.toThrow('Asset theirs referenced by clip clip was not found');
    expect(calls.plan).toEqual([]);
  });
});
