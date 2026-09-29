import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@editify/shared';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { AssetAccessError, ProjectStore, VersionConflictError } from '../src/db/project-store.js';
import { applyOperation } from '../src/operations/apply.js';
import { grant } from './fixtures/grant.js';

function project(): Project {
  return {
    id: 'project-1', title: 'Math test', format: '9:16', fps: 30, duration: 5, version: 0,
    tracks: [
      { id: 'video-main', kind: 'video', clips: [{ id: 'clip-a', assetId: 'asset-a', start: 1, in: 2, out: 6, volume: 1, speed: 1 }] },
      { id: 'captions', kind: 'caption', clips: [] },
    ],
  };
}

describe('operation math', () => {
  it('splits using absolute timeline time and maps it back to source time', () => {
    const result = applyOperation(project(), { type: 'split_clip', params: { clipId: 'clip-a', at: 3, newClipId: 'clip-b' } });
    const clips = result.tracks[0]?.clips ?? [];
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ id: 'clip-a', start: 1, in: 2, out: 4 });
    expect(clips[1]).toMatchObject({ id: 'clip-b', start: 3, in: 4, out: 6 });
    expect(result.version).toBe(1);
    expect(result.duration).toBe(5);
  });

  it('accounts for speed when splitting and deriving duration', () => {
    const input = project();
    const speedResult = applyOperation(input, { type: 'set_speed', params: { clipId: 'clip-a', speed: 2 } });
    const result = applyOperation(speedResult, { type: 'split_clip', params: { clipId: 'clip-a', at: 2, newClipId: 'clip-b' } });
    expect(result.tracks[0]?.clips[0]?.out).toBe(4);
    expect(result.tracks[0]?.clips[1]?.in).toBe(4);
    expect(result.duration).toBe(3);
  });

  it('trims and moves clips without corrupting source ranges', () => {
    const trimmed = applyOperation(project(), { type: 'trim_clip', params: { clipId: 'clip-a', in: 2.5, out: 5 } });
    const moved = applyOperation(trimmed, { type: 'move_clip', params: { clipId: 'clip-a', start: 4 } });
    expect(moved.tracks[0]?.clips[0]).toMatchObject({ start: 4, in: 2.5, out: 5 });
    expect(moved.duration).toBe(6.5);
  });

  it('merges ripple ranges, cuts multiple clips, shifts later clips, and trims captions', () => {
    const input: Project = {
      id: 'ripple', title: 'Ripple', format: '9:16', fps: 30, duration: 10, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [
          { id: 'a', assetId: 'asset', start: 0, in: 0, out: 4 },
          { id: 'b', assetId: 'asset', start: 4, in: 0, out: 4 },
          { id: 'c', assetId: 'asset', start: 8, in: 0, out: 2 },
        ] },
        { id: 'captions', kind: 'caption', clips: [
          { id: 'inside', start: 2, in: 0, out: 1, text: 'gone' },
          { id: 'left-edge', start: 0.5, in: 0, out: 1, text: 'trim' },
          { id: 'right-edge', start: 4.5, in: 0, out: 1, text: 'trim' },
        ] },
      ],
    };
    const result = applyOperation(input, {
      type: 'ripple_delete_ranges', params: { trackId: 'video-main', ranges: [{ start: 1, end: 3 }, { start: 2, end: 5 }] },
    });
    expect(result.tracks[0]?.clips).toMatchObject([
      { id: 'a', start: 0, in: 0, out: 1 },
      { id: 'b', start: 1, in: 1, out: 4 },
      { id: 'c', start: 4, in: 0, out: 2 },
    ]);
    expect(result.tracks[1]?.clips).toMatchObject([
      { id: 'left-edge', start: 0.5, in: 0, out: 0.5 },
      { id: 'right-edge', start: 1, in: 0.5, out: 1 },
    ]);
    expect(result.duration).toBe(6);
    expect(result.version).toBe(1);
  });

  it('applies batch clip properties all-or-nothing', () => {
    const database = createDatabase(':memory:');
    const store = new ProjectStore(database);
    const created = store.insert(project());
    expect(() => store.applyOperations(created.id, [{
      type: 'set_clip_properties', params: { updates: [{ clipId: 'clip-a', speed: 2 }, { clipId: 'missing', volume: 0.5 }] },
    }], 0)).toThrow('Clip missing was not found');
    expect(store.get(created.id)?.tracks[0]?.clips[0]?.speed).toBe(1);
    expect(store.get(created.id)?.version).toBe(0);
    database.close();
  });

  it('rejects an invalid ripple batch atomically', () => {
    const database = createDatabase(':memory:');
    const store = new ProjectStore(database);
    const created = store.insert(project());
    expect(() => store.applyOperations(created.id, [{
      type: 'ripple_delete_ranges',
      params: { trackId: 'video-main', ranges: [{ start: 1, end: 2 }, { start: 4, end: 3 }] },
    } as never], 0)).toThrow();
    expect(store.get(created.id)).toEqual(created);
    database.close();
  });
});

