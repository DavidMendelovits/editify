import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { join } from 'node:path';
import {
  fontMetrics,
  parseRenderPlanForExecutor,
  planFrameCount,
  type PlanAssetRef,
  type PlanCallout,
  type PlanEmoji,
  type PlanCropKey,
  type PlanOverlay,
  type PlanVideoLayer,
  type PlanVideoSegment,
  type RenderPlan,
} from '@editify/shared';
import { measureLoudness } from '../../services/render-qa.js';
import { locateAssFont } from '../ass.js';
import { rasterizePlanEmoji } from '../emoji.js';
import { runProcess, UnsupportedMediaError } from '../process.js';
import type { SourceColor } from '../color.js';
import { planAss, spanFrames, type AssItem } from './ass.js';
import { loudnessFilters, planAudioJob, planLoudnessGain, keyValueAt, piecewiseLinear, type LoudnessDecision } from './audio.js';
import { encoderArgs, filterPath, fromWorkingSpace, hexToWorking, lutFiles, toWorkingSpace, type LutFiles } from './color.js';
import { gifTiming, orientationFilter, probePlanMedia, uprightSize, type GifTiming, type PlanMediaProbe } from './media.js';

/*
 * renderPlan: the server executor for RenderPlan v1 (plan P6, decisions 7A +
 * OV12, 4A + OV6). It draws what the plan says and decides nothing; every
 * size, time, layer order and fade comes from the plan. Legacy render.ts
 * (renderProject) stays behind the RENDER_PLAN flag for rollback.
 *
 * Shape (the legacy windowing, kept for memory): the picture is rendered in
 * windows of consecutive plan segments, each by its own ffmpeg that opens only
 * that window's sources, and the windows stream raw linear-light float frames
 * (gbrpf32le) into one final ffmpeg that composites the overlays and captions,
 * encodes to the plan's colour and muxes the measured, normalized, limited
 * audio master rendered beforehand.
 *
 * Compositing is in linear light, extended BT.2020 (see ./color.ts). Opacity
 * and dims are per-frame masks the executor computes from the keys exactly at
 * frame times (t = k / fps) and feeds as 1x1 float frames, scaled up with
 * zscale (point) and applied with maskedmerge / blend=multiply, so a
 * crossfade is linear-light alpha blending of the two pictures. Nothing on the
 * float path goes through swscale (which quantizes float to 16 bits and
 * clips above 1.0, losing HDR highlights): conversions are zscale, lut1d,
 * maskedmerge and blend only.
 *
 * Sampling: a layer shows the latest source frame with pts <= s + 1e-6, s =
 * srcStart + (t - segment.start) * speed (setpts shifts the source by
 * -(s0 + 1e-6) / speed, then fps with round=up picks, per output slot, the
 * last frame at or before it). Holds sample once at frameAt and repeat.
 *
 * INTENDED DIVERGENCES FROM LEGACY render.ts (all named in the schema):
 * - Linear-light fades: crossfades and dips blend linear light, so a
 *   crossfade stays brighter through its middle than legacy's gamma-space
 *   `fade`.
 * - Colour: every source is converted to linear BT.2020 before blending and
 *   encoded afterwards. HDR output is HLG (HEVC Main10, arib-std-b67/bt2020)
 *   instead of legacy's PQ; SDR output tone maps HDR sources with the
 *   schema's knee-0.8 Reinhard curve instead of tonemap=hable. The SDR curve
 *   is the 1.961 power law Apple decodes BT.709 video with (./color.ts), so
 *   hex colours (the #0B0B0F background, captions) encode as the phone's do.
 * - B-roll is trimmed (srcStart, speed, holding its last frame), not looped
 *   from its source start as legacy's `-stream_loop -1` did.
 * - Frame quantization: segment edges are the builder's planFrameAt grid;
 *   legacy's trunc(t / (1 / fps)) landed one frame early on exact frame times.
 * - Overlays and captions cover frames [start, end) (frame k shows when
 *   start <= k / fps < end); legacy's between(t, start, end) also drew the
 *   end frame.
 * - Captions: one ASS Dialogue per plan line at the plan's \pos (./ass.ts),
 *   karaoke per word on the plan's absolute times, stroke, shadow and size
 *   scaled with the frame; legacy let libass wrap and place one event per
 *   caption with fixed-pixel styling.
 * - Callout cards are drawn from the plan's primitives (rounded card, vector
 *   glyph, Montserrat label) with libass on every platform; legacy drew a
 *   system-font PNG on macOS only and an ASS box elsewhere.
 * - Emoji stickers: drawn in colour on every host: Apple Color Emoji on
 *   macOS (as legacy), Noto Color Emoji at the plan's geometry elsewhere
 *   (emoji.ts; legacy drew monochrome libass glyphs on Linux), else the
 *   plan's `raster` asset, else in monochrome with a QA note.
 * - Loudness: the limiter is always on when targetLufs is set, so a hot mix
 *   inside the deadband is limited too (legacy limited only when it applied
 *   gain); gain and limiter run on the PCM master before the one AAC encode,
 *   not as a re-encoding post-pass.
 * - The master is exactly round(duration * 48000) samples and
 *   ceil(duration * fps) frames; legacy rendered max(duration, 0.1) and
 *   refused nothing; this executor refuses an empty plan.
 */

/** Draws an emoji sticker's payload as a PNG to stretch over its box (emoji.ts), or null when the host cannot. */
export type EmojiRasterizer = (emoji: PlanEmoji, box: { w: number; h: number }) => Promise<string | null>;

/** Resolves a plan asset to a file the requesting user may read, or undefined (see renderPlan's SECURITY note). */
export type PlanAssetResolver = (ref: PlanAssetRef) => string | undefined | Promise<string | undefined>;

export interface RenderPlanOutput {
  outputPath: string;
  /** Scratch space for graphs, masks and the audio master. */
  workDir: string;
  /** Emoji sticker rasterizer (a PNG for the overlay box); null where the host has none. Defaults to emoji.ts. */
  rasterizeEmoji?: EmojiRasterizer;
  /** Keep `workDir` afterwards (tests read the audio master); removed by default. */
  keepWorkDir?: boolean;
}

export interface RenderPlanResult {
  outputPath: string;
  frames: number;
  /** Things the render could not draw as planned, for the render QA warnings. */
  notes: string[];
  loudness: { measuredLufs: number | null; truePeakDb: number | null; decision: LoudnessDecision };
  /** Wall-clock seconds of the whole render. */
  elapsed: number;
}

/**
 * probePlanMedia, with a source outside the import allowlist reported as
 * PlanRenderUnavailableError, so the queue falls back to the legacy render
 * (which decides about that file the way it always has) instead of failing.
 */
export async function probePlanUnlessUnsupported(path: string, kind: PlanAssetRef['kind']): Promise<PlanMediaProbe> {
  try {
    return await probePlanMedia(path, kind);
  } catch (error) {
    if (error instanceof UnsupportedMediaError) throw new PlanRenderUnavailableError(`a source is not in a format the plan render opens (${kind})`);
    throw error;
  }
}

/** Thrown when this ffmpeg cannot execute a plan (a filter missing from the build). */
export class PlanRenderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanRenderUnavailableError';
  }
}

/* ------------------------------------------------------------------------ */
/* ffmpeg capabilities                                                      */

/** Filters the plan render uses; a build without one cannot render plans. */
export const PLAN_RENDER_FILTERS = [
  'zscale', 'lut1d', 'maskedmerge', 'blend', 'subtitles', 'geq', 'fillborders', 'alimiter', 'premultiply', 'unpremultiply',
  'negate', 'extractplanes', 'mergeplanes', 'rotate', 'tpad', 'concat', 'aeval', 'afade', 'atempo', 'amix', 'adelay', 'pan',
] as const;

interface Capabilities { missing: string[]; scriptOption: string }
let capabilities: Promise<Capabilities> | undefined;

