import { describe, expect, it } from 'vitest';
import { planExport } from './export-plan';

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
      { kind: 'video', url: 'https://editify-dm.fly.dev/renders/r1/file.mp4', fileName: 'editify-r1.mp4' },
      { kind: 'original', url: '/assets/a1b2c3d4e5/original', fileName: 'a1b2c3d4-IMG_0001.MOV' },
      { kind: 'original', url: '/assets/f6f6f6f6f6/original', fileName: 'f6f6f6f6-sticker.png' },
    ]);
  });

  it('keeps a hostile name inside the cache directory', () => {
    const [item] = planExport([], [asset('abcdefgh12', '../../etc/clip?.mp4', 'video/mp4')]);
    expect(item?.fileName).toBe('abcdefgh-clip_.mp4');
  });
});
