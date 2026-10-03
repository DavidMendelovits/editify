import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeMedia, UnsupportedMediaError } from '../src/media/process.js';

/*
 * Uploads are probed with a demuxer allowlist: ffprobe sniffs content, so a
 * playlist or concat script named clip.mp4 would otherwise be opened as one,
 * and its URLs (local files, the network) followed by every later ffmpeg.
 */
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every((binary) => spawnSync(binary, ['-version']).status === 0);

describe.skipIf(!hasFfmpeg)('import format allowlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'editify-import-formats-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const make = (name: string, args: string[]): string => {
    const path = join(dir, name);
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, path]);
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return path;
  };

  it('rejects an HLS playlist or ffconcat script uploaded as .mp4', async () => {
    const hls = join(dir, 'playlist.mp4');
    writeFileSync(hls, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
    await expect(probeMedia(hls)).rejects.toThrow();
    const concat = join(dir, 'concat.mp4');
    writeFileSync(concat, "ffconcat version 1.0\nfile '/etc/passwd'\n");
    await expect(probeMedia(concat)).rejects.toThrow();
  });

  it('names the problem when ffprobe refuses the sniffed format', async () => {
    const hls = join(dir, 'm3u8.mov');
    writeFileSync(hls, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n');
    // ffprobe either refuses the sniffed hls demuxer (allowlist) or cannot parse it as any allowed one.
    await expect(probeMedia(hls)).rejects.toSatisfy((error: unknown) => error instanceof UnsupportedMediaError || /Invalid data/.test(String(error)));
  });

  it('accepts video, audio and stills', async () => {
    const mp4 = make('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=64x64:d=0.2', '-pix_fmt', 'yuv420p']);
    const m4a = make('voice.m4a', ['-f', 'lavfi', '-i', 'sine=d=0.2']);
    const wav = make('voice.wav', ['-f', 'lavfi', '-i', 'sine=d=0.2']);
    const png = make('sticker.png', ['-f', 'lavfi', '-i', 'color=red:s=16x16', '-frames:v', '1']);
    const gif = make('sticker.gif', ['-f', 'lavfi', '-i', 'color=red:s=16x16:d=0.2']);
    const jpg = make('photo.jpg', ['-f', 'lavfi', '-i', 'color=red:s=16x16', '-frames:v', '1']);
    expect((await probeMedia(mp4)).hasVideo).toBe(true);
    expect((await probeMedia(m4a)).hasAudio).toBe(true);
    expect((await probeMedia(wav)).hasAudio).toBe(true);
    for (const still of [png, gif, jpg]) expect((await probeMedia(still)).hasVideo).toBe(true);
  });
});
