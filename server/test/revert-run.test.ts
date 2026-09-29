import { beforeEach, describe, expect, it } from 'vitest';
import type { Operation, Project } from '@editify/shared';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { OperationError } from '../src/operations/apply.js';
import { grant } from './fixtures/grant.js';

const RUN = 'run-1';

function addClip(id: string, start: number): Operation {
  return { type: 'add_clip', params: { trackId: 'video-main', clip: { id, assetId: 'asset-a', start, in: 0, out: 2 } } };
}

function videoClipIds(project: Project): string[] {
  return (project.tracks.find((track) => track.id === 'video-main')?.clips ?? []).map((clip) => clip.id);
}

function volumeOf(project: Project, clipId: string): number | undefined {
  return project.tracks.find((track) => track.id === 'video-main')?.clips.find((clip) => clip.id === clipId)?.volume;
}

describe('reverting one agent run', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let projectId: string;

  /** Three batches sharing one runId, as an agent turn logs them. */
  function applyRun(runId = RUN): Project {
    let project = projects.get(projectId) as Project;
    project = projects.applyOperations(projectId, [addClip('clip-1', 0)], project.version, runId);
    project = projects.applyOperations(projectId, [addClip('clip-2', 2)], project.version, runId);
    return projects.applyOperations(
      projectId,
      [{ type: 'set_volume', params: { clipId: 'clip-1', volume: 0.5 } }],
      project.version,
      runId,
    );
  }

  function revert(runId = RUN): Project {
    const project = projects.get(projectId) as Project;
    return projects.applyOperations(projectId, [{ type: 'revert_run', params: { runId } }], project.version);
  }

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    projectId = projects.create({ title: 'Revert', format: '9:16', fps: 30 }).id;
    grant(database, projectId, 'asset-a');
  });

  it('restores the pre-run document across every batch of the run and bumps the version', () => {
    const afterRun = applyRun();
    expect(videoClipIds(afterRun)).toEqual(['clip-1', 'clip-2']);

    const reverted = revert();
    expect(videoClipIds(reverted)).toEqual([]);
    expect(reverted.version).toBe(afterRun.version + 1);
  });

  it('treats a plain undo of the revert as a redo, putting the run back into history', () => {
    applyRun();
    revert();

    const redone = projects.applyOperations(projectId, [{ type: 'undo', params: {} }], projects.get(projectId)?.version ?? 0);
    expect(videoClipIds(redone)).toEqual(['clip-1', 'clip-2']);
    expect(volumeOf(redone, 'clip-1')).toBe(0.5);

    // The run's rows are live again, so the next undo walks into the run's last
    // batch (the volume change) rather than something older.
    const stepBack = projects.applyOperations(projectId, [{ type: 'undo', params: {} }], redone.version);
    expect(videoClipIds(stepBack)).toEqual(['clip-1', 'clip-2']);
    expect(volumeOf(stepBack, 'clip-1')).not.toBe(0.5);
  });

  it('refuses to revert the same run twice', () => {
    applyRun();
    revert();
    expect(() => revert()).toThrow(OperationError);
    expect(() => revert()).toThrow(/already reverted/);
  });

  it('refuses to revert once a client edit lands on top of the run', () => {
    applyRun();
    projects.applyOperations(projectId, [addClip('clip-3', 4)], projects.get(projectId)?.version ?? 0);
    expect(() => revert()).toThrow(/timeline changed/);
  });

  it('still reverts after a plain undo of the run\'s last batch', () => {
    applyRun();
    projects.applyOperations(projectId, [{ type: 'undo', params: {} }], projects.get(projectId)?.version ?? 0);
    expect(videoClipIds(revert())).toEqual([]);
  });

  it('reverts a run that itself contains an agent undo', () => {
    let project = projects.get(projectId) as Project;
    project = projects.applyOperations(projectId, [addClip('clip-1', 0)], project.version, RUN);
    project = projects.applyOperations(projectId, [addClip('clip-2', 2)], project.version, RUN);
    project = projects.applyOperations(projectId, [{ type: 'undo', params: {} }], project.version, RUN);
    expect(videoClipIds(project)).toEqual(['clip-1']);

    expect(videoClipIds(revert())).toEqual([]);
  });

  it('rejects a revert batched with other operations', () => {
    applyRun();
    const version = projects.get(projectId)?.version ?? 0;
    expect(() => projects.applyOperations(
      projectId,
      [{ type: 'revert_run', params: { runId: RUN } }, addClip('clip-3', 4)],
      version,
    )).toThrow(/by itself/);
  });
});
