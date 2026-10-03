import { describe, expect, it } from 'vitest';
import { applyOperation, operationSchema, projectSchema, type Operation, type Project } from '@editify/shared';
import { optimisticProject, withClientIds } from './optimistic';

function fixture(): Project {
  return projectSchema.parse({
    id: 'p1',
    title: 'Stand-up',
    format: '9:16',
    fps: 30,
    duration: 0,
    version: 7,
    tracks: [
      {
        id: 'video-main',
        kind: 'video',
        clips: [
          { id: 'a', assetId: 'asset-1', start: 0, in: 0, out: 4, volume: 1, speed: 1 },
          { id: 'b', assetId: 'asset-2', start: 4, in: 1, out: 7, volume: 1, speed: 1, transition: { type: 'crossfade', duration: 0.5 } },
          { id: 'c', assetId: 'asset-3', start: 10, in: 0, out: 4, speed: 2 },
        ],
      },
      { id: 'audio-main', kind: 'audio', clips: [{ id: 'memo', assetId: 'asset-4', start: 1, in: 0, out: 9, volume: 0.8 }] },
      {
        id: 'captions',
        kind: 'caption',
        clips: [
          {
            id: 'cap-1', start: 0.5, in: 0, out: 2, text: 'hello there',
            style: { words: [{ w: 'hello', s: 0.5, e: 1 }, { w: 'there', s: 1.1, e: 2.4 }] },
          },
          { id: 'cap-2', start: 6, in: 0, out: 1.5, text: 'late line' },
        ],
      },
      { id: 'overlays', kind: 'overlay', clips: [{ id: 'sticker', text: '★', start: 3, in: 0, out: 3 }] },
    ],
  });
}

/**
 * What POST /projects/:id/ops answers for an ordinary batch (ProjectStore.
 * applyOperations): parse, chain applyOperation one op at a time, then one
 * version bump. Kept in step with server/src/db/project-store.ts.
 */
function serverEcho(project: Project, ops: Operation[]): Project {
  let doc = project;
  for (const op of ops) {
    doc = applyOperation(doc, operationSchema.parse(op));
    doc.version = project.version;
  }
  return { ...doc, version: project.version + 1 };
}

/** The phone's path: ids made explicit, then the optimistic paint. */
function paintAndEcho(ops: Operation[]): { painted: Project | undefined; echo: Project } {
  const project = fixture();
  const sent = withClientIds(ops, () => 'minted-id');
  return { painted: optimisticProject(project, sent), echo: serverEcho(project, sent) };
}

function expectMatchesServer(ops: Operation[]): Project {
  const { painted, echo } = paintAndEcho(ops);
  expect(painted).toBeDefined();
  // The paint keeps the cached version (the queued request's base); all else matches.
  expect(painted?.version).toBe(fixture().version);
  expect({ ...painted, version: echo.version }).toEqual(echo);
  return painted as Project;
}

