import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clip, Project } from '@editify/shared';
import type { AssetStore, StoredAsset } from '../db/asset-store.js';
import { rendersRoot } from '../config.js';
import { writeAssFile } from './ass.js';
import { runProcess } from './process.js';

type Resolution = '720p' | '1080p' | '4k';

function dimensions(format: Project['format'], resolution: Resolution): [number, number] {
  const short = resolution === '720p' ? 720 : resolution === '1080p' ? 1080 : 2160;
  if (format === '9:16') return [short, Math.round(short * 16 / 9)];
  if (format === '1:1') return [short, short];
  return [Math.round(short * 16 / 9), short];
}

function filterPath(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll(',', '\\,');
}

function atempoChain(speed: number): string {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(5)}`);
  return filters.join(',');
}

interface InputClip { clip: Clip; asset: StoredAsset; inputIndex: number; kind: 'video' | 'audio' }

export async function renderProject(
  project: Project,
  resolution: Resolution,
  renderId: string,
  assets: AssetStore,
): Promise<string> {
  const destinationDirectory = join(rendersRoot, renderId);
  await mkdir(destinationDirectory, { recursive: true });
  const outputPath = join(destinationDirectory, 'output.mp4');
  const [width, height] = dimensions(project.format, resolution);
  const duration = Math.max(project.duration, 0.1);
  const args = [
    '-y',
    '-f', 'lavfi', '-i', `color=c=0x0B0B0F:s=${width}x${height}:r=${project.fps}:d=${duration}`,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${duration}`,
  ];
  const inputs: InputClip[] = [];
  let nextInputIndex = 2;
  for (const track of project.tracks) {
    if (track.kind === 'caption') continue;
    for (const clip of track.clips) {
      if (!clip.assetId) continue;
      const asset = assets.get(clip.assetId);
      if (!asset) throw new Error(`Asset ${clip.assetId} referenced by clip ${clip.id} was not found`);
      args.push('-i', asset.originalPath);
      inputs.push({ clip, asset, inputIndex: nextInputIndex, kind: track.kind });
      nextInputIndex += 1;
    }
  }

  const filters: string[] = [`[0:v]format=yuv420p[base0]`, `[1:a]atrim=0:${duration},asetpts=PTS-STARTPTS[asilence]`];
  let currentVideo = 'base0';
  let videoNumber = 0;
  const audioLabels = ['[asilence]'];

  for (const input of inputs) {
    const { clip, asset, inputIndex } = input;
    const speed = clip.speed ?? 1;
    if (input.kind === 'video' && asset.width > 0 && asset.height > 0) {
      const transform = clip.transform ?? { scale: 1, x: 0, y: 0 };
      const scaledWidth = Math.max(width, Math.round(width * transform.scale / 2) * 2);
      const scaledHeight = Math.max(height, Math.round(height * transform.scale / 2) * 2);
      filters.push(
        `[${inputIndex}:v]trim=start=${clip.in}:end=${clip.out},setpts=(PTS-STARTPTS)/${speed},` +
        `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height}:(iw-${width})/2*(1+${transform.x}):(ih-${height})/2*(1+${transform.y}),` +
        `fps=${project.fps},format=yuv420p,setpts=PTS+${clip.start}/TB[vclip${videoNumber}]`,
      );
      filters.push(`[${currentVideo}][vclip${videoNumber}]overlay=eof_action=pass:shortest=0[vbase${videoNumber + 1}]`);
      currentVideo = `vbase${videoNumber + 1}`;
      videoNumber += 1;
    }
    if (asset.hasAudio) {
      const audioIndex = audioLabels.length;
      const delayMs = Math.round(clip.start * 1000);
      // 8ms edge fades make butt-joined cuts inaudible (UIST 2013 uses 5ms; jumpcutter ~9ms).
      const fade = 0.008;
      const segmentSeconds = (clip.out - clip.in) / speed;
      const fadeOutStart = Math.max(0, segmentSeconds - fade);
      filters.push(
        `[${inputIndex}:a]atrim=start=${clip.in}:end=${clip.out},asetpts=PTS-STARTPTS,${atempoChain(speed)},` +
        `volume=${clip.volume ?? 1},afade=t=in:curve=hsin:d=${fade},afade=t=out:curve=hsin:st=${fadeOutStart}:d=${fade},` +
        `adelay=${delayMs}|${delayMs}[aclip${audioIndex}]`,
      );
      audioLabels.push(`[aclip${audioIndex}]`);
    }
  }

  const hasCaptions = project.tracks.some((track) => track.kind === 'caption'
    && track.clips.some((clip) => Boolean(clip.text)));
  if (hasCaptions) {
    const assPath = join(destinationDirectory, 'captions.ass');
    const font = await writeAssFile(project, width, height, assPath);
    const fontsDir = font.directory ? `:fontsdir='${filterPath(font.directory)}'` : '';
    filters.push(`[${currentVideo}]subtitles='${filterPath(assPath)}'${fontsDir}[vsubtitles]`);
    currentVideo = 'vsubtitles';
  }

  filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=0:${duration}[aout]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `[${currentVideo}]`, '-map', '[aout]',
    '-t', String(duration), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath,
  );
  await runProcess('ffmpeg', args);
  return outputPath;
}
