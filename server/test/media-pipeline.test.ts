import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
/** The macOS CI job installs both: there a missing tool is a failure, not a skip. */
const required = process.platform === 'darwin' && Boolean(process.env.CI);
let dir: string | undefined;

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Async on purpose (as render-golden.test.ts): the clips, the build and the run take a minute
// or more on a CI runner, and a blocked event loop starves vitest's worker RPC ("Timeout calling
// onTaskUpdate"), which fails the file after every check passed.
const run = promisify(execFile);

async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
}

/** A tone whose loudness keeps moving, so its energy envelope has something to hash. */
const MOVING_TONE = "aevalsrc=exprs='0.5*sin(2*PI*440*t)*(0.55+0.45*sin(2*PI*1.7*t+3*sin(2*PI*0.31*t)))':sample_rate=48000";

describe.skipIf(!required && (!hasSwift || !hasFfmpeg))('device proxy pipeline and fingerprint (Swift)', () => {
  it('passes every check', async () => {
    expect(hasSwift, 'swiftc (xcrun) is required on macOS CI').toBe(true);
    expect(hasFfmpeg, 'ffmpeg with libx265 is required on macOS CI').toBe(true);
    dir = mkdtempSync(join(tmpdir(), 'editify-media-pipeline-'));
    const clips = join(dir, 'clips');
    mkdirSync(clips, { recursive: true });
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=50', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
      '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1',
      '-c:a', 'pcm_s16le', join(clips, 'hdr.mov'),
    ]);
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:a', 'aac', '-b:a', '128k', join(clips, 'sdr-big.mp4'),
    ]);
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=44100', '-t', '1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(clips, 'sdr-small.mov'),
    ]);
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      // In the bitstream too: AVFoundation reads the VUI when the container's colr atom is partial.
      '-x264-params', 'colorprim=smpte432:transfer=bt709:colormatrix=bt709',
      '-color_primaries', 'smpte432', '-color_trc', 'bt709', '-colorspace', 'bt709', join(clips, 'sdr-p3.mov'),
    ]);
    // A portrait phone clip: landscape pixels plus a 90 degree display matrix.
    await ffmpeg(['-display_rotation', '90', '-i', join(clips, 'sdr-big.mp4'), '-c', 'copy', join(clips, 'rotated.mov')]);
    await ffmpeg(['-f', 'lavfi', '-i', MOVING_TONE, '-t', '12', '-c:a', 'aac', '-b:a', '128k', join(clips, 'audio.m4a')]);
    await ffmpeg(['-i', join(clips, 'audio.m4a'), '-c', 'copy', join(clips, 'audio-remux.mov')]);
    await ffmpeg(['-i', join(clips, 'audio.m4a'), '-c:a', 'aac', '-b:a', '96k', join(clips, 'audio-reenc.m4a')]);
    await ffmpeg(['-ss', '1.5', '-i', join(clips, 'audio.m4a'), '-c:a', 'aac', '-b:a', '128k', join(clips, 'audio-trim.m4a')]);

    const binary = join(dir, 'media-pipeline');
    const sources = ['Core/AnalysisMath', 'Engine/AudioDecode', 'Core/AnalysisSupport', 'Core/AudioSync', 'Engine/MediaFingerprint', 'Core/MediaStore', 'Engine/ProxyPipeline']
      .map((name) => join(engine, `ios/${name}.swift`));
    // macOS 15: the log-transfer and async AVFoundation APIs the engine (iOS 26 floor) uses.
    const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos15.0`;
    await run('xcrun', ['swiftc', '-O', '-target', target, ...sources, join(engine, 'parity/media-pipeline/main.swift'), '-o', binary], { maxBuffer: 64 << 20 });
    // A non-zero exit rejects with its stdout and stderr; keep them for the assertions.
    const result = await run(binary, [clips, join(dir, 'scratch')], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .then(({ stdout, stderr }) => ({ status: 0, stdout, stderr }))
      .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({ status: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    expect(result.status, result.stderr).toBe(0);
    // GitHub's virtualized macOS runners log a paravirtual GPU driver probe on
    // stderr; anything else there is a real failure.
    const stderr = result.stderr.split('\n').filter((line) => line && !/^IOServiceMatchingfailed for: /.test(line));
    expect(stderr).toEqual([]);
    expect(result.stdout.trim()).toBe('ok');
  }, 240000);
});
