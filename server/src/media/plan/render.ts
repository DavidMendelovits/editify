import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { join } from 'node:path';
import {
  parseRenderPlanForExecutor,
  planFrameCount,
  type PlanAssetRef,
  type PlanCallout,
  type PlanCropKey,
  type PlanOverlay,
  type PlanVideoLayer,
  type PlanVideoSegment,
  type RenderPlan,
} from '@editify/shared';
import { measureLoudness } from '../../services/render-qa.js';
import { locateAssFont } from '../ass.js';
import { rasterizeEmoji } from '../emoji.js';
import { runProcess } from '../process.js';
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
 * - Emoji stickers: rasterized with Apple Color Emoji where the host can
 *   (macOS, as legacy), else the plan's `raster` asset, else skipped with a
 *   QA note (legacy fell back to monochrome libass glyphs).
 * - Loudness: the limiter is always on when targetLufs is set, so a hot mix
 *   inside the deadband is limited too (legacy limited only when it applied
 *   gain); gain and limiter run on the PCM master before the one AAC encode,
 *   not as a re-encoding post-pass.
 * - The master is exactly round(duration * 48000) samples and
 *   ceil(duration * fps) frames; legacy rendered max(duration, 0.1) and
 *   refused nothing; this executor refuses an empty plan.
 */

/** Resolves a plan asset to a file the requesting user may read, or undefined (see renderPlan's SECURITY note). */
export type PlanAssetResolver = (ref: PlanAssetRef) => string | undefined | Promise<string | undefined>;

export interface RenderPlanOutput {
  outputPath: string;
  /** Scratch space for graphs, masks and the audio master. */
  workDir: string;
  /** Emoji rasterizer (Apple Color Emoji); null where the host has none. Defaults to emoji.ts. */
  rasterizeEmoji?: (text: string) => Promise<string | null>;
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
  'zscale', 'lut1d', 'maskedmerge', 'blend', 'subtitles', 'perspective', 'alimiter', 'premultiply', 'unpremultiply',
  'negate', 'extractplanes', 'mergeplanes', 'rotate', 'tpad', 'aeval', 'afade', 'atempo', 'amix', 'adelay', 'pan',
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
  return await capabilities;
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
  rasterize: (text: string) => Promise<string | null>;
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
 * conversion). One key: render.ts's static chain with the schema's numbers
 * (scale to the zoomed cover size, crop W x H at the panned offset; within
 * half a pixel). Several keys: the source is stretched to the frame's aspect
 * and `perspective` (eval=frame) pulls the keyed rectangle to the full frame,
 * so every frame gets its own sub-pixel crop; the stretch is undone by the
 * perspective itself, and the image is first oversampled up to 2x so the
 * perspective only ever enlarges.
 */