describe('optimisticProject matches the server', () => {
  it('trim_clip, with the rounded values the op carries', () => {
    const painted = expectMatchesServer([{ type: 'trim_clip', params: { clipId: 'a', out: 3.123457 } }]);
    expect(painted.tracks[0]?.clips[0]?.out).toBe(3.123457);
  });

  it('split_clip with an explicit id, and fills one in when missing', () => {
    expectMatchesServer([{ type: 'split_clip', params: { clipId: 'b', at: 5, newClipId: 'b-s1' } }]);
    const painted = expectMatchesServer([{ type: 'split_clip', params: { clipId: 'c', at: 11 } }]);
    // c runs at 2x: one timeline second is two source seconds.
    expect(painted.tracks[0]?.clips.map((clip) => [clip.id, clip.start, clip.in, clip.out])).toEqual([
      ['a', 0, 0, 4], ['b', 4, 1, 7], ['c', 10, 0, 2], ['minted-id', 11, 2, 4],
    ]);
  });

  it('move_clip and set_clip_properties start moves', () => {
    expectMatchesServer([{ type: 'move_clip', params: { clipId: 'memo', start: 2.5 } }]);
    expectMatchesServer([{ type: 'set_clip_properties', params: { updates: [{ clipId: 'c', start: 12 }] } }]);
  });

  it('ripple_delete_ranges ripples every track and keeps the crossfade on its clip', () => {
    const painted = expectMatchesServer([{
      type: 'ripple_delete_ranges',
      params: { trackId: 'video-main', ranges: [{ start: 1, end: 2 }, { start: 5, end: 6 }] },
    }]);
    const video = painted.tracks[0]?.clips ?? [];
    expect(video.map((clip) => clip.id)).toEqual(['a', 'a-ripple-2', 'b', 'b-ripple-2', 'c']);
    expect(video.find((clip) => clip.id === 'b')?.transition).toEqual({ type: 'crossfade', duration: 0.5 });
    expect(painted.tracks[1]?.clips.map((clip) => clip.id)).toEqual(['memo', 'memo-ripple-2']);
  });

  it('set_volume', () => {
    const painted = expectMatchesServer([{ type: 'set_volume', params: { clipId: 'memo', volume: 0.35 } }]);
    expect(painted.tracks[1]?.clips[0]?.volume).toBe(0.35);
  });

  it('add_caption, update_caption (words refit to new text) and remove_caption', () => {
    expectMatchesServer([{ type: 'add_caption', params: { trackId: 'captions', clip: { id: 'cap-3', start: 9, in: 0, out: 1, text: 'new' } } }]);
    const updated = expectMatchesServer([{ type: 'update_caption', params: { clipId: 'cap-1', text: 'hello world' } }]);
    expect(updated.tracks[2]?.clips[0]?.style?.words?.map((word) => word.w)).toEqual(['hello', 'world']);
    expectMatchesServer([{ type: 'remove_caption', params: { clipId: 'cap-2' } }]);
  });

  it('a multi-op batch: trim, split, transition, sticker, captions, ripple', () => {
    expectMatchesServer([
      { type: 'trim_clip', params: { clipId: 'a', in: 0.5 } },
      { type: 'set_clip_properties', params: { updates: [{ clipId: 'a', start: 0 }] } },
      { type: 'split_clip', params: { clipId: 'b', at: 6 } },
      { type: 'set_transition', params: { clipId: 'b', transition: null } },
      { type: 'set_overlay', params: { clipId: 'sticker', overlay: { x: 0.2, y: 0.8, width: 0.3, rotation: 15 } } },
      { type: 'add_clip', params: { trackId: 'overlays', clip: { id: 'star-2', text: '✨', start: 1, in: 0, out: 2 } } },
      { type: 'update_caption', params: { clipId: 'cap-2', start: 6.5 } },
      { type: 'remove_clip', params: { clipId: 'sticker' } },
      { type: 'ripple_delete_ranges', params: { trackId: 'video-main', ranges: [{ start: 2, end: 2.5 }] } },
    ]);
  });
});

describe('optimisticProject leaves the decision to the server', () => {
  it('paints nothing for a batch the rules refuse', () => {
    const project = fixture();
    expect(optimisticProject(project, [{ type: 'trim_clip', params: { clipId: 'a', in: 5 } }])).toBeUndefined();
    expect(optimisticProject(project, [{ type: 'set_volume', params: { clipId: 'gone', volume: 1 } }])).toBeUndefined();
    expect(optimisticProject(project, [{ type: 'undo', params: {} }])).toBeUndefined();
  });

  it('paints nothing for a new video overlap the server rejects', () => {
    expect(optimisticProject(fixture(), [{ type: 'move_clip', params: { clipId: 'c', start: 6 } }])).toBeUndefined();
  });

  it('paints nothing rather than mint an id the server would not reuse', () => {
    expect(optimisticProject(fixture(), [{ type: 'split_clip', params: { clipId: 'b', at: 5 } }])).toBeUndefined();
  });

  it('does not touch the cached project', () => {
    const project = fixture();
    const before = JSON.stringify(project);
    optimisticProject(project, [{ type: 'remove_clip', params: { clipId: 'a' } }]);
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('withClientIds', () => {
  it('names only the split halves the caller left unnamed', () => {
    const ops: Operation[] = [
      { type: 'split_clip', params: { clipId: 'a', at: 1 } },
      { type: 'split_clip', params: { clipId: 'b', at: 5, newClipId: 'mine' } },
      { type: 'set_volume', params: { clipId: 'a', volume: 1 } },
    ];
    let counter = 0;
    const named = withClientIds(ops, () => `id-${++counter}`);
    expect(named[0]).toEqual({ type: 'split_clip', params: { clipId: 'a', at: 1, newClipId: 'id-1' } });
    expect(named[1]).toBe(ops[1]);
    expect(named[2]).toBe(ops[2]);
    expect(ops[0]).toEqual({ type: 'split_clip', params: { clipId: 'a', at: 1 } });
  });
});
