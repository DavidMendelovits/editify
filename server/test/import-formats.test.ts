import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // FLV is a real container ffprobe sniffs whatever the name, and not one the app takes.
    const flv = make('flash.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=64x64:d=0.2', '-c:v', 'flv1', '-f', 'flv']);
    await expect(probeMedia(flv)).rejects.toBeInstanceOf(UnsupportedMediaError);
    const concat = join(dir, 'script.mp4');
    writeFileSync(concat, "ffconcat version 1.0\nfile '/etc/passwd'\n");
    await expect(probeMedia(concat)).rejects.toBeInstanceOf(UnsupportedMediaError);
  });

  it('reports a source the plan render will not open as unavailable, so the queue falls back to legacy', async () => {
    const { probePlanUnlessUnsupported, PlanRenderUnavailableError } = await import('../src/media/plan/render.js');
    const flv = make('stored.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=64x64:d=0.2', '-c:v', 'flv1', '-f', 'flv']);
    await expect(probePlanUnlessUnsupported(flv, 'video')).rejects.toBeInstanceOf(PlanRenderUnavailableError);
  });

  it('refuses an unsupported upload with 415, not a 500', async () => {
    const { buildApp } = await import('../src/app.js');
    const { createDatabase } = await import('../src/db/database.js');
    const flv = make('upload.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=64x64:d=0.2', '-c:v', 'flv1', '-f', 'flv']);
    const app = await buildApp({ database: createDatabase(':memory:') });
    const response = await app.inject({
      method: 'POST', url: `/assets/raw?name=${encodeURIComponent('clip.mp4')}`, headers: { 'content-type': 'video/mp4' }, payload: readFileSync(flv),
    });
    expect(response.statusCode).toBe(415);
    expect(response.json<{ error: string }>().error).toMatch(/not a supported/);
    await app.close();
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

  it('accepts the other formats production takes: AVI, MPEG-TS, AIFF, CAF, APNG', async () => {
    const avi = make('clip.avi', ['-f', 'lavfi', '-i', 'testsrc=s=64x64:d=0.2', '-c:v', 'mpeg4']);
    const ts = make('clip.ts', ['-f', 'lavfi', '-i', 'testsrc=s=64x64:d=0.2', '-c:v', 'mpeg2video']);
    const aiff = make('voice.aiff', ['-f', 'lavfi', '-i', 'sine=d=0.2']);
    const caf = make('voice.caf', ['-f', 'lavfi', '-i', 'sine=d=0.2']);
    const apng = make('sticker.apng', ['-f', 'lavfi', '-i', 'testsrc=s=16x16:d=0.2', '-f', 'apng']);
    for (const video of [avi, ts, apng]) expect((await probeMedia(video)).hasVideo, video).toBe(true);
    for (const audio of [aiff, caf]) expect((await probeMedia(audio)).hasAudio, audio).toBe(true);
  });
});