function cropFilters(keys: readonly PlanCropKey[], segment: PlanVideoSegment, source: { width: number; height: number }, context: Context): string {
  const { W, H, fps } = context;
  const sw = source.width;
  const sh = source.height;
  if (!(sw > 0 && sh > 0)) return `scale=${W}:${H}`;
  const cover = Math.max(W / sw, H / sh);
  if (keys.length === 1) {
    const key = keys[0]!;
    const c = cover * Math.max(1, key.scale);
    const SW = Math.max(W, Math.round(sw * c));
    const SH = Math.max(H, Math.round(sh * c));
    const ox = Math.min(SW - W, Math.max(0, Math.round(((SW - W) / 2) * (1 + key.x))));
    const oy = Math.min(SH - H, Math.max(0, Math.round(((SH - H) / 2) * (1 + key.y))));
    const scale = SW === sw && SH === sh ? '' : `scale=${SW}:${SH}:flags=bicubic,`;
    return `${scale}crop=${W}:${H}:${ox}:${oy}:exact=1`;
  }
  // Oversampling: the source's useful detail per output pixel (capped at its native resolution), so neither
  // stretched axis is downsampled before the perspective; at most 2x (render.ts zoompan's cap) for memory.
  const density = Math.min(1, cover * Math.max(...keys.map((key) => key.scale)));
  const m = Math.min(2, Math.max(1, (density * sw) / W, (density * sh) / H));
  const A = Math.max(2, Math.round((m * W) / 2) * 2);
  const B = Math.max(2, Math.round((m * H) / 2) * 2);
  const fx = A / sw;
  const fy = B / sh;
  const frame = (t: number): number => (t - segment.start) * fps;
  const curve = (pick: (key: PlanCropKey) => number): string => piecewiseLinear(keys.map((key) => ({ t: frame(key.t), v: pick(key) })), 'on');
  const S = curve((key) => key.scale);
  const X = curve((key) => key.x);
  const Y = curve((key) => key.y);
  // Visible source rect at pose (S, X, Y): size (W / c, H / c), origin ((sw - W / c) / 2 (1 + X), ...), c = cover * S.
  const vw = `(${f(W / cover)}/(${S}))`;
  const vh = `(${f(H / cover)}/(${S}))`;
  const left = `(${f(fx)}*(${f(sw)}-${vw})/2*(1+(${X})))`;
  const top = `(${f(fy)}*(${f(sh)}-${vh})/2*(1+(${Y})))`;
  const right = `(${left}+${f(fx)}*${vw})`;
  const bottom = `(${top}+${f(fy)}*${vh})`;
  const corners = `x0='${left}':y0='${top}':x1='${right}':y1='${top}':x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}'`;
  return `scale=${A}:${B}:flags=bicubic,perspective=${corners}:interpolation=linear:sense=source:eval=frame${A !== W || B !== H ? `,scale=${W}:${H}:flags=bicubic` : ''}`;
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
    graph.add(`[${input}:v]${orient ? `${orient},` : ''}format=gbrp,${cropFilters(layer.cropKeys, segment, uprightSize(probe), context)},` +
      `${toWorkingSpace(SRGB, context.plan, context.luts, { rgb: true })},loop=loop=${frames - 1}:size=1,${onGrid(context.fps)}[${label}]`);
    return await dimmed(graph, layer, segment, frames, context, label);
  }
  // A hold samples one frame at frameAt and repeats it.
  const sampling = layer.hold
    ? sampledInput(graph, probe.path, layer.hold.frameAt, 1, 1, context.fps)
    : sampledInput(graph, probe.path, layer.srcStart, layer.speed, frames, context.fps);
  const repeat = layer.hold ? `,tpad=stop_mode=clone:stop=${frames - 1}` : '';
  graph.add(`${sampling}${repeat},${cropFilters(layer.cropKeys, segment, uprightSize(probe), context)},` +
    `${toWorkingSpace(probe.color, context.plan, context.luts)},${onGrid(context.fps)}[${label}]`);
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

