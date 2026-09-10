import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clip, Project } from '@editify/shared';
import type { AssetStore, StoredAsset } from '../db/asset-store.js';
import { rendersRoot } from '../config.js';
import { writeAssFile } from './ass.js';
import { rasterizeCallout } from './callout.js';
import { isHdr, normalizeFilter, outputColorArgs, outputColorFilter, probeColor, zscaleAvailable, type HdrHandling, type SourceColor } from './color.js';
import { duckExpression, duckWindows } from './duck.js';
import { rasterizeEmoji } from './emoji.js';
import { runProcess } from './process.js';
import { planTransitions, type TransitionPlan } from './transitions.js';

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
/** `assetPath` is set only for b-roll — an overlay clip on a video asset, which needs colour work. */
interface StickerInput { clip: Clip; inputIndex: number; assetPath?: string | undefined }

/** Filtergraph time argument — millisecond precision keeps float noise out of the graph. */
function timeArg(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** Transition fades ride in the clip's own time, before its absolute offset. */
function videoFades(plan: TransitionPlan | undefined): string {
  const fades: string[] = [];
  if (plan?.videoFadeIn) {
    fades.push(`fade=t=in:st=0:d=${timeArg(plan.videoFadeIn.d)}${plan.videoFadeIn.alpha ? ':alpha=1' : ''}`);
  }
  if (plan?.videoFadeOut) {
    fades.push(`fade=t=out:st=${timeArg(plan.videoFadeOut.st)}:d=${timeArg(plan.videoFadeOut.d)}`);
  }
  return fades.map((fade) => `,${fade}`).join('');
}

/**
 * Linear zoom pose over the clip: zoompan expressions for scale and pan.
 * `seconds` is the clip's own duration even when its trim is extended for a
 * following crossfade, so the pose lands on time and then holds.
 */
function zoomFilter(clip: Clip, seconds: number, width: number, height: number, fps: number): string {
  const from = clip.transform ?? { scale: 1, x: 0, y: 0 };
  const to = clip.transformEnd ?? from;
  const frames = Math.max(1, Math.round(seconds * fps));
  // p ramps 0→1 across the clip's own frames.
  const p = `min(on/${frames},1)`;
  const lerp = (a: number, b: number): string => (a === b ? a.toFixed(5) : `(${a.toFixed(5)}+${(b - a).toFixed(5)}*${p})`);
  const zoom = lerp(Math.max(1, from.scale), Math.max(1, to.scale));
  const panX = lerp((1 + from.x) / 2, (1 + to.x) / 2);
  const panY = lerp((1 + from.y) / 2, (1 + to.y) / 2);
  return `zoompan=z='${zoom}':x='(iw-iw/zoom)*${panX}':y='(ih-ih/zoom)*${panY}':d=1:s=${width}x${height}:fps=${fps}`;
}

export async function renderProject(
  project: Project,
  resolution: Resolution,
  renderId: string,
  assets: AssetStore,
  hdr: HdrHandling = 'sdr',
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
  const stickers: StickerInput[] = [];
  const transitionPlans = new Map<string, TransitionPlan>();
  /** Emoji and callouts that could not be rasterized fall back to the ASS pass. */
  const assStickerIds: string[] = [];
  let nextInputIndex = 2;
  for (const track of project.tracks) {
    if (track.kind === 'caption') continue;
    // Timeline order, so overlapping clips stack the same way the preview draws them.
    const orderedClips = [...track.clips].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
    // A crossfade borrows frames from the clip before it, so the whole track is
    // planned before any of its clips becomes a stream.
    if (track.kind === 'video' && orderedClips.some((clip) => clip.transition)) {
      const durations = new Map<string, number>();
      for (const clip of orderedClips) {
        const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
        if (asset) durations.set(asset.id, asset.duration);
      }
      for (const [id, plan] of planTransitions(orderedClips, durations, project.fps)) transitionPlans.set(id, plan);
    }
    for (const clip of orderedClips) {
      if (track.kind === 'overlay') {
        let source: string | undefined;
        let videoOverlayPath: string | undefined;
        if (clip.assetId) {
          const asset = assets.get(clip.assetId);
          if (!asset) throw new Error(`Asset ${clip.assetId} referenced by sticker ${clip.id} was not found`);
          // B-roll is an overlay clip on a VIDEO asset at full-frame placement:
          // it rides this same path, picture only — nothing below maps [N:a].
          source = asset.originalPath;
          if (asset.mimeType.startsWith('video/')) videoOverlayPath = source;
        } else if (clip.callout && clip.text) {
          // Callout cards: CoreText draws the rounded card, verdict glyph and
          // label to a transparent PNG, then the sticker chain places it.
          source = await rasterizeCallout({ ...clip.callout, text: clip.text }) ?? undefined;
          if (!source) assStickerIds.push(clip.id);
        } else if (clip.text) {
          // Emoji/text stickers: CoreText rasterizes to a transparent PNG so
          // color emoji survive export (libass draws them as tofu boxes).
          source = await rasterizeEmoji(clip.text) ?? undefined;
          if (!source) assStickerIds.push(clip.id);
        }
        if (!source) continue;
        // Loop the source so GIF animations run for the sticker's whole window.
        args.push('-stream_loop', '-1', '-i', source);
        stickers.push({ clip, inputIndex: nextInputIndex, assetPath: videoOverlayPath });
        nextInputIndex += 1;
        continue;
      }
      if (!clip.assetId) continue;
      const asset = assets.get(clip.assetId);
      if (!asset) throw new Error(`Asset ${clip.assetId} referenced by clip ${clip.id} was not found`);
      args.push('-i', asset.originalPath);
      inputs.push({ clip, asset, inputIndex: nextInputIndex, kind: track.kind });
      nextInputIndex += 1;
    }
  }

  // Colour is probed for every video source up front: the graph builder below
  // is synchronous, and each original is only probed once anyway.
  const zscale = await zscaleAvailable();
  const sourceColors = new Map<string, SourceColor>();
  for (const path of new Set([
    ...inputs.filter((input) => input.kind === 'video').map((input) => input.asset.originalPath),
    ...stickers.map((sticker) => sticker.assetPath).filter((path): path is string => Boolean(path)),
  ])) {
    sourceColors.set(path, await probeColor(path));
  }
  const anyInputIsHdr = [...sourceColors.values()].some(isHdr);
  const targetIsHdr = hdr === 'hdr' && anyInputIsHdr;
  /** The chain that lands one source in the output space; alpha for crossfades. */
  function normalize(path: string | undefined, alpha: boolean): string {
    const color = sourceColors.get(path ?? '');
    const chain = color ? normalizeFilter(color, hdr, { zscale }) : `format=${targetIsHdr ? 'yuv420p10le' : 'yuv420p'}`;
    // fade=alpha=1 needs an alpha channel, so the chain re-lands in yuva420p.
    return alpha ? `${chain},format=yuva420p` : chain;
  }

  const basePixelFormat = targetIsHdr ? 'yuv420p10le' : 'yuv420p';
  const filters: string[] = [`[0:v]format=${basePixelFormat}[base0]`, `[1:a]atrim=0:${duration},asetpts=PTS-STARTPTS[asilence]`];
  let currentVideo = 'base0';
  let videoNumber = 0;
  const audioLabels = ['[asilence]'];
  /** Audio-track clips that duck everything else: their labels, and their clips for the windows. */
  const duckerLabels: string[] = [];
  const duckerClips: Clip[] = [];

  for (const input of inputs) {
    const { clip, asset, inputIndex } = input;
    const speed = clip.speed ?? 1;
    const plan = transitionPlans.get(clip.id);
    // A clip crossfading into the next one keeps rolling past its out point.
    const trimEnd = plan?.extendSourceBy ? timeArg(clip.out + plan.extendSourceBy) : `${clip.out}`;
    if (input.kind === 'video' && asset.width > 0 && asset.height > 0) {
      const transform = clip.transform ?? { scale: 1, x: 0, y: 0 };
      const formatted = `${normalize(asset.originalPath, Boolean(plan?.videoFadeIn?.alpha))}${videoFades(plan)}`;
      if (clip.transformEnd) {
        // Animated zoom: cover-scale to an oversized frame, then zoompan tweens
        // scale and pan per frame across the clip.
        // ponytail: pre-scale capped at 2x for memory; zooms past 2x go soft. Raise if 4k punch-ins matter.
        const oversample = Math.min(2, Math.max(1, transform.scale, clip.transformEnd.scale));
        const overWidth = Math.round(width * oversample / 2) * 2;
        const overHeight = Math.round(height * oversample / 2) * 2;
        filters.push(
          `[${inputIndex}:v]trim=start=${clip.in}:end=${trimEnd},setpts=(PTS-STARTPTS)/${speed},fps=${project.fps},` +
          `scale=${overWidth}:${overHeight}:force_original_aspect_ratio=increase,crop=${overWidth}:${overHeight},` +
          `${zoomFilter(clip, (clip.out - clip.in) / speed, width, height, project.fps)},` +
          `${formatted},setpts=PTS+${clip.start}/TB[vclip${videoNumber}]`,
        );
      } else {
        const scaledWidth = Math.max(width, Math.round(width * transform.scale / 2) * 2);
        const scaledHeight = Math.max(height, Math.round(height * transform.scale / 2) * 2);
        filters.push(
          `[${inputIndex}:v]trim=start=${clip.in}:end=${trimEnd},setpts=(PTS-STARTPTS)/${speed},` +
          `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height}:(iw-${width})/2*(1+${transform.x}):(ih-${height})/2*(1+${transform.y}),` +
          `fps=${project.fps},${formatted},setpts=PTS+${clip.start}/TB[vclip${videoNumber}]`,
        );
      }
      filters.push(`[${currentVideo}][vclip${videoNumber}]overlay=eof_action=pass:shortest=0[vbase${videoNumber + 1}]`);
      currentVideo = `vbase${videoNumber + 1}`;
      videoNumber += 1;
    }
    if (asset.hasAudio) {
      const audioIndex = audioLabels.length;
      const delayMs = Math.round(clip.start * 1000);
      // 8ms edge fades make butt-joined cuts inaudible (UIST 2013 uses 5ms; jumpcutter ~9ms).
      const fade = 0.008;
      const segmentSeconds = (clip.out + (plan?.extendSourceBy ?? 0) - clip.in) / speed;
      const fadeOutStart = Math.max(0, segmentSeconds - fade);
      // Transition edges swap the edge fade for a tri fade: amix sums the two
      // overlapping halves back to roughly unity gain.
      const fadeIn = plan?.audioFadeIn === undefined
        ? `afade=t=in:curve=hsin:d=${fade}`
        : `afade=t=in:curve=tri:d=${timeArg(plan.audioFadeIn)}`;
      const fadeOut = plan?.audioFadeOut
        ? `afade=t=out:curve=tri:st=${timeArg(plan.audioFadeOut.st)}:d=${timeArg(plan.audioFadeOut.d)}`
        : `afade=t=out:curve=hsin:st=${fadeOutStart}:d=${fade}`;
      filters.push(
        `[${inputIndex}:a]atrim=start=${clip.in}:end=${trimEnd},asetpts=PTS-STARTPTS,${atempoChain(speed)},` +
        `volume=${clip.volume ?? 1},${fadeIn},${fadeOut},` +
        `adelay=${delayMs}|${delayMs}[aclip${audioIndex}]`,
      );
      audioLabels.push(`[aclip${audioIndex}]`);
      if (input.kind === 'audio' && clip.duck) {
        duckerLabels.push(`[aclip${audioIndex}]`);
        duckerClips.push(clip);
      }
    }
  }

  // Image/GIF stickers, callout cards and b-roll all sit above the video and
  // below captions, so text stays readable. The alpha format matches the base's
  // bit depth so overlay does not quietly drag a 10-bit master back to 8-bit.
  // ponytail: the ASS caption pass is still 8-bit, so an HDR export with
  // captions round-trips through 8-bit there. Fine until HDR captions matter.
  const overlayFormat = targetIsHdr ? 'yuva420p10le' : 'rgba';
  stickers.forEach((sticker, index) => {
    const placement = sticker.clip.overlay ?? { x: 0.5, y: 0.35, width: 0.28, rotation: 0 };
    const stickerWidth = Math.max(2, Math.round(width * placement.width / 2) * 2);
    const radians = (placement.rotation * Math.PI) / 180;
    const rotate = placement.rotation === 0 ? '' : `,rotate=${radians.toFixed(5)}:c=none:ow='rotw(${radians.toFixed(5)})':oh='roth(${radians.toFixed(5)})'`;
    const begin = sticker.clip.start;
    const end = sticker.clip.start + (sticker.clip.out - sticker.clip.in) / (sticker.clip.speed ?? 1);
    // B-roll gets the same normalization as a main clip before it turns rgba;
    // PNG stickers are already sRGB and just need the alpha format.
    const prefix = sticker.assetPath ? `${normalize(sticker.assetPath, false)},` : '';
    filters.push(`[${sticker.inputIndex}:v]${prefix}format=${overlayFormat},scale=${stickerWidth}:-2${rotate}[stk${index}]`);
    filters.push(
      `[${currentVideo}][stk${index}]overlay=x=${Math.round(placement.x * width)}-w/2:y=${Math.round(placement.y * height)}-h/2` +
      `:enable='between(t,${begin},${end})'[vstk${index}]`,
    );
    currentVideo = `vstk${index}`;
  });

  const hasCaptions = project.tracks.some((track) => (
    track.kind === 'caption' && track.clips.some((clip) => Boolean(clip.text))
  )) || assStickerIds.length > 0;
  if (hasCaptions) {
    const assPath = join(destinationDirectory, 'captions.ass');
    const font = await writeAssFile(project, width, height, assPath, assStickerIds);
    const fontsDir = font.directory ? `:fontsdir='${filterPath(font.directory)}'` : '';
    filters.push(`[${currentVideo}]subtitles='${filterPath(assPath)}'${fontsDir}[vsubtitles]`);
    currentVideo = 'vsubtitles';
  }

  if (duckerLabels.length > 0) {
    // The bed — base silence, video audio, ordinary music/SFX — is summed once,
    // dipped under the voice windows, then summed with the voice. Both amixes
    // use normalize=0, so this is the same sum as the plain mix below, with one
    // volume envelope in the middle.
    const bed = audioLabels.filter((label) => !duckerLabels.includes(label));
    filters.push(
      `${bed.join('')}amix=inputs=${bed.length}:duration=longest:normalize=0,` +
      `volume=volume='${duckExpression(duckWindows(duckerClips))}':eval=frame[abed]`,
    );
    filters.push(
      `[abed]${duckerLabels.join('')}amix=inputs=${duckerLabels.length + 1}:duration=longest:normalize=0,` +
      `atrim=0:${duration}[aout]`,
    );
  } else {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=0:${duration}[aout]`);
  }
  // Tag the frames themselves before they reach the encoder, not just the stream.
  filters.push(`[${currentVideo}]${outputColorFilter(hdr, anyInputIsHdr)}[vout]`);
  currentVideo = 'vout';
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `[${currentVideo}]`, '-map', '[aout]',
    '-t', String(duration),
    // An HDR master is HEVC main10 — x264 has no main10 profile, and PQ in
    // H.264 is not something players expect. SDR stays on the x264 path.
    ...(targetIsHdr ? ['-c:v', 'libx265', '-tag:v', 'hvc1'] : ['-c:v', 'libx264']),
    '-preset', 'medium', '-crf', '18',
    '-pix_fmt', basePixelFormat, ...outputColorArgs(hdr, anyInputIsHdr),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath,
  );
  await runProcess('ffmpeg', args);
  return outputPath;
}