describe('versioning and undo', () => {
  let database: EditifyDatabase;
  let store: ProjectStore;
  beforeEach(() => {
    database = createDatabase(':memory:');
    store = new ProjectStore(database);
  });

  it('rejects stale clients with a version conflict', () => {
    const created = store.create({ title: 'Conflict', format: '9:16', fps: 30 });
    const updated = store.applyOperations(created.id, [{ type: 'set_format', params: { format: '16:9' } }], 0);
    expect(updated.version).toBe(1);
    expect(() => store.applyOperations(created.id, [{ type: 'set_format', params: { format: '1:1' } }], 0))
      .toThrow(VersionConflictError);
  });

  it('undoes the last mutation, bumps version, and marks the original log entry', () => {
    const created = store.create({ title: 'Undo', format: '9:16', fps: 30 });
    const changed = store.applyOperations(created.id, [{ type: 'set_format', params: { format: '16:9' } }], 0);
    const undone = store.applyOperations(created.id, [{ type: 'undo', params: {} }], changed.version);
    expect(undone.format).toBe('9:16');
    expect(undone.version).toBe(2);
    const log = store.operationLog(created.id);
    expect(log).toHaveLength(2);
    expect(log[0]?.undone).toBe(true);
    expect(log[1]?.operation.type).toBe('undo');
  });

  it('treats a multi-operation apply call as one version and one undo step', () => {
    const created = store.create({ title: 'Batch', format: '9:16', fps: 30 });
    const changed = store.applyOperations(created.id, [
      { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'one', start: 0, in: 0, out: 1 } } },
      { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'two', start: 1, in: 0, out: 1 } } },
    ], 0);
    expect(changed.version).toBe(1);
    const undone = store.applyOperations(created.id, [{ type: 'undo', params: {} }], 1);
    expect(undone.version).toBe(2);
    expect(undone.tracks[0]?.clips).toEqual([]);
  });
});