export async function planRenderCapabilities(): Promise<Capabilities> {
  capabilities ??= (async () => {
    const [{ stdout: filters }, { stdout: help }] = await Promise.all([
      runProcess('ffmpeg', ['-hide_banner', '-filters']),
      runProcess('ffmpeg', ['-hide_banner', '-h', 'full']).catch(() => ({ stdout: '' })),
    ]);
    const names = new Set(filters.split('\n').map((line) => line.trim().split(/\s+/)[1]).filter(Boolean));
    return {
      missing: PLAN_RENDER_FILTERS.filter((name) => !names.has(name)),
      // ffmpeg 7 replaced -filter_complex_script with -/filter_complex (8 dropped the old one).
      scriptOption: help.includes('-filter_complex_script') ? '-filter_complex_script' : '-/filter_complex',
    };
  })();
  try {
    return await capabilities;
  } catch (error) {
    // A failed probe (ffmpeg briefly missing, a spawn error) is asked again next time, never cached.
    capabilities = undefined;
    throw error;
  }
}

/* ------------------------------------------------------------------------ */
/* Memory                                                                   */

/**
 * Peak resident memory of a plan render, MB, from the stress measurements
 * (1080 x 1920, 10 s, image stickers and a callout; ffmpeg 9.0 on a 14-core
 * Mac, the worst case: Debian's 5.1 on 4 cores, production's, measured 10-30%
 * lower). With the encoder's threads and lookahead capped (./color.ts):
 * - no graphics: 0.86 GB SDR (the final pass 0.42, a window 0.45), 1.45 GB
 *   HLG (x265 holds far more frames than x264);
 * - each graphic the final pass blends (an ASS run of callouts, emoji or
 *   captions; a canvas of consecutive stickers; a b-roll): 0.33-0.38 GB of
 *   full-frame float colour and mask frames in flight;
 * - each sticker on a canvas: 12 MB more (its overlay's frame copies);
 * - an animated crop (cropStage): 0.21 GB for a 1.15x punch-in, 0.56 GB for
 *   1x to 3x with a pan, in the window drawing it. A window holds at most one
 *   zooming segment (windows), so it is the most in any one segment that
 *   counts.
 * The constants round those up. Everything scales with the frame's pixel
 * count. Deliberately rough: it routes a plan to the legacy renderer before
 * it can exhaust the server, it does not size a machine.
 */
export function planRenderMemoryMb(plan: Pick<RenderPlan, 'size' | 'overlays' | 'captions'> & Partial<Pick<RenderPlan, 'color' | 'video'>>): number {
  const scale = (plan.size.w * plan.size.h) / (1080 * 1920);
  const { graphics, stickers } = planGraphics(plan);
  const zooms = Math.max(0, ...(plan.video?.segments ?? []).map(animatedCrops));
  return scale * ((plan.color === 'hlg' ? 1550 : 950) + 400 * graphics + 15 * stickers + 650 * zooms);
}

/** How many graphics the final pass blends (grouped as renderPlan groups them) and how many stickers they hold. */
export function planGraphics(plan: Pick<RenderPlan, 'overlays' | 'captions'>): { graphics: number; stickers: number } {
  let graphics = plan.captions.length > 0 ? 1 : 0;
  let stickers = 0;
  let previous: 'ass' | 'canvas' | undefined;
  for (const overlay of [...plan.overlays].sort((left, right) => left.z - right.z)) {
    // Emoji count as stickers (a colour raster); one that falls back to libass joins an ASS run instead.
    const kind = overlay.kind === 'callout' ? 'ass' : overlay.kind === 'broll' ? undefined : 'canvas';
    if (kind === 'canvas') stickers += 1;
    if (!kind || kind !== previous) graphics += 1;
    previous = kind;
  }
  return { graphics, stickers };
}

/** PLAN_RENDER_MEMORY_MB, default 3072 (the 4 GB server, with room for the API process and a legacy fallback). */
export function planRenderMemoryBudgetMb(): number {
  const configured = Number(process.env.PLAN_RENDER_MEMORY_MB);
  return Number.isFinite(configured) && configured > 0 ? configured : 3072;
}

/* ------------------------------------------------------------------------ */
/* Graph plumbing                                                           */

class Graph {
  readonly inputs: string[][] = [];
  readonly lines: string[] = [];
  private next = 0;

  input(args: string[]): number {
    this.inputs.push(args);
    return this.inputs.length - 1;
  }

  label(prefix: string): string {
    this.next += 1;
    return `${prefix}${this.next}`;
  }

  add(line: string): void {
    this.lines.push(line);
  }
}

interface Context {
  plan: RenderPlan;
  W: number;
  H: number;
  fps: number;
  total: number;
  luts: LutFiles;
  media: Map<string, PlanMediaProbe>;
  workDir: string;
  notes: string[];
  rasterize: EmojiRasterizer;
  rasterPaths: Map<string, string>;
  files: number;
}

/** A number for a filtergraph argument: six decimals, never exponent notation. */
function f(value: number): string {
  const text = Number(value.toFixed(6)).toString();
  return text.includes('e') ? value.toFixed(9) : text;
}

/** values[index] as an expression of an integer-valued `index` expression (a balanced if-tree). */
function lookup(values: readonly number[], index: string): string {
  const build = (lo: number, hi: number): string => {
    if (hi - lo === 1) return f(values[lo]!);
    const mid = Math.floor((lo + hi) / 2);
    return `if(lt(${index},${mid}),${build(lo, mid)},${build(mid, hi)})`;
  };
  return build(0, values.length);
}

const DECODE_ARGS = ['-threads', '2'];
/** Pts in the output frame grid: every branch meets the others frame for frame in framesync. */
const onGrid = (fps: number, offset = 0): string => `settb=1/${fps},setpts=N${offset ? `+${offset}` : ''}`;

/** Writes per-frame values as 1x1 gbrpf32le frames and returns the input + chain that makes a W x H mask of them. */
async function valueStream(graph: Graph, context: Context, values: Float32Array | number[]): Promise<string> {
  const data = new Float32Array(values.length * 3);
  values.forEach((value, index) => data.fill(value, index * 3, index * 3 + 3));
  context.files += 1;
  const path = join(context.workDir, `values-${context.files}.f32`);
  await writeFile(path, Buffer.from(data.buffer));
  const input = graph.input(['-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', '1x1', '-r', String(context.fps), '-i', path]);
  const label = graph.label('val');
  graph.add(`[${input}:v]zscale=w=${context.W}:h=${context.H}:filter=point,format=gbrpf32le,${onGrid(context.fps)}[${label}]`);
  return label;
}

/** A constant linear colour (one frame, looped `frames` times). */
async function constantStream(graph: Graph, context: Context, rgb: readonly number[], frames: number): Promise<string> {
  // gbrp plane order: G, B, R.
  const data = new Float32Array([rgb[1]!, rgb[2]!, rgb[0]!]);
  context.files += 1;
  const path = join(context.workDir, `constant-${context.files}.f32`);
  await writeFile(path, Buffer.from(data.buffer));
  const input = graph.input(['-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', '1x1', '-r', String(context.fps), '-i', path]);
  const label = graph.label('const');
  graph.add(`[${input}:v]zscale=w=${context.W}:h=${context.H}:filter=point,format=gbrpf32le,loop=loop=${frames - 1}:size=1,${onGrid(context.fps)}[${label}]`);
  return label;
}

/** Where an input opens a source for picture at `sourceTime`: a whole tenth half a second before. */
function seekPoint(sourceTime: number): number {
  return Math.max(0, Math.floor((sourceTime - 0.5) * 10) / 10);
}

/**
 * Opens `path` for picture from source time `from` (seconds) and returns the
 * filters that sample it on the output grid: output frame j shows the latest
 * source frame with pts <= from + j * speed / fps + 1e-6.
 */
