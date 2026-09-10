import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Project } from '@editify/shared';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';

let database: EditifyDatabase;
let app: FastifyInstance;

beforeEach(async () => {
  database = createDatabase(':memory:');
  app = await buildApp({ database });
});

afterEach(async () => {
  await app.close();
});

async function createProject(title: string): Promise<Project> {
  const response = await app.inject({ method: 'POST', url: '/projects', payload: { title, format: '9:16', fps: 30 } });
  expect(response.statusCode).toBe(201);
  return response.json() as Project;
}

describe('DELETE /projects/:id', () => {
  it('removes the project, 404s the second time, and leaves shared media alone', async () => {
    const doomed = await createProject('Doomed cut');
    const keeper = await createProject('Keeper cut');

    // One asset linked to both projects — the shared-media case.
    const assets = new AssetStore(database);
    assets.insert({
      id: 'asset-shared', originalName: 'clip.mp4', mimeType: 'video/mp4', duration: 4,
      width: 1080, height: 1920, fps: 30, hasAudio: true, createdAt: new Date().toISOString(),
      originalPath: '/tmp/clip.mp4', proxyPath: '/tmp/clip-proxy.mp4', thumbnailPath: '/tmp/clip.jpg',
      originalUrl: '/assets/asset-shared/original', proxyUrl: '/assets/asset-shared/proxy',
      thumbnailUrl: '/assets/asset-shared/thumb', filmstripUrl: '/assets/asset-shared/filmstrip',
    });
    assets.link(doomed.id, 'asset-shared');
    assets.link(keeper.id, 'asset-shared');

    const deleted = await app.inject({ method: 'DELETE', url: `/projects/${doomed.id}` });
    expect(deleted.statusCode).toBe(204);

    const listed = (await app.inject({ url: '/projects' })).json() as Project[];
    expect(listed.map((project) => project.id)).toEqual([keeper.id]);
    expect((await app.inject({ url: `/projects/${doomed.id}` })).statusCode).toBe(404);

    // A second delete has nothing left to remove.
    expect((await app.inject({ method: 'DELETE', url: `/projects/${doomed.id}` })).statusCode).toBe(404);

    // The asset survives and is still attached to the surviving project.
    expect(assets.get('asset-shared')).toBeDefined();
    expect(assets.listForProject(keeper.id).map((asset) => asset.id)).toEqual(['asset-shared']);
  });
});
