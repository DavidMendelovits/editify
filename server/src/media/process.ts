import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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

export async function probeMedia(path: string): Promise<ProbeResult> {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration:stream=index,codec_type,width,height,r_frame_rate,duration',
    '-of', 'json', path,
  ]);
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

export async function createProxyAndThumbnail(
  sourcePath: string,
  destinationDirectory: string,
  probe: ProbeResult,
): Promise<{ proxyPath: string; thumbnailPath: string }> {
  await mkdir(destinationDirectory, { recursive: true });
  const proxyPath = join(destinationDirectory, 'proxy.mp4');
  const thumbnailPath = join(destinationDirectory, 'thumb.jpg');
  if (probe.hasVideo) {
    await runProcess('ffmpeg', [
      '-y', '-i', sourcePath,
      '-vf', 'scale=540:540:force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', proxyPath,
    ]);
    await runProcess('ffmpeg', [
      '-y', '-ss', String(Math.max(0, Math.min(probe.duration * 0.1, 2))),
      '-i', sourcePath, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', thumbnailPath,
    ]);
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
