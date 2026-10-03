import { spawn } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  COLOR_PIPELINE_VERSION, normalizeFilter, outputColorArgs, outputColorFilter, probeColor, zscaleAvailable,
  type SourceColor,
} from './color.js';

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export async function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-3000)}`));
    });
  });
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [numerator = '0', denominator = '1'] = rate.split('/');
  const divisor = Number(denominator);
  return divisor === 0 ? 0 : Number(numerator) / divisor;
}

/**
 * The demuxers an upload may be opened with. ffprobe sniffs content, not the
 * extension, so without this an HLS playlist or ffconcat script uploaded as
 * clip.mp4 is opened as a playlist and its URLs (local files, network) are
 * followed. Every later ffmpeg on the file sniffs the same way, so passing the
 * probe here is what keeps them on these formats too.
 */
export const ALLOWED_DEMUXERS = [
  'mov', // mov,mp4,m4a,3gp,3g2,mj2 (and HEIC stills on ffmpeg before 7.1)
  'matroska', 'webm', 'avi', 'mpegts',
  'mp3', 'wav', 'aac', 'flac', 'ogg', 'aiff', 'caf', 'amr', 'amrnb', 'amrwb',
  'image2', 'png_pipe', 'jpeg_pipe', 'gif', 'apng', 'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'heif',
  // Never playlist or script demuxers (hls, concat, dash, ...): they open the URLs a file names.
] as const;

/** Thrown when an upload is not a media container the server accepts. */
export class UnsupportedMediaError extends Error {
  constructor(message = 'This file is not a supported video, audio or image format.') {
    super(message);
    this.name = 'UnsupportedMediaError';
  }
}

export async function probeMedia(path: string): Promise<ProbeResult> {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error', '-format_whitelist', ALLOWED_DEMUXERS.join(','), '-show_entries',
    'format=duration:stream=index,codec_type,width,height,r_frame_rate,duration',
    '-of', 'json', path,
  ]).catch((error: unknown) => {
    if (error instanceof Error && /not on whitelist/i.test(error.message)) throw new UnsupportedMediaError();
    throw error;
  });
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  return {
    duration: Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseRate(video?.r_frame_rate),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}

/**
 * The proxy's -vf chain. Scale FIRST: the HLG->SDR tonemap converts frames to
 * float RGB, and doing that at 3840x2160 instead of 540p was most of a 4K
 * import's wait (stand-up clip, M4 Max: 212s -> 69s software, 26s with
 * hardware decode; scripts/bench-proxy.ts, SSIM 0.98 vs the old order).
 */
export function proxyVideoFilter(normalize: string): string {
  return `scale=540:540:force_original_aspect_ratio=decrease:force_divisible_by=2,${normalize},${outputColorFilter('sdr', false)}`;
}

let hwDecode: Promise<string[]> | undefined;

/**
 * Hardware decode where this ffmpeg has it (VideoToolbox on macOS: 4K HEVC
 * 10-bit is the other big cost). Probed once; empty on hosts without it, such
 * as Fly's Linux machines, where decode stays in software.
 */
export async function hwDecodeArgs(): Promise<string[]> {
  hwDecode ??= runProcess('ffmpeg', ['-hide_banner', '-hwaccels'])
    .then(({ stdout }) => (/\bvideotoolbox\b/.test(stdout) ? ['-hwaccel', 'videotoolbox'] : []))
    .catch(() => []);
  return await hwDecode;
}

export async function createProxyAndThumbnail(
  sourcePath: string,
  destinationDirectory: string,
  probe: ProbeResult,
): Promise<{ proxyPath: string; thumbnailPath: string }> {
  await mkdir(destinationDirectory, { recursive: true });
  const proxyPath = join(destinationDirectory, 'proxy.mp4');
  const thumbnailPath = join(destinationDirectory, 'thumb.jpg');
  if (probe.hasVideo) {
    // Proxy and thumbnail share one normalization, so the library, the preview
    // and the export all describe the same colour.
    const color = await probeColor(sourcePath);
    const normalize = normalizeFilter(color, 'sdr', { zscale: await zscaleAvailable() });
    await runProcess('ffmpeg', [
      '-y', ...await hwDecodeArgs(), '-i', sourcePath,
      '-vf', proxyVideoFilter(normalize),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
      // A keyframe every second: x264's default ~250-frame GOP makes every
      // preview seek decode seconds of video. Costs little at CRF 27.
      // Proxies made before this keep their long GOP until re-imported.
      '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
      ...outputColorArgs('sdr', false),
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', proxyPath,
    ]);
    await renderThumbnail(sourcePath, thumbnailPath, probe, normalize);
    await writeColorSidecar(destinationDirectory, color);
  } else {
    await runProcess('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `color=c=0x171721:s=960x540:r=30:d=${Math.max(probe.duration, 0.1)}`,
      '-i', sourcePath, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', proxyPath,
    ]);
    await runProcess('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=0x171721:s=720x405', '-frames:v', '1', thumbnailPath,
    ]);
  }
  return { proxyPath, thumbnailPath };
}

async function renderThumbnail(
  sourcePath: string,
  thumbnailPath: string,
  probe: Pick<ProbeResult, 'duration'>,
  normalize: string,
): Promise<void> {
  await runProcess('ffmpeg', [
    '-y', '-ss', String(Math.max(0, Math.min(probe.duration * 0.1, 2))),
    '-i', sourcePath, '-frames:v', '1', '-vf', `scale=720:-2,${normalize}`, '-q:v', '3', thumbnailPath,
  ]);
}

/** Records which pipeline produced the files in `directory` so stale ones can be spotted. */
async function writeColorSidecar(directory: string, source: SourceColor): Promise<void> {
  await writeFile(join(directory, 'color.json'), JSON.stringify({ version: COLOR_PIPELINE_VERSION, source }));
}

/**
 * Re-shoot one thumbnail through the current colour pipeline. Assets imported
 * before it existed carry a cast the preview does not; the thumb route calls
 * this the first time such an asset is browsed.
 */
export async function regenerateThumbnail(
  sourcePath: string,
  thumbnailPath: string,
  probe: Pick<ProbeResult, 'duration'>,
): Promise<void> {
  const color = await probeColor(sourcePath);
  await renderThumbnail(sourcePath, thumbnailPath, probe, normalizeFilter(color, 'sdr', { zscale: await zscaleAvailable() }));
  await writeColorSidecar(dirname(thumbnailPath), color);
}

export const FILMSTRIP_TILES = 20;
export const FILMSTRIP_TILE_HEIGHT = 160;

/**
 * Render a filmstrip: FILMSTRIP_TILES frames sampled evenly across [0, duration], tiled
 * FILMSTRIP_TILES x 1 left to right, each tile FILMSTRIP_TILE_HEIGHT tall (width follows aspect).
 * Written atomically so a concurrent reader never sees a half-encoded JPEG.
 */
export async function createFilmstrip(
  sourcePath: string,
  destinationPath: string,
  source: { duration: number; fps: number },
): Promise<string> {
  const frames = Math.max(1, Math.round(source.duration * source.fps));
  const step = Math.max(1, Math.floor(frames / FILMSTRIP_TILES));
  const pending = `${destinationPath}.${process.pid}.tmp.jpg`;
  await runProcess('ffmpeg', [
    '-y', '-i', sourcePath, '-an',
    '-vf', `select='not(mod(n\\,${step}))',scale=-2:${FILMSTRIP_TILE_HEIGHT},tile=${FILMSTRIP_TILES}x1`,
    '-frames:v', '1', '-q:v', '4', '-fps_mode', 'vfr', pending,
  ]);
  await rename(pending, destinationPath);
  return destinationPath;
}

export async function analyzeScenes(path: string, duration: number): Promise<{
  cutCount: number;
  cutDensity: number;
  averageShotLength: number;
}> {
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-i', path, '-vf', "select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-',
  ]);
  const cutCount = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].length;
  const shotCount = cutCount + 1;
  return {
    cutCount,
    cutDensity: duration > 0 ? cutCount / duration : 0,
    averageShotLength: duration > 0 ? duration / shotCount : 0,
  };
}

export async function analyzeLoudness(path: string): Promise<number | null> {
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-i', path, '-filter_complex', 'ebur128=framelog=verbose', '-f', 'null', '-',
  ]);
  const matches = [...stderr.matchAll(/\bI:\s*(-?[0-9.]+)\s*LUFS/g)];
  const value = matches.at(-1)?.[1];
  return value === undefined ? null : Number(value);
}

export async function binaryAvailable(binary: string): Promise<boolean> {
  try {
    await runProcess(binary, ['-version']);
    return true;
  } catch {
    return false;
  }
}