describe('video overlap invariant', () => {
  let database: EditifyDatabase;
  let store: ProjectStore;
  beforeEach(() => {
    database = createDatabase(':memory:');
    store = new ProjectStore(database);
  });

  /** Two abutting 5s video clips plus an audio track, on the store. */
  function twoClipProject(): Project {
    return store.insert({
      id: 'overlap-1', title: 'Overlap', format: '9:16', fps: 30, duration: 10, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [
          { id: 'a', assetId: 'asset', start: 0, in: 0, out: 5 },
          { id: 'b', assetId: 'asset', start: 5, in: 0, out: 5 },
        ] },
        { id: 'audio-main', kind: 'audio', clips: [] },
      ],
    });
  }

  it('accepts clips whose ends merely touch', () => {
    const created = twoClipProject();
    expect(created.tracks[0]?.clips).toHaveLength(2);
    const moved = store.applyOperations(created.id, [
      { type: 'move_clip', params: { clipId: 'b', start: 5 } },
      { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'c', assetId: 'asset', start: 10, in: 0, out: 2 } } },
    ], 0);
    expect(moved.tracks[0]?.clips).toHaveLength(3);
  });

  it('rejects an add_clip onto an occupied video range', () => {
    const created = twoClipProject();
    expect(() => store.applyOperations(created.id, [
      { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'c', assetId: 'asset', start: 2, in: 0, out: 2 } } },
    ], 0)).toThrow(/overlap/);
    expect(store.get(created.id)).toEqual(created);
  });

  it('rejects a trim that grows a clip into its neighbour', () => {
    const created = twoClipProject();
    expect(() => store.applyOperations(created.id, [
      { type: 'trim_clip', params: { clipId: 'a', out: 7 } },
    ], 0)).toThrow(/a and b/);
    expect(store.get(created.id)?.version).toBe(0);
  });

  it('allows a batch that swaps two adjacent clips through an intermediate overlap', () => {
    const created = store.insert({
      id: 'swap-1', title: 'Swap', format: '9:16', fps: 30, duration: 7, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [
          { id: 'a', assetId: 'asset', start: 0, in: 0, out: 3 },
          { id: 'b', assetId: 'asset', start: 3, in: 0, out: 4 },
        ] },
      ],
    });
    const swapped = store.applyOperations(created.id, [{
      type: 'set_clip_properties',
      params: { updates: [{ clipId: 'a', start: 4 }, { clipId: 'b', start: 0 }] },
    }], 0);
    expect(swapped.tracks[0]?.clips).toMatchObject([{ id: 'a', start: 4 }, { id: 'b', start: 0 }]);
  });

  it('keeps a project that already overlaps editable, but refuses a second overlap', () => {
    const created = store.insert({
      id: 'bad-1', title: 'Already bad', format: '9:16', fps: 30, duration: 8, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [
          { id: 'a', assetId: 'asset', start: 0, in: 0, out: 5 },
          { id: 'b', assetId: 'asset', start: 3, in: 0, out: 5 },
        ] },
      ],
    });
    const edited = store.applyOperations(created.id, [{ type: 'set_volume', params: { clipId: 'a', volume: 0.5 } }], 0);
    expect(edited.version).toBe(1);
    expect(() => store.applyOperations(created.id, [
      { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'c', assetId: 'asset', start: 1, in: 0, out: 1 } } },
    ], 1)).toThrow(/overlap/);
  });

  it('still allows overlapping audio clips', () => {
    const created = twoClipProject();
    grant(database, created.id, 'song', 'whoosh');
    const mixed = store.applyOperations(created.id, [
      { type: 'add_clip', params: { trackId: 'audio-main', clip: { id: 'bed', assetId: 'song', start: 0, in: 0, out: 10 } } },
      { type: 'add_clip', params: { trackId: 'audio-main', clip: { id: 'sfx', assetId: 'whoosh', start: 2, in: 0, out: 1 } } },
    ], 0);
    expect(mixed.tracks[1]?.clips).toHaveLength(2);
  });
});

describe('project_assets is the grant', () => {
  let database: EditifyDatabase;
  let store: ProjectStore;
  beforeEach(() => {
    database = createDatabase(':memory:');
    store = new ProjectStore(database);
  });

  const addClip = (id: string, assetId: string) => ({
    type: 'add_clip' as const, params: { trackId: 'audio-main', clip: { id, assetId, start: 0, in: 0, out: 1 } },
  });

  it('rejects a clip of an asset that is not linked to the project, and changes nothing', () => {
    const mine = store.create({ title: 'Mine', format: '9:16', fps: 30 });
    const other = store.create({ title: 'Other', format: '9:16', fps: 30 });
    grant(database, other.id, 'elsewhere');
    expect(() => store.applyOperations(mine.id, [addClip('c', 'elsewhere')], 0)).toThrow(AssetAccessError);
    expect(() => store.applyOperations(mine.id, [addClip('c', 'never-existed')], 0)).toThrow(/not in this project/);
    expect(store.get(mine.id)?.version).toBe(0);
    expect(store.operationLog(mine.id)).toHaveLength(0);
  });

  it('accepts linked media and library sounds', () => {
    const created = store.create({ title: 'Mine', format: '9:16', fps: 30 });
    grant(database, created.id, 'linked');
    const edited = store.applyOperations(created.id, [addClip('a', 'linked'), addClip('b', 'sound-whoosh-soft')], 0);
    expect(edited.tracks.find((track) => track.id === 'audio-main')?.clips.map((clip) => clip.assetId)).toEqual(['linked', 'sound-whoosh-soft']);
  });

  it('only checks new references, so an older timeline stays editable', () => {
    const created = store.insert({
      id: 'legacy', title: 'Legacy', format: '9:16', fps: 30, duration: 5, version: 0,
      tracks: [
        { id: 'video-main', kind: 'video', clips: [{ id: 'a', assetId: 'unlinked', start: 0, in: 0, out: 5 }] },
        { id: 'audio-main', kind: 'audio', clips: [] },
      ],
    });
    // Splitting copies the unlinked reference, which the timeline already had.
    expect(store.applyOperations(created.id, [{ type: 'split_clip', params: { clipId: 'a', at: 2, newClipId: 'b' } }], 0).version).toBe(1);
    expect(() => store.applyOperations(created.id, [addClip('c', 'foreign')], 1)).toThrow(AssetAccessError);
  });
});
