import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { RenderQueue } from '../src/services/render-queue.js';

vi.mock('../src/media/render.js', () => ({
  renderProject: async (_project: unknown, _resolution: unknown, renderId: string) => `/renders/${renderId}/output.mp4`,
}));

describe('render queue recovery', () => {
  let database: EditifyDatabase;
  beforeEach(() => { database = createDatabase(':memory:'); });
  afterEach(() => database.close());

  it('re-queues renders stranded at queued/processing by a restart and finishes them', async () => {
    const projects = new ProjectStore(database);
    const renders = new RenderStore(database);
    const project = projects.create({ title: 'Recover', format: '9:16', fps: 30 });
    const waiting = renders.create(project.id, '720p');
    const stranded = renders.create(project.id, '1080p');
    renders.update(stranded.id, 'processing');
    const finished = renders.create(project.id, '720p');
    renders.update(finished.id, 'done', { outputPath: '/renders/done/output.mp4' });
    // create() stamps created_at at millisecond resolution, so same-tick rows tie;
    // spread them out to actually exercise the oldest-first ordering.
    const stamp = database.prepare('UPDATE renders SET created_at = ? WHERE id = ?');
    stamp.run('2020-01-01T00:00:00.000Z', waiting.id);
    stamp.run('2020-01-01T00:00:01.000Z', stranded.id);

    expect(renders.unfinished().map((record) => record.id)).toEqual([waiting.id, stranded.id]);
    new RenderQueue(renders, projects, new AssetStore(database)).recover();
    await vi.waitFor(() => {
      expect(renders.get(waiting.id)?.status).toBe('done');
      expect(renders.get(stranded.id)?.status).toBe('done');
    });
    expect(renders.unfinished()).toEqual([]);
  });
});
