import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveProject, isShareableMedia, queueShare, setActiveProject, subscribeShares, takeShare, type SharedFile,
} from './share-intake';

const memo: SharedFile = { uri: 'file:///group/memo.m4a', name: 'Voice Memo 42.m4a', mimeType: 'audio/x-m4a' };
const clip: SharedFile = { uri: 'file:///group/set.mov', name: 'set.mov', mimeType: 'video/quicktime' };

afterEach(() => {
  setActiveProject(undefined);
  takeShare('p1');
  takeShare('p2');
});

describe('share hand-off', () => {
  it('parks files for a project until its editor takes them, exactly once', () => {
    queueShare('p1', [memo]);
    expect(takeShare('p2')).toBeUndefined();
    expect(takeShare('p1')).toEqual([memo]);
    expect(takeShare('p1')).toBeUndefined();
  });

  it('keeps a second share that arrives before the first is taken', () => {
    // The regression: the single slot let a second share overwrite the first.
    queueShare('p1', [memo]);
    queueShare('p1', [clip]);
    expect(takeShare('p1')).toEqual([memo, clip]);
  });

  it('keeps shares for different projects apart', () => {
    queueShare('p1', [memo]);
    queueShare('p2', [clip]);
    expect(takeShare('p2')).toEqual([clip]);
    expect(takeShare('p1')).toEqual([memo]);
  });

  it('tells a listening editor as soon as something is queued, and stops after unsubscribing', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeShares(listener);
    queueShare('p1', [memo]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    queueShare('p1', [clip]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('remembers which project is open', () => {
    expect(getActiveProject()).toBeUndefined();
    setActiveProject('p1');
    expect(getActiveProject()).toBe('p1');
    setActiveProject(undefined);
    expect(getActiveProject()).toBeUndefined();
  });
});

describe('isShareableMedia', () => {
  it.each([
    [{ mimeType: 'audio/x-m4a', fileName: 'Voice Memo.m4a' }, true],
    [{ mimeType: 'video/quicktime', fileName: 'IMG_0001.MOV' }, true],
    [{ mimeType: 'image/jpeg', fileName: 'photo.jpg' }, false],
    [{ mimeType: 'application/pdf', fileName: 'set-list.pdf' }, false],
    // No usable MIME type: the extension decides.
    [{ mimeType: null, fileName: 'memo.m4a' }, true],
    [{ mimeType: 'application/octet-stream', fileName: 'memo.M4A' }, true],
    [{ mimeType: 'application/octet-stream', fileName: 'notes.txt' }, false],
    [{ mimeType: null, fileName: null }, false],
  ])('%o → %s', (file, expected) => {
    expect(isShareableMedia(file)).toBe(expected);
  });
});