function sampledInput(graph: Graph, path: string, from: number, speed: number, frames: number, fps: number, options: { gif?: GifTiming } = {}): string {
  if (options.gif) {
    // GIFs loop: frame N of the endlessly looped file starts at loop * total + starts[N mod count], from the
    // file's own delays (gifTiming), not the demuxer's timestamps.
    const { starts, total } = options.gif;
    const start = lookup(starts, `mod(N,${starts.length})`);
    const input = graph.input(['-stream_loop', '-1', '-i', path]);
    return `[${input}:v]settb=AVTB,setpts='(floor(N/${starts.length})*${f(total)}+${start}-${f(from)}-0.000001)/${f(speed)}/TB',` +
      `fps=fps=${fps}:start_time=0:round=up,trim=end_frame=${frames}`;
  }
  const seek = seekPoint(from);
  const span = (frames / fps) * speed + (from - seek) + 1;
  const input = graph.input([...DECODE_ARGS, ...(seek > 0 ? ['-ss', f(seek)] : []), '-t', f(span), '-an', '-sn', '-dn', '-i', path]);
  return `[${input}:v]settb=AVTB,setpts='(PTS*TB+${f(seek - from)}-0.000001)/${f(speed)}/TB',fps=fps=${fps}:start_time=0:round=up,` +
    // A source that runs out holds its last frame (the builder plans holds; this only covers decoder slack).
    `tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames}`;
}

/* ------------------------------------------------------------------------ */
/* Video layers                                                             */

/**
 * The crop/zoom for one layer, on the decoded picture (before colour
 * conversion), as filtergraph lines from `head` (a chain that yields the
 * source frames on the segment's output grid); returns the cropped stream's
 * label. One key: render.ts's static chain with the schema's numbers (scale
 * to the zoomed cover size, crop W x H at the panned offset; within half a
 * pixel).
 *
 * Several keys (an animated zoom or pan) stay at 16 bits all the way, so a
 * 10-bit HLG or PQ source reaches linearization with every code value it had
 * (`perspective`, which this used to use, works in 8 bits and banded smooth
 * HDR gradients). Per frame, at the pose (S, X, Y) the keys give for it:
 *   1. the source, padded by E smeared pixels a side (so the window below
 *      always has room past the visible rect), is cropped in its own pixel
 *      format to a fixed-size window around the visible rect (even origin, so
 *      4:2:0 chroma stays aligned);
 *   2. the window is scaled (eval=frame) by the pose's c = cover * S to 16-bit
 *      4:4:4 (yuv444p16le, or gbrp16le for stills): the visible rect is now
 *      W x H output pixels at a fractional offset o;
 *   3. (W + 1) x (H + 1) is cropped at floor(o), and the fraction is applied
 *      as a bilinear interpolation: maskedmerge of the picture with itself
 *      shifted by one pixel, across then down, with per-frame weights from a
 *      1 x 1 geq frame (16-bit, exact to 1/65536).
 * So every frame is placed sub-pixel, as the native compositor (Core Image)
 * and the schema's continuous convention place it. Only crop and scale in
 * this chain see the per-frame size: a filter between them (format, split)
 * would pass its configured size on and break the crop's clamp.
 * The window is sized for the chunk's widest view, so the scaled picture is at
 * most ZOOM_CHUNK_RATIO^2 frames' worth of pixels: a zoom spanning a larger
 * ratio is cut into chunks of frames, each with its own window (split + trim,
 * every frame used by one chunk only, so nothing queues).
 */
function cropStage(graph: Graph, head: string, keys: readonly PlanCropKey[], segment: PlanVideoSegment, frames: number, source: { width: number; height: number }, context: Context, rgb: boolean): string {
  const { W, H, fps } = context;
  const sw = source.width;
  const sh = source.height;
  const out = graph.label('crop');
  if (!(sw > 0 && sh > 0)) {
    graph.add(`${head},scale=${W}:${H}[${out}]`);
    return out;
  }
  const cover = Math.max(W / sw, H / sh);
  if (keys.length === 1) {
    const key = keys[0]!;
    const c = cover * Math.max(1, key.scale);
    const SW = Math.max(W, Math.round(sw * c));
    const SH = Math.max(H, Math.round(sh * c));
    const ox = Math.min(SW - W, Math.max(0, Math.round(((SW - W) / 2) * (1 + key.x))));
    const oy = Math.min(SH - H, Math.max(0, Math.round(((SH - H) / 2) * (1 + key.y))));
    const scale = SW === sw && SH === sh ? '' : `scale=${SW}:${SH}:flags=bicubic,`;
    graph.add(`${head},${scale}crop=${W}:${H}:${ox}:${oy}:exact=1[${out}]`);
    return out;
  }
  // Keys in frames of the segment, read at frame k = t * fps (the output grid).
  const points = (pick: (key: PlanCropKey) => number): Array<{ t: number; v: number }> => keys.map((key) => ({ t: (key.t - segment.start) * fps, v: pick(key) }));
  const scales = points((key) => Math.max(1, key.scale));
  const xs = points((key) => key.x);
  const ys = points((key) => key.y);
  /** The pose into ld(0..2) (S, X, Y) for frame `k` (an expression), stored in ld(4). */
  const pose = (k: string): string => `st(4,${k});st(0,max(1,${piecewiseLinear(scales, 'ld(4)')}));` +
    `st(1,${piecewiseLinear(xs, 'ld(4)')});st(2,${piecewiseLinear(ys, 'ld(4)')});`;
  const smallest = Math.min(...zoomChunks(scales, frames).map((chunk) => chunk.smallest));
  // Padding: at least one output pixel's worth of source past any visible edge (step 3 crops one extra pixel).
  const pad = 2 * Math.ceil((1 / (cover * smallest) + 1) / 2);
  const format = rgb ? 'gbrp16le' : 'yuv444p16le';
  const planes = rgb ? ['r', 'g', 'b'] : ['lum', 'cb', 'cr'];
  const axis = (size: number, frame: number, window: number, pan: 1 | 2): { origin: string; scaled: string; offset: string } => {
    // Visible extent v = frame / (cover * S) source pixels from (size - v) / 2 * (1 + pan), here in padded coordinates.
    const visible = `(${f(frame / cover)}/ld(0))`;
    const start = `((${f(size)}-${visible})/2*(1+ld(${pan}))+${pad})`;
    const origin = `max(0,min(${size + 2 * pad - window},2*floor((${start}+${visible}/2-${f(window / 2)})/2)))`;
    const scaled = `round(${f(window * cover)}*ld(0))`;
    return { origin, scaled, offset: `st(3,${origin});st(5,${scaled});(${start}-ld(3))*ld(5)/${window}` };
  };
  const windowFor = (least: number): { w: number; h: number } => {
    // The chunk's widest view plus 4 + 2 / c source pixels (the even origin, rounding, the extra pixel), with
    // padded size - window even so the even origin can reach the far edge.
    const c = cover * least;
    const fit = (size: number, frame: number): number => {
      const padded = size + 2 * pad;
      const want = Math.min(padded, Math.ceil(frame / c + 4 + 2 / c) + 2);
      return padded - 2 * Math.floor((padded - want) / 2);
    };
    return { w: fit(sw, W), h: fit(sh, H) };
  };
  const chunkLines = (input: string, chunk: { first: number; end: number; smallest: number }, output: string): void => {
    const window = windowFor(chunk.smallest);
    const x = axis(sw, W, window.w, 1);
    const y = axis(sh, H, window.h, 2);
    // Crop and scale also evaluate while configuring (t unset or 0, by version): the chunk's first frame stands in.
    const k = `if(isnan(t),${chunk.first},max(${chunk.first},t*${fps}))`;
    const id = graph.label('sub');
    graph.add(`[${input}]crop=w=${window.w}:h=${window.h}:x='${pose(k)}${x.origin}':y='${pose(k)}${y.origin}':exact=1,` +
      `scale=w='${pose(k)}${x.scaled}':h='${pose(k)}${y.scaled}':eval=frame:flags=bicubic+accurate_rnd+full_chroma_int+full_chroma_inp,` +
      `crop=w=${W + 1}:h=${H + 1}:x='${pose(k)}floor(${x.offset})':y='${pose(k)}floor(${y.offset})':exact=1,format=${format},` +
      `split=3[${id}a][${id}b][${id}m]`);
    // The fractions as 16-bit weights on a 1 x 1 frame (geq's clock is T), stretched to the planes they weigh.
    const weight = (offset: string): string => planes.map((plane) => `${plane}='${pose(`T*${fps}`)}st(6,${offset});65535*(ld(6)-floor(ld(6)))'`).join(':');
    graph.add(`[${id}m]crop=1:1:0:0,split=2[${id}m1][${id}m2]`);
    graph.add(`[${id}m1]geq=${weight(x.offset)},zscale=w=${W}:h=${H + 1}:filter=point[${id}wx]`);
    graph.add(`[${id}m2]geq=${weight(y.offset)},zscale=w=${W}:h=${H}:filter=point[${id}wy]`);
    graph.add(`[${id}a]crop=${W}:${H + 1}:0:0[${id}l]`);
    graph.add(`[${id}b]crop=${W}:${H + 1}:1:0[${id}r]`);
    graph.add(`[${id}l][${id}r][${id}wx]maskedmerge,split=2[${id}t][${id}u]`);
    graph.add(`[${id}t]crop=${W}:${H}:0:0[${id}tt]`);
    graph.add(`[${id}u]crop=${W}:${H}:0:1[${id}bb]`);
    graph.add(`[${id}tt][${id}bb][${id}wy]maskedmerge[${output}]`);
  };
  const id = graph.label('zoom');
  graph.add(`${head},${onGrid(fps)},pad=w=iw+${2 * pad}:h=ih+${2 * pad}:x=${pad}:y=${pad},` +
    `fillborders=left=${pad}:right=${pad}:top=${pad}:bottom=${pad}:mode=smear[${id}p]`);
  const chunks = zoomChunks(scales, frames);
  if (chunks.length === 1) {
    chunkLines(`${id}p`, chunks[0]!, out);
    return out;
  }
  graph.add(`[${id}p]split=${chunks.length}${chunks.map((_, index) => `[${id}s${index}]`).join('')}`);
  chunks.forEach((chunk, index) => {
    graph.add(`[${id}s${index}]trim=start_frame=${chunk.first}:end_frame=${chunk.end}[${id}t${index}]`);
    chunkLines(`${id}t${index}`, chunk, `${id}c${index}`);
  });
  graph.add(`${chunks.map((_, index) => `[${id}c${index}]`).join('')}concat=n=${chunks.length}:v=1:a=0[${out}]`);
  return out;
}

