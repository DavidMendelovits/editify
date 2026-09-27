import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Project } from '@editify/shared';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore, type RenderRecord } from '../src/db/render-store.js';
import { RenderQueue } from '../src/services/render-queue.js';

const rendered = vi.hoisted(() => [] as Array<{ resolution: string; version: number }>);
vi.mock('../src/media/render.js', () => ({
  renderProject: async (project: { version: number }, resolution: string, renderId: string) => {
    rendered.push({ resolution, version: project.version });
    return `/renders/${renderId}/output.mp4`;
  },
}));

let database: EditifyDatabase;
beforeEach(() => {
  database = createDatabase(':memory:');
  rendered.length = 0;
});
afterEach(() => database.close());

describe('POST /projects/:id/render', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp({ database }); });
  afterEach(async () => { await app.close(); });

  async function createProject(title: string): Promise<Project> {
    const response = await app.inject({ method: 'POST', url: '/projects', payload: { title, format: '9:16', fps: 30 } });
    return response.json() as Project;
  }

  it('exports a 4K request at 1080p and reports that resolution', async () => {
    const project = await createProject('Clamp');
    const response = await app.inject({ method: 'POST', url: `/projects/${project.id}/render`, payload: { resolution: '4k' } });
    expect(response.statusCode).toBe(202);
    const render = response.json() as RenderRecord;
    expect(render.resolution).toBe('1080p');

    await vi.waitFor(async () => {
      const polled = (await app.inject({ url: `/renders/${render.id}` })).json() as RenderRecord;
      expect(polled.status).toBe('done');
      expect(polled.resolution).toBe('1080p');
    });
    expect(rendered).toEqual([{ resolution: '1080p', version: 0 }]);
  });

  it('leaves 720p and 1080p requests alone', async () => {
    const project = await createProject('Keep');
    for (const resolution of ['720p', '1080p'] as const) {
      const response = await app.inject({ method: 'POST', url: `/projects/${project.id}/render`, payload: { resolution } });
      expect((response.json() as RenderRecord).resolution).toBe(resolution);
    }
  });
});

describe('render project version', () => {
  it('records the version the render read when it started', async () => {
    const projects = new ProjectStore(database);
    const renders = new RenderStore(database);
    const project = projects.create({ title: 'Versioned', format: '9:16', fps: 30 });
    projects.applyOperations(project.id, [{ type: 'set_format', params: { format: '16:9' } }], 0);

    const queue = new RenderQueue(renders, projects, new AssetStore(database));
    const render = queue.enqueue(project.id, '720p');
    await vi.waitFor(() => expect(renders.get(render.id)?.status).toBe('done'));

    expect(rendered).toEqual([{ resolution: '720p', version: 1 }]);
    expect(renders.get(render.id)?.projectVersion).toBe(1);
  });

  it('leaves rows written without a version as NULL', () => {
    const projects = new ProjectStore(database);
    const renders = new RenderStore(database);
    const project = projects.create({ title: 'Legacy', format: '9:16', fps: 30 });
    const legacy = renders.create(project.id, '1080p');
    renders.update(legacy.id, 'done', { outputPath: '/renders/legacy/output.mp4' });
    expect(renders.get(legacy.id)).not.toHaveProperty('projectVersion');
    const row = database.prepare('SELECT project_version FROM renders WHERE id = ?').get(legacy.id) as { project_version: number | null };
    expect(row.project_version).toBeNull();
  });
});
