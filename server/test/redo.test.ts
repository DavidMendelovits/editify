import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Operation, Project } from '@editify/shared';
import { buildApp } from '../src/app.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { OperationError } from '../src/operations/apply.js';

function addClip(id: string, start: number): Operation {
  return { type: 'add_clip', params: { trackId: 'video-main', clip: { id, assetId: 'asset-a', start, in: 0, out: 2 } } };
}

function clipIds(project: Project): string[] {
  return (project.tracks.find((track) => track.id === 'video-main')?.clips ?? []).map((clip) => clip.id);
}

describe('redo', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let projectId: string;

  function apply(operation: Operation): Project {
    const project = projects.get(projectId) as Project;
    return projects.applyOperations(projectId, [operation], project.version);
  }

  const undo = (): Project => apply({ type: 'undo', params: {} });
  const redo = (): Project => apply({ type: 'redo', params: {} });

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    projectId = projects.create({ title: 'Redo', format: '9:16', fps: 30 }).id;
  });

  it('restores what the undo retracted and bumps the version', () => {
    const added = apply(addClip('clip-1', 0));
    const undone = undo();
    expect(clipIds(undone)).toEqual([]);

    const redone = redo();
    expect(clipIds(redone)).toEqual(clipIds(added));
    expect(redone.version).toBe(undone.version + 1);
  });

  it('walks a stack of undos back up in order', () => {
    apply(addClip('clip-1', 0));
    apply(addClip('clip-2', 2));
    undo();
    undo();
    expect(clipIds(projects.get(projectId) as Project)).toEqual([]);

    expect(clipIds(redo())).toEqual(['clip-1']);
    expect(clipIds(redo())).toEqual(['clip-1', 'clip-2']);
    expect(projects.history(projectId)).toEqual({ canUndo: true, canRedo: false });
  });

  it('is cleared by an ordinary edit after the undo', () => {
    apply(addClip('clip-1', 0));
    undo();
    expect(projects.history(projectId).canRedo).toBe(true);

    apply(addClip('clip-2', 5));
    expect(projects.history(projectId).canRedo).toBe(false);
    expect(() => redo()).toThrow(OperationError);
  });

  it('reports nothing to undo or redo on a fresh project', () => {
    expect(projects.history(projectId)).toEqual({ canUndo: false, canRedo: false });
    expect(() => redo()).toThrow(OperationError);
    expect(() => undo()).toThrow(OperationError);
  });

  it('undoes again after a redo', () => {
    apply(addClip('clip-1', 0));
    undo();
    redo();
    expect(clipIds(undo())).toEqual([]);
    expect(projects.history(projectId)).toEqual({ canUndo: false, canRedo: true });
  });
});

describe('GET /projects/:id/history', () => {
  let database: EditifyDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let project: Project;

  beforeEach(async () => {
    database = createDatabase(':memory:');
    app = await buildApp({ database });
    const created = await app.inject({ method: 'POST', url: '/projects', payload: { title: 'History', format: '9:16', fps: 30 } });
    project = created.json() as Project;
  });

  afterEach(async () => { await app.close(); });

  async function ops(operation: Operation, baseVersion: number): Promise<Project> {
    const response = await app.inject({ method: 'POST', url: `/projects/${project.id}/ops`, payload: { ops: [operation], baseVersion } });
    expect(response.statusCode).toBe(200);
    return response.json() as Project;
  }

  const history = async (): Promise<unknown> => (await app.inject({ method: 'GET', url: `/projects/${project.id}/history` })).json();

  it('tracks what the toolbar buttons may do', async () => {
    expect(await history()).toEqual({ canUndo: false, canRedo: false });

    const added = await ops(addClip('clip-1', 0), project.version);
    expect(await history()).toEqual({ canUndo: true, canRedo: false });

    const undone = await ops({ type: 'undo', params: {} }, added.version);
    expect(await history()).toEqual({ canUndo: false, canRedo: true });

    const redone = await ops({ type: 'redo', params: {} }, undone.version);
    expect(clipIds(redone)).toEqual(['clip-1']);
    expect(await history()).toEqual({ canUndo: true, canRedo: false });
  });

  it('404s for a project that does not exist', async () => {
    expect((await app.inject({ method: 'GET', url: '/projects/nope/history' })).statusCode).toBe(404);
  });
});
