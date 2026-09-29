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
  it('shows a user only their own projects and renders; NULL-owner rows belong to nobody', () => {
    const { projects, renders } = stores();
    const alice = projects.create({ title: 'a', format: '9:16', fps: 30 }, 'alice');
    const orphan = projects.create({ title: 'pre-auth', format: '9:16', fps: 30 });
    const render = renders.create(alice.id, '720p');
    const orphanRender = renders.create(orphan.id, '720p');

    expect(projects.get(alice.id, 'alice')?.id).toBe(alice.id);
    expect(projects.get(alice.id, 'bob')).toBeUndefined();
    expect(projects.get(orphan.id, 'bob')).toBeUndefined();
    expect(projects.list('bob')).toEqual([]);
    expect(projects.list('alice').map((project) => project.id)).toEqual([alice.id]);
    // Unscoped (shared token, local dev) still sees everything.
    expect(projects.list().length).toBe(2);
    expect(projects.get(orphan.id)?.id).toBe(orphan.id);

    expect(renders.get(render.id, 'alice')?.id).toBe(render.id);
    expect(renders.get(render.id, 'bob')).toBeUndefined();
    expect(renders.get(orphanRender.id, 'alice')).toBeUndefined();
  });

  it('shows a user their own assets and the sound library, nothing else', () => {
    const { assets } = stores();
    assets.insert(media('mine'), 'alice');
    assets.insert(media('pre-auth'));
    assets.insert(media('sound-whoosh-soft'));

    expect(assets.get('mine', 'alice')?.id).toBe('mine');
    expect(assets.get('mine', 'bob')).toBeUndefined();
    expect(assets.get('pre-auth', 'bob')).toBeUndefined();
    expect(assets.get('sound-whoosh-soft', 'bob')?.id).toBe('sound-whoosh-soft');
    expect(assets.list('bob').map((asset) => asset.id)).toEqual(['sound-whoosh-soft']);
    expect(assets.list('alice').map((asset) => asset.id)).toEqual(['mine', 'sound-whoosh-soft']);
    expect(assets.getByOriginalName('mine.mp4', 'bob')).toBeUndefined();
    expect(assets.getByOriginalName('pre-auth.mp4', 'alice')).toBeUndefined();
    expect(assets.list().length).toBe(3);
  });

  it('lets a user read the sound library but never change it', () => {
    const { assets } = stores();
    assets.insert(media('mine'), 'alice');
    assets.insert(media('sound-whoosh-soft'));

    expect(assets.owned('mine', 'alice')?.id).toBe('mine');
    expect(assets.owned('mine', 'bob')).toBeUndefined();
    expect(assets.owned('sound-whoosh-soft', 'alice')).toBeUndefined();
    expect(assets.owned('sound-whoosh-soft')?.id).toBe('sound-whoosh-soft');
  });

  it('lists a project\'s media through the same rule, hiding orphaned and foreign links', () => {
    const { projects, assets } = stores();
    const project = projects.create({ title: 'a', format: '9:16', fps: 30 }, 'alice');
    assets.insert(media('mine'), 'alice');
    assets.insert(media('pre-auth'));
    assets.insert(media('bobs'), 'bob');
    assets.insert(media('sound-pop-bubble'));
    for (const id of ['mine', 'pre-auth', 'bobs', 'sound-pop-bubble']) assets.link(project.id, id);

    expect(assets.listForProject(project.id, 'alice').map((asset) => asset.id)).toEqual(['mine', 'sound-pop-bubble']);
    expect(assets.listForProject(project.id).length).toBe(4);
    expect(assets.getInProject(project.id, 'mine', 'alice')?.id).toBe('mine');
    expect(assets.getInProject(project.id, 'bobs', 'alice')).toBeUndefined();
    // A library sound needs no link; someone's unlinked upload is out of reach.
    assets.insert(media('sound-ui-click'));
    assets.insert(media('elsewhere'), 'alice');
    expect(assets.getInProject(project.id, 'sound-ui-click', 'alice')?.id).toBe('sound-ui-click');
    expect(assets.getInProject(project.id, 'elsewhere', 'alice')).toBeUndefined();
  });
});