/** Consecutive segments grouped so one ffmpeg opens at most a handful of sources. */
function windows(segments: readonly PlanVideoSegment[], fps: number): PlanVideoSegment[][] {
  const MAX_INPUTS = 8;
  const MAX_FRAMES = 60 * fps;
  const out: PlanVideoSegment[][] = [];
  let current: PlanVideoSegment[] = [];
  let inputs = 0;
  let frames = 0;
  for (const segment of segments) {
    const need = segmentInputs(segment);
    const length = Math.round((segment.end - segment.start) * fps);
    if (current.length > 0 && (inputs + need > MAX_INPUTS || frames + length > MAX_FRAMES)) {
      out.push(current);
      current = [];
      inputs = 0;
      frames = 0;
    }
    current.push(segment);
    inputs += need;
    frames += length;
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
 * streams (alpha copied into all three planes), never as an alpha pixel
 * format or a gray one, because ffmpeg's swscale drops, rescales or
 * range-maps those differently from version to version (6.1 vs 9.0, measured)
 * while planar RGB plane copies stay exact. The colour is premultiplied,
 * scaled to the box, rotated (so edges do not pick up the fill's colour),
 * unpremultiplied, cropped to the frame and padded to W x H; the alpha gets
 * the same geometry. Then the colour goes to the working space and the alpha
 * becomes a float mask, each repeated over the whole output.
 */
function placeAndSplit(
  graph: Graph,
  /** `placed`: scaling and rotation were already applied (premultiplied colour and its coverage). */
  sources: { colour: string; alpha: string; premultiplied: boolean; placed?: boolean },
  box: PlanOverlay['box'],
  place: NonNullable<ReturnType<typeof placement>>,
  colourIn: string,
  frames: [number, number],
  still: boolean,
  context: Context,
): { colour: string; mask: string } {
  const radians = (box.rotationDeg * Math.PI) / 180;
  const geometry = sources.placed ? 'null' : `scale=${place.w}:${place.h}:flags=bicubic${box.rotationDeg ? `,rotate=${f(radians)}:ow=${place.RW}:oh=${place.RH}:c=black` : ''}`;
  const [cw, ch, cx, cy] = place.crop;
  const frame = `crop=${cw}:${ch}:${cx}:${cy}:exact=1,pad=${context.W}:${context.H}:${place.at[0]}:${place.at[1]}:color=black`;
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
  graph.add(`[${id}cg][${id}a1]unpremultiply=inplace=0,${frame}[${id}c]`);
  graph.add(`[${id}a2]${frame}[${id}a]`);
  const [first, end] = frames;
  // A still is processed once and repeated; timed media covers [first, end) and is padded out with clones
  // (maskedmerge's enable range ignores them).
  const extend = still ? `loop=loop=${context.total - 1}:size=1` : `tpad=start=${first}:stop=${context.total - end}:start_mode=clone:stop_mode=clone`;
  const colour = graph.label('ovc');
  const mask = graph.label('ova');
  graph.add(`[${id}c]zscale=${colourIn}:t=linear:p=2020:r=full:npl=203,format=gbrpf32le,${extend},${onGrid(context.fps)}[${colour}]`);
  graph.add(`[${id}a]zscale=tin=linear:pin=709:rin=full:t=linear:p=709:r=full,format=gbrpf32le,${extend},${onGrid(context.fps)}[${mask}]`);
  return { colour, mask };
}

/** Splits straight RGBA into planar colour and alpha-in-every-plane streams (exact plane copies). */
function splitRgba(graph: Graph, source: string): { colour: string; alpha: string } {
  const id = graph.label('rgba');
  graph.add(`[${source}]extractplanes=r+g+b+a[${id}r][${id}g][${id}b][${id}x]`);
  graph.add(`[${id}g][${id}b][${id}r]mergeplanes=map0s=0:map0p=0:map1s=1:map1p=0:map2s=2:map2p=0:format=gbrp[${id}c]`);
  graph.add(`[${id}x]split=3[${id}x1][${id}x2][${id}x3]`);
  graph.add(`[${id}x1][${id}x2][${id}x3]mergeplanes=map0s=0:map0p=0:map1s=1:map1p=0:map2s=2:map2p=0:format=gbrp[${id}a]`);
  return { colour: `${id}c`, alpha: `${id}a` };
}

const SRGB_IN = 'pin=709:tin=iec61966-2-1:rin=full';
const PQ_IN = 'pin=2020:tin=smpte2084:rin=full';

/** A media overlay (image, GIF, b-roll, emoji raster) as colour + mask, or undefined when it cannot draw. */
async function mediaOverlay(graph: Graph, overlay: PlanOverlay, context: Context): Promise<{ colour: string; mask: string; frames: [number, number] } | undefined> {
  const [first, end] = spanFrames(overlay.start, overlay.end, context.fps).map((frame) => Math.min(frame, context.total)) as [number, number];
  if (end <= first) return undefined;
  const place = placement(overlay.box, context);
  if (!place) return undefined;
  const source = graph.label('src');
  if (overlay.kind === 'emoji' || overlay.kind === 'image') {
    let path: string | undefined;
    let orientation = 1;
    if (overlay.kind === 'emoji') {
      path = (await context.rasterize(overlay.emoji!.text)) ?? (overlay.raster ? context.rasterPaths.get(overlay.raster.id) : undefined);
      if (!path) {
        context.notes.push(`Emoji sticker ${overlay.id} was left out: this server cannot draw colour emoji and the render has no raster for it.`);
        console.warn('[render-plan] overlay skipped', { overlay: overlay.id, reason: 'no emoji rasterizer or raster' });
        return undefined;
      }
    } else {
      const probe = context.media.get(overlay.media!.assetRef.id)!;
      path = probe.path;
      orientation = probe.orientation;
    }
    const input = graph.input(['-noautorotate', '-i', path]);
    const orient = orientationFilter(orientation);
    graph.add(`[${input}:v]${orient ? `${orient},` : ''}format=rgba[${source}]`);
    const split = splitRgba(graph, source);
    return { ...placeAndSplit(graph, { ...split, premultiplied: false }, overlay.box, place, SRGB_IN, [first, end], true, context), frames: [first, end] };
  }
  const media = overlay.media!;
  const probe = context.media.get(media.assetRef.id)!;
  const from = media.srcStart + (first / context.fps - overlay.start) * media.speed;
  if (overlay.kind === 'gif') {
    const gif = gifTiming(await readFile(probe.path));
    graph.add(`${sampledInput(graph, probe.path, Math.max(0, from), media.speed, end - first, context.fps, { gif })},format=rgba[${source}]`);
    const split = splitRgba(graph, source);
    return { ...placeAndSplit(graph, { ...split, premultiplied: false }, overlay.box, place, SRGB_IN, [first, end], false, context), frames: [first, end] };
  }
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
    return { ...placeAndSplit(graph, { colour: source, alpha, premultiplied: true }, overlay.box, place, PQ_IN, [first, end], false, context), frames: [first, end] };
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
  return { ...placeAndSplit(graph, { colour: source, alpha, premultiplied: true, placed: true }, overlay.box, place, PQ_IN, [first, end], false, context), frames: [first, end] };
}

/**
 * An ASS run (callouts and/or captions) as colour + mask. libass draws the
 * run twice, over opaque black and over opaque white: alpha = 1 - (white -
 * black) and the premultiplied colour is the black render, which recovers
 * exactly what libass layered (fill over stroke over shadow) whatever the
 * ffmpeg version does with alpha canvases. Straight colour = black / alpha.
 */
async function assRun(graph: Graph, items: AssItem[], index: number, context: Context): Promise<{ colour: string; mask: string; frames: [number, number] } | undefined> {
  const spans = items.map((item) => (item.kind === 'caption' ? item.caption : item.overlay))
    .map((item) => spanFrames(item.start, item.end, context.fps));
  const first = Math.min(...spans.map(([start]) => start));
  const end = Math.min(context.total, Math.max(...spans.map(([, stop]) => stop)));
  if (end <= first) return undefined;
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
      `subtitles=filename='${filterPath(assPath)}'${fontsdir},format=gbrp[${label}]`);
    return label;
  };
  const black = await canvas(0);
  const white = await canvas(255);
  const split = graph.label('gfx');
  graph.add(`[${black}]split=2[${split}b1][${split}b2]`);
  graph.add(`[${white}][${split}b1]blend=all_mode=difference,negate,split=2[${split}m][${split}a]`);
  graph.add(`[${split}b2][${split}a]unpremultiply=inplace=0[${split}c]`);
  const colour = graph.label('gfxc');
  const mask = graph.label('gfxa');
  const extend = `tpad=start=${first}:stop=${context.total - end}:start_mode=clone:stop_mode=clone`;
  graph.add(`[${split}c]zscale=${SRGB_IN}:t=linear:p=2020:r=full,format=gbrpf32le,${extend},${onGrid(context.fps)}[${colour}]`);
  graph.add(`[${split}m]zscale=tin=linear:pin=709:rin=full:t=linear:p=709:r=full,format=gbrpf32le,${extend},${onGrid(context.fps)}[${mask}]`);
  return { colour, mask, frames: [first, end] };
}

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
  const startedAt = Date.now();
  const plan = parseRenderPlanForExecutor(input);
  const total = planFrameCount(plan);
  if (total === 0) throw new Error('This plan has nothing to render (duration 0).');
  const caps = await planRenderCapabilities();
  if (caps.missing.length > 0) {
    throw new PlanRenderUnavailableError(`This ffmpeg cannot render plans; it lacks the filters: ${caps.missing.join(', ')}`);
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
    media.set(ref.id, await probePlanMedia(path, ref.kind));
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
    rasterize: out.rasterizeEmoji ?? rasterizeEmoji, rasterPaths, files: 0,
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
  const videoIn = graph.input(['-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${context.W}x${context.H}`, '-r', String(plan.fps), '-i', 'pipe:0']);
  const audioIn = graph.input(['-i', audio.wavPath]);
  let current = 'base';
  graph.add(`[${videoIn}:v]${onGrid(plan.fps)}[${current}]`);
  const merge = (layer: { colour: string; mask: string; frames: [number, number] }): void => {
    const next = graph.label('comp');
    graph.add(`[${current}][${layer.colour}][${layer.mask}]maskedmerge=enable='between(n,${layer.frames[0]},${layer.frames[1] - 1})'[${next}]`);
    current = next;
  };
  const overlays = [...plan.overlays].sort((left, right) => left.z - right.z);
  let run: AssItem[] = [];
  let runs = 0;
  const flush = async (): Promise<void> => {
    if (run.length === 0) return;
    const drawn = await assRun(graph, run, runs, context);
    runs += 1;
    run = [];
    if (drawn) merge(drawn);
  };
  for (const overlay of overlays) {
    if (overlay.kind === 'callout' && overlay.callout) {
      run.push({ kind: 'callout', overlay: overlay as PlanOverlay & { callout: PlanCallout } });
      continue;
    }
    await flush();
    const drawn = await mediaOverlay(graph, overlay, context);
    if (drawn) merge(drawn);
  }
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
