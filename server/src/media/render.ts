import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { Clip, Project } from '@editify/shared';
import type { AssetStore, StoredAsset } from '../db/asset-store.js';
import { rendersRoot } from '../config.js';
import { writeAssFile } from './ass.js';
import { rasterizeCallout } from './callout.js';
import { isHdr, normalizeFilter, outputColorArgs, outputColorFilter, probeColor, zscaleAvailable, type HdrHandling, type SourceColor } from './color.js';
import { duckExpression, duckWindows } from './duck.js';
import { rasterizeEmoji } from './emoji.js';
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

/** `seek` is where this clip's inputs open the source; every trim is relative to it. */
interface InputClip {
  clip: Clip;
  asset: StoredAsset;
  kind: 'video' | 'audio';
  plan: TransitionPlan | undefined;
  seek: number;
}
/** `assetPath` is set only for b-roll — an overlay clip on a video asset, which needs colour work. */
interface StickerInput { clip: Clip; source: string; assetPath?: string | undefined }

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

/*
 * Input strategy: the picture is rendered in short windows, each by its own
 * ffmpeg that opens only the clips in that window (seeked at the input), and
 * the windows stream as raw frames into one final ffmpeg that adds stickers,
 * captions and the audio mix once.
 *
 * The old single graph opened every clip as its own full-resolution input for
 * the whole render, and each decoder parks a queue of decoded 4k pictures
 * whether or not its clip is on screen yet. Measured with
 * scripts/bench-render.ts (one 60 s 2160x3840 source, 30 out-of-order cuts, two
 * speed changes, a crossfade, 1080p out, 14-core Mac, peak RSS of the ffmpeg
 * tree; the old graph's peak wanders from run to run):
 *
 *   old graph                                   6.3 to 8.8 GB   47 to 71 s
 *   one input per clip, -ss/-t at the input     7.65 GB         21.5 s  (-threads 2)
 *                                               6.59 GB         30.1 s  (-threads 1)
 *   windows piped into one final pass           1.40 to 1.43 GB 20.6 to 25.7 s
 *
 * The windowed output matched the old graph frame for frame (framemd5 over
 * all 1800 frames); the mixed audio differed by at most 1.5e-8 before AAC,
 * float rounding from amix seeing differently sized frames.
 *
 * Input seeking alone cannot fix it: the cost is one parked 4k queue per open
 * input, and every input is open from the first frame. Fanning one input out
 * with split was not tried as a strategy: out-of-order cuts make split buffer
 * every frame a later branch has not reached yet.
 *
 * Nothing is re-encoded between the stages: windows hand over raw frames
 * through y4m on a pipe, so the final pass sees the same pixels the old graph
 * had at the same point, and no intermediate lands on disk.
 */

/**
 * Decoder threads per file input. ffmpeg's default is one frame thread per
 * core, and every frame thread pins its own full-size 4k picture, per input.
 * Two keeps a single 4k decode moving without multiplying that by the core
 * count. Decoded pictures are identical at any thread count.
 */
const DECODE_ARGS = ['-threads', '2'];
/** Extra source read past a clip's trim end, so the input cut never lands inside the trim. */
const SPAN_MARGIN = 0.5;
const BASE_COLOR = '0x0B0B0F';

/**
 * Where a clip's input opens its source: 0.2 to 0.3 s before the in point, on
 * a whole tenth. The lead gives AAC a packet of pre-roll so the first samples
 * decode the same as they would mid-stream; the whole tenth keeps the seek
 * exact in every container timebase, so `in - seek` trims on the same
 * microsecond the unseeked graph did.
 */
function seekPoint(sourceIn: number): number {
  return Math.max(0, Math.floor(sourceIn * 10 - 2) / 10);
}

/** A source time as a trim argument on an input opened at `seek`. Unseeked inputs keep their exact string. */
function sinceSeek(time: string, seek: number): string {
  return seek === 0 ? time : String(Number((Number(time) - seek).toFixed(6)));
}

