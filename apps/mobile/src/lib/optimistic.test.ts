import { describe, expect, it } from 'vitest';
import { applyOperation, operationSchema, withExplicitIds, type Operation, type Project } from '@editify/shared';
import { EDIT_BATCHES, MINTED_ID, editFixture } from '../../../../packages/shared/fixtures/edit-batches';
import { OptimisticLedger, optimisticProject, repaint } from './optimistic';

/**
 * What POST /projects/:id/ops answers for an ordinary batch: parse, chain
 * applyOperation one op at a time, then one version bump. The server's own
 * test (server/test/optimistic-parity.test.ts) runs the real ProjectStore.
 */
function serverEcho(project: Project, ops: Operation[]): Project {
  let doc = project;
  for (const op of ops) {
    doc = applyOperation(doc, operationSchema.parse(op));
    doc.version = project.version;
  }
  return { ...doc, version: project.version + 1 };
}

function paint(ops: Operation[]): Project {
  const project = editFixture();
  const sent = withExplicitIds(ops, () => MINTED_ID);
  const painted = optimisticProject(project, sent);
  expect(painted).toBeDefined();
  // The paint keeps the cached version (the queued request's base); all else matches.
  expect(painted?.version).toBe(project.version);
  const echo = serverEcho(project, sent);
  expect({ ...painted, version: echo.version }).toEqual(echo);
  return painted as Project;
}

const batch = (name: string): Operation[] => {
  const found = EDIT_BATCHES.find((entry) => entry.name === name);
  if (!found) throw new Error(`No batch ${name}`);
  return found.ops;
};

describe('optimisticProject matches the server', () => {
  it.each(EDIT_BATCHES.map((entry) => [entry.name, entry.ops] as const))('%s', (_name, ops) => {
    paint(ops);
  });

  it('trims to the rounded value the op carries', () => {
    expect(paint(batch('trim_clip')).tracks[0]?.clips[0]?.out).toBe(3.123457);
  });

  it('splits a 2x clip with the explicit id it sends', () => {
    expect(paint(batch('split_clip without an id (2x speed)')).tracks[0]?.clips.map((clip) => [clip.id, clip.start, clip.in, clip.out])).toEqual([
      ['a', 0, 0, 4], ['b', 4, 1, 7], ['c', 10, 0, 2], [MINTED_ID, 11, 2, 4],
    ]);
  });

  it('ripples every track and keeps the crossfade on its clip', () => {
    const painted = paint(batch('ripple_delete_ranges'));
    const video = painted.tracks[0]?.clips ?? [];
    expect(video.map((clip) => clip.id)).toEqual(['a', 'a-ripple-2', 'b', 'b-ripple-2', 'c']);
    expect(video.find((clip) => clip.id === 'b')?.transition).toEqual({ type: 'crossfade', duration: 0.5 });
    expect(painted.tracks[1]?.clips.map((clip) => clip.id)).toEqual(['memo', 'memo-ripple-2']);
  });

  it('refits caption words to new text', () => {
    expect(paint(batch('update_caption text')).tracks[2]?.clips[0]?.style?.words?.map((word) => word.w)).toEqual(['hello', 'world']);
  });
});