/** Largest zoom ratio one crop window serves (cropStage): the scaled picture stays under 2.25 frames of pixels. */
export const ZOOM_CHUNK_RATIO = 1.5;

/** Frames [first, end) of a segment grouped so that within each the zoom spans at most ZOOM_CHUNK_RATIO. */
export function zoomChunks(scales: ReadonlyArray<{ t: number; v: number }>, frames: number): Array<{ first: number; end: number; smallest: number }> {
  const out: Array<{ first: number; end: number; smallest: number }> = [];
  let first = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let k = 0; k < frames; k += 1) {
    const s = Math.max(1, keyValueAt(scales, k));
    if (k > first && Math.max(high, s) / Math.min(low, s) > ZOOM_CHUNK_RATIO) {
      out.push({ first, end: k, smallest: low });
      first = k;
      low = Infinity;
      high = -Infinity;
    }
    low = Math.min(low, s);
    high = Math.max(high, s);
  }
  out.push({ first, end: Math.max(first + 1, frames), smallest: Number.isFinite(low) ? low : 1 });
  return out;
}

/** Stills are sRGB whatever their (usually empty) tags say. */
const SRGB: SourceColor = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'gbr', range: 'pc' };

/** One layer's picture for a segment: W x H working-space frames on the output grid. */
async function layerStream(graph: Graph, layer: PlanVideoLayer, segment: PlanVideoSegment, frames: number, context: Context): Promise<string> {
  const probe = context.media.get(layer.assetRef.id)!;
  const label = graph.label('layer');
  if (layer.assetRef.kind === 'image') {
    const input = graph.input(['-noautorotate', '-i', probe.path]);
    const orient = orientationFilter(probe.orientation);
    // A still under an animated crop is repeated before the crop (each frame takes its own pose), else after it.
    const animated = layer.cropKeys.length > 1;
    const repeat = `loop=loop=${frames - 1}:size=1`;
    const head = `[${input}:v]${orient ? `${orient},` : ''}format=gbrp${animated ? `,${repeat}` : ''}`;
    const cropped = cropStage(graph, head, layer.cropKeys, segment, frames, uprightSize(probe), context, true);
    graph.add(`[${cropped}]${toWorkingSpace(SRGB, context.plan, context.luts, { rgb: true })}${animated ? '' : `,${repeat}`},${onGrid(context.fps)}[${label}]`);
    return await dimmed(graph, layer, segment, frames, context, label);
  }
  // A hold samples one frame at frameAt and repeats it.
  const sampling = layer.hold
    ? sampledInput(graph, probe.path, layer.hold.frameAt, 1, 1, context.fps)
    : sampledInput(graph, probe.path, layer.srcStart, layer.speed, frames, context.fps);
  const repeat = layer.hold ? `,tpad=stop_mode=clone:stop=${frames - 1}` : '';
  const cropped = cropStage(graph, `${sampling}${repeat}`, layer.cropKeys, segment, frames, uprightSize(probe), context, false);
  graph.add(`[${cropped}]${toWorkingSpace(probe.color, context.plan, context.luts)},${onGrid(context.fps)}[${label}]`);
  return await dimmed(graph, layer, segment, frames, context, label);
}

/** Per-frame values of keys at the segment's frame times. */
function framesOf(keys: ReadonlyArray<{ t: number; value: number }>, segment: PlanVideoSegment, frames: number, fps: number, map: (value: number) => number): Float32Array {
  const points = keys.map((key) => ({ t: key.t, v: key.value }));
  const values = new Float32Array(frames);
  for (let k = 0; k < frames; k += 1) values[k] = map(keyValueAt(points, segment.start + k / fps));
  return values;
}

/** dimKeys: pixel = source * (1 - dim), in linear light. */
async function dimmed(graph: Graph, layer: PlanVideoLayer, segment: PlanVideoSegment, frames: number, context: Context, label: string): Promise<string> {
  if (layer.dimKeys.length === 0) return label;
  const gain = await valueStream(graph, context, framesOf(layer.dimKeys, segment, frames, context.fps, (value) => 1 - value));
  const out = graph.label('dim');
  graph.add(`[${label}][${gain}]blend=all_mode=multiply[${out}]`);
  return out;
}

/** Inputs a segment opens: one per layer drawn, one per mask. */
function segmentInputs(segment: PlanVideoSegment): number {
  const drawn = visibleLayers(segment);
  return Math.max(1, drawn.reduce((sum, layer) => sum + 1 + (layer.dimKeys.length ? 1 : 0) + (layer.opacityKeys.length ? 1 : 0), 0));
}

/** Layers from the topmost opaque one up (everything under an opaque full-frame layer is hidden). */
function visibleLayers(segment: PlanVideoSegment): PlanVideoLayer[] {
  const layers = [...segment.layers].sort((left, right) => left.z - right.z);
  let base = -1;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    if (layers[index]!.opacityKeys.length === 0) {
      base = index;
      break;
    }
  }
  return base >= 0 ? layers.slice(base) : layers;
}

async function segmentStream(graph: Graph, segment: PlanVideoSegment, context: Context): Promise<string> {
  const frames = Math.round((segment.end - segment.start) * context.fps);
  const layers = visibleLayers(segment);
  let current: string;
  let rest = layers;
  if (layers[0] && layers[0].opacityKeys.length === 0) {
    current = await layerStream(graph, layers[0], segment, frames, context);
    rest = layers.slice(1);
  } else {
    current = await constantStream(graph, context, hexToWorking(context.plan.background).rgb, frames);
  }
  for (const layer of rest) {
    const picture = await layerStream(graph, layer, segment, frames, context);
    const alpha = await valueStream(graph, context, framesOf(layer.opacityKeys, segment, frames, context.fps, (value) => value));
    const out = graph.label('stack');
    graph.add(`[${current}][${picture}][${alpha}]maskedmerge[${out}]`);
    current = out;
  }
  return current;
}

/** Layers of a segment drawn with an animated crop (cropStage's 16-bit chain, the heaviest part of a window). */
export function animatedCrops(segment: PlanVideoSegment): number {
  return visibleLayers(segment).filter((layer) => layer.cropKeys.length > 1).length;
}