/** Input options that open only the part of the source a clip reads. */
function seekArgs(input: InputClip): string[] {
  const span = input.clip.out + (input.plan?.extendSourceBy ?? 0) - input.seek + SPAN_MARGIN;
  return [...(input.seek > 0 ? ['-ss', timeArg(input.seek)] : []), '-t', timeArg(span)];
}

/**
 * Input options for a clip's audio in the final pass: seek, but leave the trim
 * to the clip's own atrim. An accurate `-ss` or any `-t` makes the ffmpeg CLI
 * splice its own trim filter onto the input, and that extra filter changes how
 * the graph negotiates channel layouts: a mono clip gets upmixed to stereo
 * before atempo and afade instead of at amix, as in the single graph. The
 * samples then differ by float round-off (about 1e-8). That is inaudible, but
 * once one AAC frame quantizes differently the encoder's state drifts and the
 * export no longer decodes like the single graph's. Every ffmpeg version does
 * this; whether a given input tips is luck, which is why the white noise test
 * passed on 7.1 and failed on 5.1 and 6.1. `-noaccurate_seek` drops the
 * spliced trim, and the timestamps stay exact because ffmpeg still offsets them
 * by the requested seek: the clip's atrim cuts on the same sample, from a
 * demuxer seek that lands at or before the seek point.
 */
function audioSeekArgs(input: InputClip): string[] {
  return input.seek > 0 ? ['-noaccurate_seek', '-ss', timeArg(input.seek)] : [];
}

/** The clip's trim bounds on its seeked input. A crossfading clip keeps rolling past its out point. */
function trimRange(input: InputClip): { start: string; end: string } {
  const { clip, plan, seek } = input;
  const sourceEnd = plan?.extendSourceBy ? timeArg(clip.out + plan.extendSourceBy) : `${clip.out}`;
  return { start: sinceSeek(`${clip.in}`, seek), end: sinceSeek(sourceEnd, seek) };
}

/** A picture clip placed in the window plan. Frame numbers are output frames. */
interface Picture {
  input: InputClip;
  /** Draw order: higher sits on top. */
  stack: number;
  /** The output frame the clip first shows on. */
  first: number;
  /** Bounds on the frame after its last one, a few frames loose on each side. */
  endAtLeast: number;
  endAtMost: number;
  /** Opaque clips hide everything under them; a crossfade's alpha fade-in does not. */
  opaque: boolean;
}

interface RenderWindow { start: number; frames: number; pictures: Picture[] }

/**
 * Splits the picture into windows that can render independently. A window
 * may start at a clip's first frame only if that clip is opaque and sits on
 * top of everything still showing from before, for at least as long: then the
 * earlier clips can stop at the boundary without a visible change. Crossfades
 * therefore stay in one window with the clip they blend into. Window 0 always
 * holds a clip, so every window runs through at least one overlay and hands
 * over the same pixel format.
 */
function planWindows(pictures: Picture[], totalFrames: number): RenderWindow[] {
  const visible = pictures.filter((picture) => picture.first < totalFrames);
  if (visible.length === 0) return [];
  const earliest = Math.min(...visible.map((picture) => picture.first));
  const starts = [0];
  for (const boundary of [...new Set(visible.map((picture) => picture.first))].sort((left, right) => left - right)) {
    if (boundary <= earliest) continue;
    const cover = visible
      .filter((picture) => picture.first === boundary && picture.opaque)
      .reduce<Picture | undefined>((top, picture) => (top && top.stack > picture.stack ? top : picture), undefined);
    if (!cover) continue;
    const hidden = visible
      .filter((picture) => picture.first < boundary && picture.endAtMost > boundary)
      .every((picture) => picture.stack < cover.stack && picture.endAtMost <= cover.endAtLeast);
    if (hidden) starts.push(boundary);
  }
  return starts.map((start, index) => {
    const next = starts[index + 1] ?? totalFrames;
    return {
      start,
      frames: next - start,
      pictures: visible.filter((picture) => picture.first >= start && picture.first < next),
    };
  });
}

