import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * Plan P1 (10B + OV9, 3A + OV2): the phone's preview proxy writer, its LRU store and
 * the media fingerprint, run on macOS against clips ffmpeg makes here: a 10-bit HEVC
 * HLG/BT.2020 4K clip, two SDR H.264 clips (one to scale, one to keep), and an audio
 * file with a re-wrapped and a trimmed copy. The checks live in
 * apps/mobile/modules/editify-engine/parity/media-pipeline/main.swift. Linux skips.
 */
const engine = resolve(fileURLToPath(import.meta.url), '../../../apps/mobile/modules/editify-engine');
const hasSwift = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;
const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx265') ?? false;
let dir: string | undefined;

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
}

/** A tone whose loudness keeps moving, so its energy envelope has something to hash. */
const MOVING_TONE = "aevalsrc=exprs='0.5*sin(2*PI*440*t)*(0.55+0.45*sin(2*PI*1.7*t+3*sin(2*PI*0.31*t)))':sample_rate=48000";

describe.skipIf(!hasSwift || !hasFfmpeg)('device proxy pipeline and fingerprint (Swift)', () => {
  it('passes every check', () => {
    dir = mkdtempSync(join(tmpdir(), 'editify-media-pipeline-'));
    const clips = join(dir, 'clips');
    execFileSync('mkdir', ['-p', clips]);
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=50', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
      '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1',
      '-c:a', 'pcm_s16le', join(clips, 'hdr.mov'),
    ]);
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:a', 'aac', '-b:a', '128k', join(clips, 'sdr-big.mp4'),
    ]);
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=44100', '-t', '1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(clips, 'sdr-small.mov'),
    ]);
    ffmpeg(['-f', 'lavfi', '-i', MOVING_TONE, '-t', '12', '-c:a', 'aac', '-b:a', '128k', join(clips, 'audio.m4a')]);
    ffmpeg(['-i', join(clips, 'audio.m4a'), '-c', 'copy', join(clips, 'audio-remux.mov')]);
    ffmpeg(['-ss', '1.5', '-i', join(clips, 'audio.m4a'), '-c:a', 'aac', '-b:a', '128k', join(clips, 'audio-trim.m4a')]);

    const binary = join(dir, 'media-pipeline');
    const sources = ['AnalysisMath', 'AudioDecode', 'AudioSync', 'MediaFingerprint', 'MediaStore', 'ProxyPipeline'].map((name) => join(engine, `ios/${name}.swift`));
    execFileSync('xcrun', ['swiftc', '-O', ...sources, join(engine, 'parity/media-pipeline/main.swift'), '-o', binary]);
    const run = spawnSync(binary, [clips, join(dir, 'scratch')], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe('ok');
  }, 240000);
});
