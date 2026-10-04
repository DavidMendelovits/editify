import { describe, expect, it } from 'vitest';
import { exportButton, exportKey, planExport, remainingItems } from './export-plan';

const asset = (id: string, originalName: string, mimeType: string, status = 'ready') => ({
  id, originalName, mimeType, status, originalUrl: `/assets/${id}/original`,
});

describe('planExport', () => {
  it('saves finished masters first, then originals Photos can hold', () => {
    const plan = planExport(
      [
        { id: 'r1', status: 'done', outputUrl: 'https://editify-dm.fly.dev/renders/r1/file.mp4' },
        { id: 'r2', status: 'error' },
        { id: 'r3', status: 'done' },
      ],
      [
        asset('a1b2c3d4e5', 'IMG_0001.MOV', 'video/quicktime'),
        asset('f6f6f6f6f6', 'sticker', 'image/png'),
        asset('sound-whoosh-soft', 'sfx-whoosh-soft-v2.m4a', 'audio/mp4'),
        asset('memo000001', 'Voice Memo.m4a', 'audio/mp4'),
        asset('pending001', 'half.mp4', 'video/mp4', 'processing'),
      ],
    );
    expect(plan).toEqual([
      { kind: 'video', id: 'r1', url: 'https://editify-dm.fly.dev/renders/r1/file.mp4', fileName: 'editify-r1.mp4' },
      { kind: 'original', id: 'a1b2c3d4e5', url: '/assets/a1b2c3d4e5/original', fileName: 'a1b2c3d4-IMG_0001.MOV' },
      { kind: 'original', id: 'f6f6f6f6f6', url: '/assets/f6f6f6f6f6/original', fileName: 'f6f6f6f6-sticker.png' },
    ]);
  });

  it('keeps a hostile name inside the cache directory', () => {
    const [item] = planExport([], [asset('abcdefgh12', '../../etc/clip?.mp4', 'video/mp4')]);
    expect(item?.fileName).toBe('abcdefgh-clip_.mp4');
  });
});

describe('retrying a partial export', () => {
  const items = planExport(
    [{ id: 'r1', status: 'done', outputUrl: '/renders/r1/file.mp4' }],
    [asset('a1b2c3d4e5', 'one.mov', 'video/quicktime'), asset('f6f6f6f6f6', 'two.mov', 'video/quicktime')],
  );

  it('keys an item by kind and id, not by its (possibly re-signed) url', () => {
    expect(exportKey(items[0]!)).toBe('video:r1');
    expect(exportKey({ kind: 'original', id: 'r1' })).not.toBe(exportKey({ kind: 'video', id: 'r1' }));
  });

  it('only tries what has not reached Photos yet, plus anything new', () => {
    const saved = new Set(['video:r1', 'original:a1b2c3d4e5']);
    expect(remainingItems(items, saved).map((item) => item.id)).toEqual(['f6f6f6f6f6']);
    const later = [...items, ...planExport([{ id: 'r9', status: 'done', outputUrl: '/renders/r9/file.mp4' }], [])];
    expect(remainingItems(later, saved).map((item) => item.id)).toEqual(['f6f6f6f6f6', 'r9']);
    expect(remainingItems(items, new Set())).toHaveLength(3);
  });

  it('names the retry by its failures and never offers to save everything again', () => {
    expect(exportButton(false, undefined)).toEqual({ label: 'Save my videos to Photos', disabled: false });
    expect(exportButton(true, undefined)).toEqual({ label: 'Saving to Photos…', disabled: true });
    expect(exportButton(false, { saved: 2, failed: 1, total: 3 })).toEqual({ label: 'Retry 1 failed', disabled: false });
    expect(exportButton(false, { saved: 0, failed: 3, total: 3 })).toEqual({ label: 'Retry 3 failed', disabled: false });
    expect(exportButton(false, { saved: 3, failed: 0, total: 3 })).toEqual({ label: 'All saved to Photos', disabled: true });
    // Nothing on the account yet: checking again is harmless.
    expect(exportButton(false, { saved: 0, failed: 0, total: 0 })).toEqual({ label: 'Save my videos to Photos', disabled: false });
  });
});