/**
 * Consecutive segments grouped so one ffmpeg opens at most a handful of
 * sources, and never two segments with animated crops: their chains' frame
 * pools all stay allocated for the window's life (three 3x zooms in one
 * window peaked at 2.26 GB, one at 1.48 GB), so each zooming segment starts
 * a window of its own.
 */
function windows(segments: readonly PlanVideoSegment[], fps: number): PlanVideoSegment[][] {
  const MAX_INPUTS = 8;
  const MAX_FRAMES = 60 * fps;
  const out: PlanVideoSegment[][] = [];
  let current: PlanVideoSegment[] = [];
  let inputs = 0;
  let frames = 0;
  let zooming = false;
  for (const segment of segments) {
    const need = segmentInputs(segment);
    const length = Math.round((segment.end - segment.start) * fps);
    const zooms = animatedCrops(segment) > 0;
    if (current.length > 0 && (inputs + need > MAX_INPUTS || frames + length > MAX_FRAMES || (zooms && zooming))) {
      out.push(current);
      current = [];
      inputs = 0;
      frames = 0;
      zooming = false;
    }
    current.push(segment);
    inputs += need;
    frames += length;
    zooming ||= zooms;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function windowArgs(group: PlanVideoSegment[], index: number, context: Context, script: (path: string) => string[]): Promise<string[]> {
  const graph = new Graph();
  const labels: string[] = [];
  for (const segment of group) labels.push(await segmentStream(graph, segment, context));
  const frames = group.reduce((sum, segment) => sum + Math.round((segment.end - segment.start) * context.fps), 0);
  const joined = labels.length > 1 ? `${labels.map((label) => `[${label}]`).join('')}concat=n=${labels.length}:v=1:a=0,` : `[${labels[0]}]`;
  graph.add(`${joined}${onGrid(context.fps)}[window]`);
  const path = join(context.workDir, `window-${index}.graph`);
  await writeFile(path, graph.lines.join(';\n'), 'utf8');
  return [
    '-nostdin', ...graph.inputs.flat(), ...script(path),
    // Passthrough: every frame the graph makes is written; ffmpeg must not resample to a guessed rate.
    '-map', '[window]', '-frames:v', String(frames), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', 'pipe:1',
  ];
}

/* ------------------------------------------------------------------------ */
/* Overlays                                                                 */

/** Integer placement of a (rotated) w x h picture centred on (cx, cy), and the part of it inside the frame. */
function placement(box: PlanOverlay['box'], context: Context): { w: number; h: number; RW: number; RH: number; crop: [number, number, number, number]; at: [number, number] } | undefined {
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const radians = (box.rotationDeg * Math.PI) / 180;
  // The rotated canvas is grown by a pixel where that lets its centre land exactly on the box centre
  // (rotate centres the picture in it), so integer placement costs no half-pixel shift.
  const fit = (size: number, centre: number): number => (Number.isInteger(2 * centre) && (Math.round(2 * centre) - size) % 2 !== 0 ? size + 1 : size);
  const RW = box.rotationDeg ? fit(Math.ceil(Math.abs(w * Math.cos(radians)) + Math.abs(h * Math.sin(radians))), box.x) : w;
  const RH = box.rotationDeg ? fit(Math.ceil(Math.abs(w * Math.sin(radians)) + Math.abs(h * Math.cos(radians))), box.y) : h;
  const X = Math.round(box.x - RW / 2);
  const Y = Math.round(box.y - RH / 2);
  const cx = Math.max(0, -X);
  const cy = Math.max(0, -Y);
  const cw = Math.min(RW, context.W - X) - cx;
  const ch = Math.min(RH, context.H - Y) - cy;
  if (cw <= 0 || ch <= 0) return undefined;
  return { w, h, RW, RH, crop: [cw, ch, cx, cy], at: [Math.max(0, X), Math.max(0, Y)] };
}

/**
 * Places an overlay picture: colour and alpha travel as separate planar RGB
 * streams (alpha copied into all three planes), never as a gray pixel format,
 * because ffmpeg's swscale drops, rescales or range-maps those differently
 * from version to version (6.1 vs 9.0, measured) while planar RGB plane copies
 * stay exact. The colour is premultiplied, scaled to the box, rotated (so
 * edges do not pick up the fill's colour), unpremultiplied, and cropped to the
 * part inside the frame. Returns the rect-sized straight colour and alpha.
 */
function placePicture(
  graph: Graph,
  /** `placed`: scaling and rotation were already applied (premultiplied colour and its coverage). */
  sources: { colour: string; alpha: string; premultiplied: boolean; placed?: boolean },
  box: PlanOverlay['box'],
  place: NonNullable<ReturnType<typeof placement>>,
): { colour: string; alpha: string } {
  const radians = (box.rotationDeg * Math.PI) / 180;
  const geometry = sources.placed ? 'null' : `scale=${place.w}:${place.h}:flags=bicubic${box.rotationDeg ? `,rotate=${f(radians)}:ow=${place.RW}:oh=${place.RH}:c=black` : ''}`;
  const [cw, ch, cx, cy] = place.crop;
  const crop = `crop=${cw}:${ch}:${cx}:${cy}:exact=1`;
  const id = graph.label('place');
  let premultiplied = sources.colour;
  let alpha = sources.alpha;
  if (!sources.premultiplied) {
    graph.add(`[${sources.alpha}]split=2[${id}p][${id}r]`);
    graph.add(`[${sources.colour}][${id}p]premultiply=inplace=0[${id}pm]`);
    premultiplied = `${id}pm`;
    alpha = `${id}r`;
  }
  graph.add(`[${alpha}]${geometry},split=2[${id}a1][${id}a2]`);
  graph.add(`[${premultiplied}]${geometry}[${id}cg]`);
  graph.add(`[${id}cg][${id}a1]unpremultiply=inplace=0,${crop}[${id}c]`);
  graph.add(`[${id}a2]${crop}[${id}a]`);
  return { colour: `${id}c`, alpha: `${id}a` };
}

/** Splits straight RGBA into planar colour and alpha-in-every-plane streams (exact plane copies). */
function splitRgba(graph: Graph, source: string): { colour: string; alpha: string } {
  const id = graph.label('rgba');
  graph.add(`[${source}]extractplanes=r+g+b+a[${id}r][${id}g][${id}b][${id}x]`);
  graph.add(`[${id}g][${id}b][${id}r]mergeplanes=mapping=0x001020:format=gbrp[${id}c]`);
  graph.add(`[${id}x]split=3[${id}x1][${id}x2][${id}x3]`);
  graph.add(`[${id}x1][${id}x2][${id}x3]mergeplanes=mapping=0x001020:format=gbrp[${id}a]`);
  return { colour: `${id}c`, alpha: `${id}a` };
}

const SRGB_IN = 'pin=709:tin=iec61966-2-1:rin=full';
const PQ_IN = 'pin=2020:tin=smpte2084:rin=full';

/** A graphic ready to composite: W x H colour and mask (alpha in every plane) in the working space, drawn on frames [first, end). */
interface Graphic { colour: string; mask: string; frames: [number, number] }

/**
 * Turns planar colour + alpha into a W x H Graphic: both padded to the frame
 * at `at` (still 8- or 16-bit integer, so the pad is exact), converted to
 * float, repeated over the whole output (a single still frame is looped by
 * reference; timed frames covering [first, end) are padded with clones).
 */
async function toGraphic(graph: Graph, picture: { colour: string; alpha: string }, at: [number, number], colourIn: string, frames: [number, number], still: boolean, context: Context): Promise<Graphic> {
  const [first, end] = frames;
  const pad = `pad=${context.W}:${context.H}:${at[0]}:${at[1]}:color=black`;
  const colour = graph.label('gc');
  const mask = graph.label('ga');
  const toFloat = {
    colour: `${pad},zscale=${colourIn}:t=linear:p=2020:r=full:npl=203,format=gbrpf32le`,
    alpha: `${pad},zscale=tin=linear:pin=709:rin=full:t=linear:p=709:r=full,format=gbrpf32le`,
  };
  if (still) {
    graph.add(`[${picture.colour}]${toFloat.colour},loop=loop=${context.total - 1}:size=1,${onGrid(context.fps)}[${colour}]`);
    graph.add(`[${picture.alpha}]${toFloat.alpha},loop=loop=${context.total - 1}:size=1,${onGrid(context.fps)}[${mask}]`);
    return { colour, mask, frames };
  }
  graph.add(`[${picture.colour}]${toFloat.colour}[${colour}span]`);
  graph.add(`[${picture.alpha}]${toFloat.alpha}[${mask}span]`);
  await spanToTimeline(graph, `${colour}span`, colour, first, end, context);
  await spanToTimeline(graph, `${mask}span`, mask, first, end, context);
  return { colour, mask, frames };
}

/**
 * Frames [first, end) of a float stream placed on the whole output timeline:
 * filler frames (one black frame looped by reference) before and after, so
 * maskedmerge stays in sync while its enable range ignores them. Not tpad:
 * ffmpeg 5.1's tpad has no float formats, so it would convert to 16-bit
 * integer and clip every HDR highlight at 1.0 (measured on Debian 12).
 */
async function spanToTimeline(graph: Graph, span: string, out: string, first: number, end: number, context: Context): Promise<void> {
  const parts: string[] = [];
  const filler = async (frames: number): Promise<string> => constantStream(graph, context, [0, 0, 0], frames);
  if (first > 0) parts.push(await filler(first));
  parts.push(span);
  if (context.total > end) parts.push(await filler(context.total - end));
  if (parts.length === 1) graph.add(`[${span}]${onGrid(context.fps)}[${out}]`);
  else graph.add(`${parts.map((part) => `[${part}]`).join('')}concat=n=${parts.length}:v=1:a=0,${onGrid(context.fps)}[${out}]`);
}

/** A sticker (image, GIF, emoji raster) as a rect-sized straight-alpha gbrap picture, for a sticker canvas. */
interface Sticker { picture: string; at: [number, number]; frames: [number, number]; still: boolean }

/** The emoji sticker's colour picture: the host's colour emoji rasterizer, else the plan's uploaded raster. */
async function emojiRaster(overlay: PlanOverlay, context: Context): Promise<string | undefined> {
  return (await context.rasterize(overlay.emoji!, overlay.box)) ?? (overlay.raster ? context.rasterPaths.get(overlay.raster.id) : undefined);
}

async function sticker(graph: Graph, overlay: PlanOverlay, context: Context): Promise<Sticker | undefined> {
  const [first, end] = spanFrames(overlay.start, overlay.end, context.fps).map((frame) => Math.min(frame, context.total)) as [number, number];
  if (end <= first) return undefined;
  const place = placement(overlay.box, context);
  if (!place) return undefined;
  const source = graph.label('src');
  let still = true;
  if (overlay.kind === 'gif') {
    const media = overlay.media!;
    const probe = context.media.get(media.assetRef.id)!;
    const from = media.srcStart + (first / context.fps - overlay.start) * media.speed;
    const gif = gifTiming(await readFile(probe.path));
    graph.add(`${sampledInput(graph, probe.path, Math.max(0, from), media.speed, end - first, context.fps, { gif })},format=rgba[${source}]`);
    still = false;
  } else {
    let path: string | undefined;
    let orientation = 1;
    if (overlay.kind === 'emoji') {
      path = await emojiRaster(overlay, context);
      if (!path) return undefined;
    } else {
      const probe = context.media.get(overlay.media!.assetRef.id)!;
      path = probe.path;
      orientation = probe.orientation;
    }
    const input = graph.input(['-noautorotate', '-i', path]);
    const orient = orientationFilter(orientation);
    graph.add(`[${input}:v]${orient ? `${orient},` : ''}format=rgba[${source}]`);
  }
  const placed = placePicture(graph, { ...splitRgba(graph, source), premultiplied: false }, overlay.box, place);
  const picture = graph.label('stk');
  // gbrap: colour planes, then the alpha (any plane of the alpha stream).
  graph.add(`[${placed.colour}][${placed.alpha}]mergeplanes=mapping=0x00010210:format=gbrap[${picture}]`);
  return { picture, at: place.at, frames: [first, end], still };
}

/**
 * Consecutive stickers share one canvas: each is overlaid (straight alpha,
 * 8-bit sRGB, as the PNGs and GIFs themselves are) at its own size onto one
 * transparent W x H frame, so N stickers cost N small pictures and ONE
 * full-frame float colour + mask, where each used to cost its own. Stickers
 * blend among themselves in sRGB code values (only where two overlap with
 * partial alpha); the group blends over the video in linear light.
 */
async function stickerGroup(graph: Graph, stickers: Sticker[], context: Context): Promise<Graphic | undefined> {
  if (stickers.length === 0) return undefined;
  const first = Math.min(...stickers.map((item) => item.frames[0]));
  const end = Math.max(...stickers.map((item) => item.frames[1]));
  context.files += 1;
  const clearPath = join(context.workDir, `clear-${context.files}.raw`);
  await writeFile(clearPath, Buffer.from([0, 0, 0, 0]));
  const input = graph.input(['-f', 'rawvideo', '-pix_fmt', 'gbrap', '-s', '1x1', '-r', String(context.fps), '-i', clearPath]);
  let canvas = graph.label('canvas');
  graph.add(`[${input}:v]scale=${context.W}:${context.H}:flags=neighbor,loop=loop=${end - first - 1}:size=1,${onGrid(context.fps, first)}[${canvas}]`);
  for (const item of stickers) {
    const next = graph.label('canvas');
    // Every member covers the whole group span frame for frame (clones outside its own span, which enable
    // ignores), so overlay never has to sync offset or ended inputs: ffmpeg 5.1 and 9.0 differ there.
    const member = graph.label('member');
    const fill = item.still
      ? `loop=loop=${end - first - 1}:size=1`
      : `tpad=start=${item.frames[0] - first}:stop=${end - item.frames[1]}:start_mode=clone:stop_mode=clone`;
    graph.add(`[${item.picture}]${fill},${onGrid(context.fps, first)}[${member}]`);
    graph.add(`[${canvas}][${member}]overlay=x=${item.at[0]}:y=${item.at[1]}:format=gbrp:eof_action=pass` +
      `:enable='between(n,${item.frames[0] - first},${item.frames[1] - first - 1})'[${next}]`);
    canvas = next;
  }
  const id = graph.label('group');
  graph.add(`[${canvas}]split=2[${id}s1][${id}s2]`);
  graph.add(`[${id}s1]mergeplanes=mapping=0x000102:format=gbrp[${id}c]`);
  graph.add(`[${id}s2]mergeplanes=mapping=0x030303:format=gbrp[${id}a]`);
  return await toGraphic(graph, { colour: `${id}c`, alpha: `${id}a` }, [0, 0], SRGB_IN, [first, end], false, context);
}

/** A b-roll overlay as a Graphic, or undefined when it is off screen. */
async function brollGraphic(graph: Graph, overlay: PlanOverlay, context: Context): Promise<Graphic | undefined> {
  const [first, end] = spanFrames(overlay.start, overlay.end, context.fps).map((frame) => Math.min(frame, context.total)) as [number, number];
  if (end <= first) return undefined;
  const place = placement(overlay.box, context);
  if (!place) return undefined;
  const source = graph.label('src');
  const media = overlay.media!;
  const probe = context.media.get(media.assetRef.id)!;
  const from = media.srcStart + (first / context.fps - overlay.start) * media.speed;
  // B-roll: sampled like a layer, stretched to the box, converted to the working space, then carried as 16-bit PQ
  // (BT.2020) through rotation and placement so HDR survives, and decoded back to linear. It is opaque: its alpha
  // is a white plane the same size, so only rotation and the frame edge make coverage.
  const frames = end - first;
  const pq = `${sampledInput(graph, probe.path, Math.max(0, from), media.speed, frames, context.fps)},scale=${place.w}:${place.h}:flags=bicubic,` +
    `${toWorkingSpace(probe.color, context.plan, context.luts)},zscale=tin=linear:pin=2020:rin=full:npl=203:t=smpte2084:p=2020`;
  const alpha = graph.label('cover');
  context.files += 1;
  const whitePath = join(context.workDir, `white-${context.files}.raw`);
  if (!overlay.box.rotationDeg) {
    graph.add(`${pq}:r=full,format=gbrp16le[${source}]`);
    await writeFile(whitePath, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const whiteInput = graph.input(['-f', 'rawvideo', '-pix_fmt', 'gbrp16le', '-s', '1x1', '-r', String(context.fps), '-i', whitePath]);
    graph.add(`[${whiteInput}:v]scale=${place.w}:${place.h}:flags=neighbor,loop=loop=${frames - 1}:size=1,${onGrid(context.fps)}[${alpha}]`);
    return await toGraphic(graph, placePicture(graph, { colour: source, alpha, premultiplied: true }, overlay.box, place), place.at, PQ_IN, [first, end], false, context);
  }
  // ffmpeg's rotate has no 16-bit RGB path (it would convert behind our back), so a rotated b-roll turns as
  // limited-range Y'CbCr 4:4:4 16-bit: the fill, Y'CbCr black, is R'G'B' 0, so the rotated colour comes out
  // premultiplied by its coverage, and a neutral white plane turned the same way is that coverage.
  const radians = f((overlay.box.rotationDeg * Math.PI) / 180);
  const turn = `rotate=${radians}:ow=${place.RW}:oh=${place.RH}:c=black`;
  graph.add(`${pq}:m=2020_ncl:r=limited,format=yuv444p16le,${turn},` +
    `zscale=min=2020_ncl:rin=limited:pin=2020:p=2020:tin=smpte2084:t=smpte2084:r=full,format=gbrp16le[${source}]`);
  // Y' 235 and neutral chroma, 16-bit little-endian planes.
  await writeFile(whitePath, Buffer.from([0x00, 0xeb, 0x00, 0x80, 0x00, 0x80]));
  const whiteInput = graph.input(['-f', 'rawvideo', '-pix_fmt', 'yuv444p16le', '-s', '1x1', '-r', String(context.fps), '-i', whitePath]);
  graph.add(`[${whiteInput}:v]scale=${place.w}:${place.h}:flags=neighbor,loop=loop=${frames - 1}:size=1,${onGrid(context.fps)},${turn},` +
    `zscale=min=2020_ncl:rin=limited:pin=2020:p=2020:tin=linear:t=linear:r=full,format=gbrp16le[${alpha}]`);
  return await toGraphic(graph, placePicture(graph, { colour: source, alpha, premultiplied: true, placed: true }, overlay.box, place), place.at, PQ_IN, [first, end], false, context);
}

/**
 * An ASS run (callouts and/or captions) as colour + mask. libass draws the
 * run twice, over opaque black and over opaque white: alpha = 1 - (white -
 * black) and the premultiplied colour is the black render, which recovers
 * exactly what libass layered (fill over stroke over shadow) whatever the
 * ffmpeg version does with alpha canvases. Straight colour = black / alpha.
 */
async function assRun(graph: Graph, items: AssItem[], index: number, context: Context): Promise<Graphic | undefined> {
  const spans = items.map((item) => (item.kind === 'caption' ? item.caption : item.overlay))
    .map((item) => spanFrames(item.start, item.end, context.fps));
  const first = Math.min(...spans.map(([start]) => start));
  const end = Math.min(context.total, Math.max(...spans.map(([, stop]) => stop)));
  if (end <= first) return undefined;
  const rect = assRect(items, context);
  if (!rect) return undefined;
  const assPath = join(context.workDir, `graphics-${index}.ass`);
  await writeFile(assPath, planAss(context.plan, items), 'utf8');
  const font = locateAssFont();
  const fontsdir = font.directory ? `:fontsdir='${filterPath(font.directory)}'` : '';
  const canvas = async (byte: number): Promise<string> => {
    context.files += 1;
    const path = join(context.workDir, `canvas-${context.files}.raw`);
    await writeFile(path, Buffer.from([byte, byte, byte]));
    const input = graph.input(['-f', 'rawvideo', '-pix_fmt', 'gbrp', '-s', '1x1', '-r', String(context.fps), '-i', path]);
    const label = graph.label('canvas');
    graph.add(`[${input}:v]scale=${context.W}:${context.H}:flags=neighbor,loop=loop=${end - first - 1}:size=1,${onGrid(context.fps, first)},` +
      // libass places by absolute frame coordinates; everything after it works on the run's rect only.
      `subtitles=filename='${filterPath(assPath)}'${fontsdir},crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}:exact=1,format=gbrp[${label}]`);
    return label;
  };
  const black = await canvas(0);
  const white = await canvas(255);
  const split = graph.label('gfx');
  graph.add(`[${black}]split=2[${split}b1][${split}b2]`);
  graph.add(`[${white}][${split}b1]blend=all_mode=difference,negate,split=2[${split}m][${split}a]`);
  graph.add(`[${split}b2][${split}a]unpremultiply=inplace=0[${split}c]`);
  return await toGraphic(graph, { colour: `${split}c`, alpha: `${split}m` }, [rect.x, rect.y], SRGB_IN, [first, end], false, context);
}
/**
 * The part of the frame an ASS run can touch: every caption line's cell grown
 * by its stroke, shadow and a safety margin (libass shapes with ligatures, so
 * widths differ a little from the plan's), every callout's rotated box.
 */
function assRect(items: readonly AssItem[], context: Context): Rect | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (left: number, top: number, right: number, bottom: number): void => {
    x0 = Math.min(x0, left);
    y0 = Math.min(y0, top);
    x1 = Math.max(x1, right);
    y1 = Math.max(y1, bottom);
  };
  for (const item of items) {
    if (item.kind === 'caption') {
      const caption = item.caption;
      const metrics = fontMetrics(caption.font);
      const em = caption.sizePx / metrics.unitsPerEm;
      const margin = caption.strokePx + (caption.shadow?.offsetPx ?? 0) + (caption.box?.padPx ?? 0) + Math.max(4, caption.sizePx * 0.25);
      for (const line of caption.lines) {
        grow(line.x - margin, line.y - metrics.winAscent * em - margin, line.x + line.width + margin, line.y + metrics.winDescent * em + margin);
      }
    } else {
      const half = Math.hypot(item.overlay.box.w, item.overlay.box.h) / 2 + 4;
      grow(item.overlay.box.x - half, item.overlay.box.y - half, item.overlay.box.x + half, item.overlay.box.y + half);
    }
  }
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(context.W, Math.ceil(x1));
  const bottom = Math.min(context.H, Math.ceil(y1));
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : undefined;
}

interface Rect { x: number; y: number; w: number; h: number }

/* ------------------------------------------------------------------------ */
/* Processes                                                                */

function startFfmpeg(args: string[], pipes: { stdin?: boolean; stdout?: Writable }): { child: ChildProcess; done: Promise<void> } {
  const child = spawn('ffmpeg', ['-hide_banner', '-v', 'error', ...args], { stdio: [pipes.stdin ? 'pipe' : 'ignore', pipes.stdout ?? 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code ?? signal}: ${stderr}`));
    });
  });
  done.catch(() => undefined);
  return { child, done };
}

/**
 * The final pass with each window's raw frames piped in, in order, one window
 * process at a time (render.ts runWindowed). Each window gets the final
 * pass's stdin as its own stdout, so the ~25 MB float frames never pass
 * through Node. (A named pipe measured 4x slower on macOS: ffmpeg reads a
 * FIFO through the file protocol in small blocks.)
 */
async function runWindowed(finalArgs: string[], windowArgs: string[][]): Promise<void> {
  const final = startFfmpeg(finalArgs, { stdin: true });
  let finalError: unknown;
  final.done.catch((error: unknown) => { finalError = error; });
  const sink = final.child.stdin!;
  sink.on('error', () => undefined);
  const stoppedEarly = final.done.then(() => { throw new Error('ffmpeg stopped reading render windows early'); });
  stoppedEarly.catch(() => undefined);
  let current: ChildProcess | undefined;
  try {
    for (const args of windowArgs) {
      const window = startFfmpeg(args, { stdout: sink });
      current = window.child;
      await Promise.race([window.done, stoppedEarly]);
    }
    sink.end();
    await final.done;
  } catch (error) {
    const own = finalError;
    current?.kill('SIGKILL');
    final.child.kill('SIGKILL');
    await final.done.catch(() => undefined);
    throw own ?? error;
  }
}

/* ------------------------------------------------------------------------ */
/* The render                                                               */

/**
 * Renders a RenderPlan v1 to `out.outputPath`.
 *
 * SECURITY: the plan is untrusted. Every asset id goes through
 * `resolveAsset`, which must answer only for the requesting user's assets;
 * an id it does not resolve fails the render (or, for an optional emoji
 * raster, skips that sticker with a note). Nothing is resolved by bare id.
 */
export async function renderPlan(input: unknown, resolveAsset: PlanAssetResolver, out: RenderPlanOutput): Promise<RenderPlanResult> {
  try {
    return await renderInWorkDir(input, resolveAsset, out);
  } finally {
    // Graphs, masks, the audio master and ASS files are scratch: gone on success, failure or a killed ffmpeg.
    if (!out.keepWorkDir) await rm(out.workDir, { recursive: true, force: true });
  }
}

async function renderInWorkDir(input: unknown, resolveAsset: PlanAssetResolver, out: RenderPlanOutput): Promise<RenderPlanResult> {
  const startedAt = Date.now();
  const plan = parseRenderPlanForExecutor(input);
  const total = planFrameCount(plan);
  if (total === 0) throw new Error('This plan has nothing to render (duration 0).');
  const caps = await planRenderCapabilities().catch((error: unknown) => {
    throw new PlanRenderUnavailableError(`ffmpeg could not be asked for its filters (${error instanceof Error ? error.message : String(error)})`);
  });
  if (caps.missing.length > 0) {
    throw new PlanRenderUnavailableError(`This ffmpeg cannot render plans; it lacks the filters: ${caps.missing.join(', ')}`);
  }
  const memory = planRenderMemoryMb(plan);
  const budget = planRenderMemoryBudgetMb();
  if (memory > budget) {
    throw new PlanRenderUnavailableError(`this plan needs about ${Math.round(memory)} MB to render (budget ${budget} MB)`);
  }
  const script = (path: string): string[] => [caps.scriptOption, path];
  await mkdir(out.workDir, { recursive: true });

  // Resolve and probe every asset the plan names, scoped by the resolver.
  const media = new Map<string, PlanMediaProbe>();
  const refs = new Map<string, PlanAssetRef>();
  for (const segment of plan.video.segments) for (const layer of segment.layers) refs.set(layer.assetRef.id, layer.assetRef);
  for (const overlay of plan.overlays) if (overlay.media) refs.set(overlay.media.assetRef.id, overlay.media.assetRef);
  for (const entry of plan.audio) refs.set(entry.assetRef.id, entry.assetRef);
  for (const ref of refs.values()) {
    const path = await resolveAsset(ref);
    if (!path) throw new Error(`Asset ${ref.id} is not available to this render`);
    media.set(ref.id, await probePlanUnlessUnsupported(path, ref.kind));
  }
  const rasterPaths = new Map<string, string>();
  for (const overlay of plan.overlays) {
    if (!overlay.raster) continue;
    const path = await resolveAsset(overlay.raster);
    if (path) rasterPaths.set(overlay.raster.id, path);
  }

  const context: Context = {
    plan, W: plan.size.w, H: plan.size.h, fps: plan.fps, total,
    luts: await lutFiles(), media, workDir: out.workDir, notes: [],
    rasterize: out.rasterizeEmoji ?? rasterizePlanEmoji, rasterPaths, files: 0,
  };

  // Audio first: the master is measured before the final pass applies gain and the limiter.
  const audio = await planAudioJob(plan, media, out.workDir, script);
  for (const args of audio.runs) {
    const run = startFfmpeg(args, {});
    await run.done;
  }
  const measured = await measureLoudness(audio.wavPath);
  const decision = planLoudnessGain(plan.loudness, measured.integrated);

  // Picture windows.
  const windowArgList: string[][] = [];
  for (const [index, group] of windows(plan.video.segments, plan.fps).entries()) {
    windowArgList.push(await windowArgs(group, index, context, script));
  }

  // Final pass: overlays by z (callout runs drawn by libass), captions last, encode.
  const graph = new Graph();
  // A raw 1080p float frame is 25 MB: keep the demuxer's queue of them short.
  const videoIn = graph.input(['-thread_queue_size', '2', '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${context.W}x${context.H}`, '-r', String(plan.fps), '-i', 'pipe:0']);
  const audioIn = graph.input(['-i', audio.wavPath]);
  let current = 'base';
  graph.add(`[${videoIn}:v]${onGrid(plan.fps)}[${current}]`);
  const merge = (graphic: Graphic): void => {
    const next = graph.label('comp');
    graph.add(`[${current}][${graphic.colour}][${graphic.mask}]maskedmerge=enable='between(n,${graphic.frames[0]},${graphic.frames[1] - 1})'[${next}]`);
    current = next;
  };
  const overlays = [...plan.overlays].sort((left, right) => left.z - right.z);
  // Draw order is z: consecutive callouts share one ASS run, consecutive stickers one canvas.
  let run: AssItem[] = [];
  let runs = 0;
  let stickers: Sticker[] = [];
  const flush = async (): Promise<void> => {
    if (run.length > 0) {
      const drawn = await assRun(graph, run, runs, context);
      runs += 1;
      run = [];
      if (drawn) merge(drawn);
    }
    if (stickers.length > 0) {
      const drawn = await stickerGroup(graph, stickers, context);
      stickers = [];
      if (drawn) merge(drawn);
    }
  };
  for (const overlay of overlays) {
    if (overlay.kind === 'callout' && overlay.callout) {
      if (stickers.length > 0) await flush();
      run.push({ kind: 'callout', overlay: overlay as PlanOverlay & { callout: PlanCallout } });
    } else if (overlay.kind === 'broll') {
      await flush();
      const drawn = await brollGraphic(graph, overlay, context);
      if (drawn) merge(drawn);
    } else {
      if (run.length > 0) await flush();
      if (overlay.kind === 'emoji' && !(await emojiRaster(overlay, context))) {
        // No colour emoji font on this host and no raster: libass draws it in monochrome, as legacy did.
        context.notes.push(`Emoji sticker ${overlay.id} was drawn in monochrome: this server has no colour emoji font and the render has no raster for it.`);
        console.warn('[render-plan] emoji drawn in monochrome', { overlay: overlay.id });
        if (stickers.length > 0) await flush();
        run.push({ kind: 'emoji', overlay: overlay as PlanOverlay & { emoji: PlanEmoji } });
        continue;
      }
      if (run.length > 0) await flush();
      const item = await sticker(graph, overlay, context);
      if (item) stickers.push(item);
    }
  }
  await flush();
  for (const caption of [...plan.captions].sort((left, right) => left.lane - right.lane || left.start - right.start)) {
    run.push({ kind: 'caption', caption });
  }
  await flush();
  graph.add(`[${current}]${fromWorkingSpace(plan, context.luts)}[vout]`);
  graph.add(`[${audioIn}:a]${[...loudnessFilters(plan.loudness, decision), `aformat=sample_rates=48000:channel_layouts=stereo`].join(',')}[aout]`);
  const finalGraph = join(out.workDir, 'final.graph');
  await writeFile(finalGraph, graph.lines.join(';\n'), 'utf8');
  const finalArgs = [
    '-y', ...graph.inputs.flat(), ...script(finalGraph),
    '-map', '[vout]', '-map', '[aout]', '-frames:v', String(total), '-fps_mode', 'passthrough',
    ...encoderArgs(plan),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', out.outputPath,
  ];
  await runWindowed(finalArgs, windowArgList);
  return {
    outputPath: out.outputPath,
    frames: total,
    notes: context.notes,
    loudness: { measuredLufs: measured.integrated, truePeakDb: measured.truePeak, decision },
    elapsed: (Date.now() - startedAt) / 1000,
  };
}
