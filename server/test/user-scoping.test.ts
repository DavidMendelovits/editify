import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/database.js';
import { AssetStore } from '../src/db/asset-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';

function stores() {
  const database = createDatabase(':memory:');
  return { projects: new ProjectStore(database), assets: new AssetStore(database), renders: new RenderStore(database) };
}

const media = (id: string) => ({
  id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1, width: 10, height: 10,
  fps: 30, hasAudio: false, originalPath: '/x', proxyPath: '/x', thumbnailPath: '/x',
  originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date().toISOString(),
});

describe('user scoping', () => {
  it('hides one user\'s projects and renders from another, but shares NULL-owner rows', () => {
    const { projects, renders } = stores();
    const alice = projects.create({ title: 'a', format: '9:16', fps: 30 }, 'alice');
    const shared = projects.create({ title: 's', format: '9:16', fps: 30 });
    const render = renders.create(alice.id, '720p');

    expect(projects.get(alice.id, 'alice')?.id).toBe(alice.id);
    expect(projects.get(alice.id, 'bob')).toBeUndefined();
    expect(projects.get(shared.id, 'bob')?.id).toBe(shared.id);
    expect(projects.list('bob').map((project) => project.id)).toEqual([shared.id]);
    expect(projects.list().length).toBe(2);

    expect(renders.get(render.id, 'alice')?.id).toBe(render.id);
    expect(renders.get(render.id, 'bob')).toBeUndefined();
  });

  it('scopes assets the same way', () => {
    const { assets } = stores();
    assets.insert(media('mine'), 'alice');
    assets.insert(media('everyone'));

    expect(assets.get('mine', 'alice')?.id).toBe('mine');
    expect(assets.get('mine', 'bob')).toBeUndefined();
    expect(assets.get('everyone', 'bob')?.id).toBe('everyone');
    expect(assets.list('bob').map((asset) => asset.id)).toEqual(['everyone']);
    expect(assets.getByOriginalName('mine.mp4', 'bob')).toBeUndefined();
  });
});
