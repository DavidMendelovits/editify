import { describe, expect, it } from 'vitest';
import { applyBatch, applyOperation, type Operation, type Project } from '@editify/shared';

const project: Project = {
  id: 'p', title: 'Batch', format: '9:16', fps: 30, duration: 20, version: 3,
  tracks: [
    { id: 'video-main', kind: 'video', clips: [
      { id: 'a', assetId: 'cam', start: 0, in: 0, out: 10 },
      { id: 'b', assetId: 'cam', start: 10, in: 20, out: 30 },
    ] },
    { id: 'audio-main', kind: 'audio', clips: [{ id: 'memo', assetId: 'memo', start: 0, in: 0, out: 20 }] },
    { id: 'captions', kind: 'caption', clips: [] },
  ],
};

// A realistic agent batch: split without naming the piece, then edit that piece by its generated id.
const ops: Operation[] = [
  { type: 'split_clip', params: { clipId: 'a', at: 4 } },
  { type: 'set_transform', params: { clipId: 'gen-1', transform: { scale: 1.25, x: 0.3, y: -0.2 } } },
  { type: 'set_volume', params: { clipId: 'memo', volume: 0.8 } },
  { type: 'add_caption', params: { trackId: 'captions', clip: { id: 'c1', start: 1, in: 0, out: 1.5, text: 'HELLO' } } },
  { type: 'ripple_delete_ranges', params: { trackId: 'video-main', ranges: [{ start: 6, end: 7.5 }] } },
  { type: 'move_clip', params: { clipId: 'b', start: 9 } },
];

function counter(): () => string {
  let next = 0;
  return () => `gen-${(next += 1)}`;
}

describe('applyBatch', () => {
  it('equals chaining applyOperation op by op (one clone, one validation)', () => {
    const chainIds = counter();
    const chained = ops.reduce((current, op) => applyOperation(current, op, { newId: chainIds }), project);
    expect(applyBatch(project, ops, { newId: counter() })).toEqual(chained);
  });

  it('replays deterministically with an injected id generator, so proposals can reference generated ids', () => {
    const first = applyBatch(project, ops, { newId: counter() });
    const second = applyBatch(project, ops, { newId: counter() });
    expect(second).toEqual(first);
    const piece = first.tracks[0]!.clips.find((clip) => clip.id === 'gen-1');
    expect(piece?.transform).toEqual({ scale: 1.25, x: 0.3, y: -0.2 });
  });

  it('bumps the version once per op, like the chain, and never mutates its input', () => {
    const before = structuredClone(project);
    expect(applyBatch(project, ops, { newId: counter() }).version).toBe(project.version + ops.length);
    expect(project).toEqual(before);
  });

  it('applies nothing when any op in the batch is invalid', () => {
    expect(() => applyBatch(project, [ops[0]!, { type: 'remove_clip', params: { clipId: 'nope' } }], { newId: counter() }))
      .toThrow('Clip nope was not found');
  });
});