/** ffmpeg with stderr kept for the error message, like runProcess, plus optional pipes. */
function startFfmpeg(args: string[], pipes: { stdin?: boolean; stdout?: boolean }): { child: ChildProcess; done: Promise<void> } {
  const child = spawn('ffmpeg', args, { stdio: [pipes.stdin ? 'pipe' : 'ignore', pipes.stdout ? 'pipe' : 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code ?? signal}: ${stderr}`));
    });
  });
  // The caller races or awaits it; this only stops an early failure being "unhandled".
  done.catch(() => undefined);
  return { child, done };
}

/**
 * Streams one window's y4m into the final pass. Every window writes its own
 * stream header; the first one opens the final input and later ones must match
 * it exactly, then are dropped so the frames read as one continuous stream.
 */
async function pumpWindow(source: NodeJS.ReadableStream, sink: Writable, header: { line?: Buffer }, stoppedEarly: Promise<never>): Promise<void> {
  let pending: Buffer | undefined = Buffer.alloc(0);
  for await (const piece of source) {
    let chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    if (pending) {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline < 0) continue;
      const line = pending.subarray(0, newline + 1);
      if (!header.line) {
        header.line = Buffer.from(line);
        chunk = pending;
      } else if (header.line.equals(line)) {
        chunk = pending.subarray(newline + 1);
      } else {
        throw new Error(`Render windows disagree on frame format: ${header.line.toString().trim()} vs ${line.toString().trim()}`);
      }
      pending = undefined;
    }
    if (!sink.write(chunk)) {
      await Promise.race([new Promise((resolve) => { sink.once('drain', resolve); }), stoppedEarly]);
    }
  }
}

/** Runs the final pass with each window's frames piped in, in order, one window process at a time. */
async function runWindowed(finalArgs: string[], windowArgs: string[][]): Promise<void> {
  const final = startFfmpeg(finalArgs, { stdin: windowArgs.length > 0 });
  if (windowArgs.length === 0) return await final.done;
  let finalError: unknown;
  final.done.catch((error: unknown) => { finalError = error; });
  const sink = final.child.stdin as Writable;
  // A final pass that dies mid-write surfaces through `final.done`, not as an EPIPE crash.
  sink.on('error', () => undefined);
  const stoppedEarly = final.done.then(() => { throw new Error('ffmpeg stopped reading render windows early'); });
  stoppedEarly.catch(() => undefined);
  let current: ChildProcess | undefined;
  try {
    const header: { line?: Buffer } = {};
    for (const args of windowArgs) {
      const window = startFfmpeg(args, { stdout: true });
      current = window.child;
      await pumpWindow(window.child.stdout as NodeJS.ReadableStream, sink, header, stoppedEarly);
      await Promise.race([window.done, stoppedEarly]);
    }
    sink.end();
    await final.done;
  } catch (error) {
    // Read before the kill below, which would replace it with a SIGKILL exit.
    const ownFailure = finalError;
    current?.kill('SIGKILL');
    final.child.kill('SIGKILL');
    await final.done.catch(() => undefined);
    // The final pass's own error says more than "stopped reading" when it has one.
    throw ownFailure ?? error;
  }
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
  const inputs: InputClip[] = [];
  const stickers: StickerInput[] = [];
  const transitionPlans = new Map<string, TransitionPlan>();
  /** Emoji and callouts that could not be rasterized fall back to the ASS pass. */
  const assStickerIds: string[] = [];
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
        stickers.push({ clip, source, assetPath: videoOverlayPath });
        continue;
      }
      if (!clip.assetId) continue;
      const asset = assets.get(clip.assetId);
      if (!asset) throw new Error(`Asset ${clip.assetId} referenced by clip ${clip.id} was not found`);
      inputs.push({ clip, asset, kind: track.kind, plan: transitionPlans.get(clip.id), seek: seekPoint(clip.in) });
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

  /**
   * One clip's picture, placed on the timeline. `shift` moves it back by whole
   * frames into a window that starts `shift` frames in; integer frames keep the
   * placement bit-exact, since setpts truncates the same way either side.
   */
  function pictureChain(input: InputClip, source: string, label: string, shift: number): string {
    const { clip, asset, plan } = input;
    const speed = clip.speed ?? 1;
    const trim = trimRange(input);
    const transform = clip.transform ?? { scale: 1, x: 0, y: 0 };
    // A crossfade the source has no frames left for holds its last one instead.
    const hold = plan?.holdLastFrameFor ? `tpad=stop_mode=clone:stop_duration=${timeArg(plan.holdLastFrameFor)},` : '';
    const formatted = `${hold}${normalize(asset.originalPath, Boolean(plan?.videoFadeIn?.alpha))}${videoFades(plan)}`;
    const place = `setpts=PTS+${clip.start}/TB${shift > 0 ? `-${shift}` : ''}`;
    if (clip.transformEnd) {
      // Animated zoom: cover-scale to an oversized frame, then zoompan tweens
      // scale and pan per frame across the clip.
      // ponytail: pre-scale capped at 2x for memory; zooms past 2x go soft. Raise if 4k punch-ins matter.
      const oversample = Math.min(2, Math.max(1, transform.scale, clip.transformEnd.scale));
      const overWidth = Math.round(width * oversample / 2) * 2;
      const overHeight = Math.round(height * oversample / 2) * 2;
      return `[${source}]trim=start=${trim.start}:end=${trim.end},setpts=(PTS-STARTPTS)/${speed},fps=${project.fps},` +
        `scale=${overWidth}:${overHeight}:force_original_aspect_ratio=increase,crop=${overWidth}:${overHeight},` +
        `${zoomFilter(clip, (clip.out - clip.in) / speed, width, height, project.fps)},` +
        `${formatted},${place}[${label}]`;
    }
    const scaledWidth = Math.max(width, Math.round(width * transform.scale / 2) * 2);
    const scaledHeight = Math.max(height, Math.round(height * transform.scale / 2) * 2);
    return `[${source}]trim=start=${trim.start}:end=${trim.end},setpts=(PTS-STARTPTS)/${speed},` +
      `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height}:(iw-${width})/2*(1+${transform.x}):(ih-${height})/2*(1+${transform.y}),` +
      `fps=${project.fps},${formatted},${place}[${label}]`;
  }

  // The frame count is one past what the output can hold, so the last window
  // never comes up short; the final pass's -t trims the spare.
  const totalFrames = Math.ceil(duration * project.fps) + 1;
  const pictures: Picture[] = inputs
    .filter((input) => input.kind === 'video' && input.asset.width > 0 && input.asset.height > 0)
    .map((input, stack) => {
      const seconds = (input.clip.out + (input.plan?.extendSourceBy ?? 0) - input.clip.in) / (input.clip.speed ?? 1)
        + (input.plan?.holdLastFrameFor ?? 0);
      // setpts truncates PTS+start/TB, and the chain's first frame is PTS 0; this is that same double arithmetic.
      const first = Math.trunc(input.clip.start / (1 / project.fps));
      return {
        input,
        stack,
        first,
        endAtLeast: first + Math.floor(seconds * project.fps) - 2,
        endAtMost: first + Math.ceil(seconds * project.fps) + 2,
        opaque: !input.plan?.videoFadeIn?.alpha,
      };
    });
  const windows = planWindows(pictures, totalFrames);
  const windowArgs = windows.map((window) => {
    const args = ['-f', 'lavfi', '-i', `color=c=${BASE_COLOR}:s=${width}x${height}:r=${project.fps}`];
    const filters = [`[0:v]format=${basePixelFormat}[base0]`];
    let current = 'base0';
    window.pictures.forEach((picture, index) => {
      args.push(...DECODE_ARGS, ...seekArgs(picture.input), '-an', '-i', picture.input.asset.originalPath);
      filters.push(pictureChain(picture.input, `${index + 1}:v`, `vclip${index}`, window.start));
      filters.push(`[${current}][vclip${index}]overlay=eof_action=pass:shortest=0[vbase${index + 1}]`);
      current = `vbase${index + 1}`;
    });
    // overlay's default yuv420 mode hands back 8-bit 4:2:0 whatever the base
    // was: plain yuv420p over an SDR base, where this is a no-op, and yuva420p
    // over a 10-bit one, where the alpha is opaque everywhere and y4m cannot
    // carry it. The final pass's overlay puts that same opaque alpha back.
    filters.push(`[${current}]format=yuv420p[vwindow]`);
    return [
      ...args, '-filter_complex', filters.join(';'), '-map', '[vwindow]',
      '-frames:v', String(window.frames), '-f', 'yuv4mpegpipe', 'pipe:1',
    ];
  });

  const args = [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${BASE_COLOR}:s=${width}x${height}:r=${project.fps}:d=${duration}`,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${duration}`,
  ];
  let nextInputIndex = 2;
  const filters: string[] = [`[0:v]format=${basePixelFormat}[base0]`, `[1:a]atrim=0:${duration},asetpts=PTS-STARTPTS[asilence]`];
  let currentVideo = 'base0';
  if (windows.length > 0) {
    // The windows' frames go over this canvas like one full-frame clip: the
    // output frames keep the canvas's own properties, as they did when every
    // clip was overlaid onto it directly.
    args.push('-f', 'yuv4mpegpipe', '-i', 'pipe:0');
    filters.push(`[base0][${nextInputIndex}:v]overlay=eof_action=pass:shortest=0[vpictures]`);
    currentVideo = 'vpictures';
    nextInputIndex += 1;
  }
  const audioLabels = ['[asilence]'];
  /** Audio-track clips that duck everything else: their labels, and their clips for the windows. */
  const duckerLabels: string[] = [];
  const duckerClips: Clip[] = [];

  for (const input of inputs) {
    const { clip, asset, plan } = input;
    if (!asset.hasAudio) continue;
    const speed = clip.speed ?? 1;
    const trim = trimRange(input);
    // Audio only: the picture was drawn by the windows.
    args.push(...audioSeekArgs(input), '-vn', '-i', asset.originalPath);
    const inputIndex = nextInputIndex;
    nextInputIndex += 1;
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
      `[${inputIndex}:a]atrim=start=${trim.start}:end=${trim.end},asetpts=PTS-STARTPTS,${atempoChain(speed)},` +
      `volume=${clip.volume ?? 1},${fadeIn},${fadeOut},` +
      `adelay=${delayMs}|${delayMs}[aclip${audioIndex}]`,
    );
    audioLabels.push(`[aclip${audioIndex}]`);
    if (input.kind === 'audio' && clip.duck) {
      duckerLabels.push(`[aclip${audioIndex}]`);
      duckerClips.push(clip);
    }
  }

  // Image/GIF stickers, callout cards and b-roll all sit above the video and
  // below captions, so text stays readable. The alpha format matches the base's
  // bit depth so overlay does not quietly drag a 10-bit master back to 8-bit.
  // ponytail: the ASS caption pass is still 8-bit, so an HDR export with
  // captions round-trips through 8-bit there. Fine until HDR captions matter.
  const overlayFormat = targetIsHdr ? 'yuva420p10le' : 'rgba';
  stickers.forEach((sticker, index) => {
    // Loop the source so GIF animations run for the sticker's whole window.
    args.push(...DECODE_ARGS, '-stream_loop', '-1', '-i', sticker.source);
    const inputIndex = nextInputIndex;
    nextInputIndex += 1;
    const placement = sticker.clip.overlay ?? { x: 0.5, y: 0.35, width: 0.28, rotation: 0 };
    const stickerWidth = Math.max(2, Math.round(width * placement.width / 2) * 2);
    const radians = (placement.rotation * Math.PI) / 180;
    const rotate = placement.rotation === 0 ? '' : `,rotate=${radians.toFixed(5)}:c=none:ow='rotw(${radians.toFixed(5)})':oh='roth(${radians.toFixed(5)})'`;
    const begin = sticker.clip.start;
    const end = sticker.clip.start + (sticker.clip.out - sticker.clip.in) / (sticker.clip.speed ?? 1);
    // B-roll gets the same normalization as a main clip before it turns rgba;
    // PNG stickers are already sRGB and just need the alpha format.
    const prefix = sticker.assetPath ? `${normalize(sticker.assetPath, false)},` : '';
    filters.push(`[${inputIndex}:v]${prefix}format=${overlayFormat},scale=${stickerWidth}:-2${rotate}[stk${index}]`);
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
  await runWindowed(args, windowArgs);
  return outputPath;
}
