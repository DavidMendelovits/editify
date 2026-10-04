import { describe, expect, it } from 'vitest';
import { previewBatch, withExplicitIds, type Project } from '@editify/shared';
import { createDatabase } from '../src/db/database.js';
import { AssetAccessError, ProjectStore } from '../src/db/project-store.js';
import { EDIT_BATCHES, MINTED_ID, editFixture } from '../../packages/shared/fixtures/edit-batches.js';

/**
 * Decision 5A: the phone paints previewBatch before POST /projects/:id/ops.
 * Each batch here goes through the real ProjectStore.applyOperations (SQLite
 * in memory), and the stored answer must equal the paint, version aside.
 */
const withoutVersion = (doc: Project): Project => ({ ...doc, version: 0 });

describe('phone paint equals ProjectStore.applyOperations', () => {
  it.each(EDIT_BATCHES.map((entry) => [entry.name, entry.ops] as const))('%s', (_name, ops) => {
    const projects = new ProjectStore(createDatabase(':memory:'));
    const project = projects.insert(editFixture());
    const sent = withExplicitIds(ops, () => MINTED_ID);

    const painted = previewBatch(project, sent);
    const answer = projects.applyOperations(project.id, sent, project.version);

    expect(painted.version).toBe(project.version);
    expect(answer.version).toBe(project.version + 1);
    expect(withoutVersion(painted)).toEqual(withoutVersion(answer));
    expect(withoutVersion(projects.get(project.id) as Project)).toEqual(withoutVersion(painted));
  });

  it('paints a batch only the server can refuse; the phone rolls that paint back', () => {
    // The asset grant is a server-only check (project_assets): previewBatch
    // accepts the clip, ProjectStore refuses it, and the phone's
    // OptimisticLedger.reject drops the paint (apps/mobile/src/lib/optimistic.test.ts).
    // Intermediate states are not a source of drift: applyBatch enforces the
    // same per-op rules as the server's op-by-op applyOperation, and both
    // check overlaps only once, at the end of the batch.
    const projects = new ProjectStore(createDatabase(':memory:'));
    const project = projects.insert(editFixture());
    const ops = [{
      type: 'add_clip' as const,
      params: { trackId: 'audio-main', clip: { id: 'foreign', assetId: 'not-linked', start: 0, in: 0, out: 2 } },
    }];
    expect(previewBatch(project, ops).tracks[1]?.clips.map((clip) => clip.id)).toEqual(['memo', 'foreign']);
    expect(() => projects.applyOperations(project.id, ops, project.version)).toThrow(AssetAccessError);
    expect(projects.get(project.id)).toEqual(project);
  });

  it('refuses to paint the overlap the server refuses to store', () => {
    const projects = new ProjectStore(createDatabase(':memory:'));
    const project = projects.insert(editFixture());
    const ops = [{ type: 'move_clip' as const, params: { clipId: 'c', start: 6 } }];
    expect(() => previewBatch(project, ops)).toThrow(/would overlap/);
    expect(() => projects.applyOperations(project.id, ops, project.version)).toThrow(/would overlap/);
  });
});