describe('optimisticProject leaves the decision to the server', () => {
  it('paints nothing for a batch the rules refuse', () => {
    const project = editFixture();
    expect(optimisticProject(project, [{ type: 'trim_clip', params: { clipId: 'a', in: 5 } }])).toBeUndefined();
    expect(optimisticProject(project, [{ type: 'set_volume', params: { clipId: 'gone', volume: 1 } }])).toBeUndefined();
    expect(optimisticProject(project, [{ type: 'undo', params: {} }])).toBeUndefined();
  });

  it('paints nothing for a new video overlap the server rejects', () => {
    expect(optimisticProject(editFixture(), [{ type: 'move_clip', params: { clipId: 'c', start: 6 } }])).toBeUndefined();
  });

  it('paints nothing rather than mint an id the server would not reuse', () => {
    expect(optimisticProject(editFixture(), [{ type: 'split_clip', params: { clipId: 'b', at: 5 } }])).toBeUndefined();
  });

  it('does not touch the cached project', () => {
    const project = editFixture();
    const before = JSON.stringify(project);
    optimisticProject(project, [{ type: 'remove_clip', params: { clipId: 'a' } }]);
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('OptimisticLedger', () => {
  const volume = (doc: Project | undefined): number | undefined => doc?.tracks[1]?.clips[0]?.volume;
  const speed = (doc: Project | undefined): number | undefined => doc?.tracks[0]?.clips[0]?.speed;
  const quiet = { ops: [{ type: 'set_volume', params: { clipId: 'memo', volume: 0.2 } }] as Operation[] };
  const fast = { ops: [{ type: 'set_speed', params: { clipId: 'a', speed: 2 } }] as Operation[] };

  it('rolls a refused batch back to what the server last confirmed (offline: no phantom edit)', () => {
    const ledger = new OptimisticLedger();
    const server = editFixture();
    expect(volume(ledger.begin(server, quiet))).toBe(0.2);
    expect(ledger.reject(quiet)).toEqual(server);
  });

  it("keeps a later batch's paint when an earlier one fails", () => {
    const ledger = new OptimisticLedger();
    const server = editFixture();
    const both = ledger.begin(ledger.begin(server, quiet), fast);
    expect([volume(both), speed(both)]).toEqual([0.2, 2]);
    const afterFailure = ledger.reject(quiet);
    expect([volume(afterFailure), speed(afterFailure), afterFailure?.version]).toEqual([0.8, 2, server.version]);
  });

  it("repaints a later batch onto the server's answer for an earlier one", () => {
    const ledger = new OptimisticLedger();
    const server = editFixture();
    ledger.begin(ledger.begin(server, quiet), fast);
    const answer = serverEcho(server, quiet.ops);
    const shown = ledger.confirm(answer, quiet);
    expect([volume(shown), speed(shown), shown.version]).toEqual([0.2, 2, server.version + 1]);
    // The later batch then fails: back to exactly the server's answer.
    expect(ledger.reject(fast)).toEqual(answer);
  });

  it('takes a write from outside the ledger (undo, revert, chat) as the new base', () => {
    const ledger = new OptimisticLedger();
    const server = editFixture();
    ledger.begin(server, quiet);
    const undone = { ...server, version: server.version + 3 };
    expect(volume(ledger.confirm(undone))).toBe(0.2);
    expect(ledger.reject(quiet)).toEqual(undone);
  });

  it('ignores a document older than the one it holds (a late fetch or chat answer)', () => {
    const ledger = new OptimisticLedger();
    const server = editFixture();
    ledger.begin(server, quiet);
    const answer = serverEcho(server, quiet.ops);
    ledger.confirm(answer, quiet);
    ledger.begin(answer, fast);
    // A GET that left before the answer landed: still the old version.
    const shown = ledger.confirm(server);
    expect([volume(shown), speed(shown), shown.version]).toEqual([0.2, 2, answer.version]);
    expect(ledger.reject(fast)).toEqual(answer);
  });

  it('rebases pending paints onto a newer document that arrives from outside', () => {
    const ledger = new OptimisticLedger();
    const server = editFixture();
    ledger.begin(server, quiet);
    // The agent moved the memo while the batch was in flight.
    const agent = serverEcho(server, [{ type: 'move_clip', params: { clipId: 'memo', start: 3 } }]);
    const shown = ledger.confirm(agent);
    expect([volume(shown), shown.tracks[1]?.clips[0]?.start, shown.version]).toEqual([0.2, 3, agent.version]);
    // Also when the newer document reached the cache directly: the next begin adopts it.
    const other = new OptimisticLedger();
    other.begin(server, quiet);
    const next = other.begin(agent, fast);
    expect([volume(next), speed(next), next.tracks[1]?.clips[0]?.start, next.version]).toEqual([0.2, 2, 3, agent.version]);
  });

  it('has nothing to roll back for a batch it never painted', () => {
    expect(new OptimisticLedger().reject(quiet)).toBeUndefined();
  });

  it('repaint skips a pending batch that no longer applies', () => {
    const gone = { ops: [{ type: 'set_volume', params: { clipId: 'gone', volume: 1 } }] as Operation[] };
    expect(volume(repaint(editFixture(), [gone, quiet]))).toBe(0.2);
  });
});

describe('withExplicitIds', () => {
  it('names only the split halves the caller left unnamed', () => {
    const ops: Operation[] = [
      { type: 'split_clip', params: { clipId: 'a', at: 1 } },
      { type: 'split_clip', params: { clipId: 'b', at: 5, newClipId: 'mine' } },
      { type: 'set_volume', params: { clipId: 'a', volume: 1 } },
    ];
    let counter = 0;
    const named = withExplicitIds(ops, () => `id-${++counter}`);
    expect(named[0]).toEqual({ type: 'split_clip', params: { clipId: 'a', at: 1, newClipId: 'id-1' } });
    expect(named[1]).toBe(ops[1]);
    expect(named[2]).toBe(ops[2]);
    expect(ops[0]).toEqual({ type: 'split_clip', params: { clipId: 'a', at: 1 } });
  });
});
