import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@editify/shared';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore, VersionConflictError } from '../src/db/project-store.js';
import { applyOperation } from '../src/operations/apply.js';

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
});
