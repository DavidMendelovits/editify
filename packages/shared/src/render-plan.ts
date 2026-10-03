import { CAPTION_MAX_LINES, captionWords, reserveCaptionLayouts, EMOJI_ASCENT_EM, EMOJI_DESCENT_EM, fontMetrics, layoutCaption, measureEmojiRun, measureText } from './caption-layout.js';
import { captionFaceFor, type PlanFontFace } from './caption-fonts.js';
import { clipTimelineDuration, type CaptionStyle, type Clip, type Project } from './index.js';
import {
  PLAN_LIMITS,
  planFrameAt,
  RENDER_PLAN_EPSILON,
  RENDER_PLAN_VERSION,
  renderPlanSchema,
  type PlanAudioEntry,
  type PlanCallout,
  type PlanCaption,
  type PlanCaptionLine,
  type PlanCropKey,
  type PlanLoudness,
  type PlanOverlay,
  type PlanUnitKey,
  type PlanVideoLayer,
  type PlanVideoSegment,
  type RenderPlan,
} from './render-plan-schema.js';
import { designFrame } from './safezone.js';

/*
 * buildRenderPlan: the project document, the media it names and a target
 * (preview or export) in, one RenderPlan v1 out (plan decisions 2A + OV4,
 * OV7, OV10 in ~/.claude/plans/on-device-export.md). Pure and deterministic:
 * the same input gives byte-identical JSON. Every timing and layout rule here
 * is the one the legacy server render (server/src/media/render.ts,
 * transitions.ts, duck.ts, ass.ts) applies today, except where a comment
 * names an intended divergence.
 */

export type PlanResolution = '720p' | '1080p' | '4k';

/** Output pixels for an export, the same mapping as render.ts `dimensions`. */
export function exportPlanSize(format: Project['format'], resolution: PlanResolution): { w: number; h: number } {
  const short = resolution === '720p' ? 720 : resolution === '1080p' ? 1080 : 2160;
  if (format === '9:16') return { w: short, h: Math.round(short * 16 / 9) };
  if (format === '1:1') return { w: short, h: short };
  return { w: Math.round(short * 16 / 9), h: short };
}

export interface PlanTarget {
  kind: 'preview' | 'export';
  /** Output pixels: exportPlanSize() for an export, the view size for a preview (rounded to even). */
  size: { w: number; h: number };
  /** Defaults to project.fps. Must be a whole number: RenderPlan v1 has an integer fps. */
  fps?: number;
  color: 'sdr' | 'hlg';
  /** Master loudness normalization (render-qa's `normalize`); on unless false. */
  loudness?: boolean;
}

/** What the builder needs to know about one source; the media ladder answers it. */
export interface PlanAssetInfo {
  kind: 'video' | 'audio' | 'image';
  /** Stored pixel size; `rotation` turns it upright. */
  width: number;
  height: number;
  /** Seconds of media (0 for a still). */
  duration: number;
  hasAudio: boolean;
  /** An animated image (GIF): loops on an overlay. */
  animated?: boolean;
  /** Source frame rate, for picking a hold's last frame. */
  fps?: number;
  /** Clockwise display rotation (preferred transform, rotation tag or EXIF), degrees. */
  rotation?: number;
}

export interface BuildRenderPlanOptions {
  revision: number;
  buildSeq: number;
  assetInfo: (assetId: string) => PlanAssetInfo | undefined;
  /**
   * Parse the result with the strict schema before returning it (default
   * true). A preview rebuilding on every drag may turn it off; exports and
   * tests keep it.
   */
  selfCheck?: boolean;
}

/** A project the builder cannot turn into a valid plan (unknown asset, fractional fps). */
export class RenderPlanBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderPlanBuildError';
  }
}

/** render.ts BASE_COLOR. */
export const PLAN_BACKGROUND = '#0B0B0F';

/**
 * Master loudness, the constants server/src/services/render-qa.ts uses: one
 * gain toward -16 LUFS outside a 0.5 LU deadband, nothing below -60 LUFS, a
 * limiter at -1.5 dB, -1 dBTP as the acceptance limit.
 */
export const PLAN_LOUDNESS: Readonly<Omit<PlanLoudness, 'targetLufs'>> & { targetLufs: number } = {
  targetLufs: -16,
  deadbandLu: 0.5,
  silentBelowLufs: -60,
  limiterCeilingDb: -1.5,
  truePeakLimitDb: -1,
};

/** duck.ts: everything else plays at 30% under a ducking clip, with 0.12 s linear ramps. */
export const DUCK_FLOOR = 0.3;
export const DUCK_RAMP = 0.12;
/** render.ts: the 8 ms half-sine declick on every plain audio edge. */
export const EDGE_DECLICK = 0.008;

/** callout.ts colours (the server keeps its own copy until P6 moves it onto the plan). */
const CALLOUT_ACCENT: Record<NonNullable<Clip['callout']>['variant'], string> = { check: '#39D98A', x: '#FF5C70', card: '#FFFFFF' };
const CALLOUT_BG = '#14141BF2';
/** callout.ts draws the card at 88 px (44 x 2) and rounds padding, radius and gap at that size. */
const CALLOUT_FONT_PX = 88;
const DEFAULT_PLACEMENT = { x: 0.5, y: 0.35, width: 0.28, rotation: 0 };
/** ass.ts karaoke default and libass BackColour &H64000000 (alpha 0x64 is 155/255 opaque). */
const DEFAULT_EMPHASIS = '#FACC15';
const SHADOW_OPACITY = 155 / 255;
/** ass.ts: MarginL/MarginR 40 and a 12% MarginV for top and bottom captions, at the 1080-wide design frame. */
const CAPTION_SIDE_MARGIN = 40;
const CAPTION_SAFE_MARGIN_PCT = 12;

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;
const round3 = (value: number): number => Math.round(value * 1e3) / 1e3 + 0;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const lerp = (from: number, to: number, p: number): number => from + (to - from) * p;
const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/**
 * Timeline order, ties by id compared by UTF-16 code unit (locale-free, so
 * every device sorts alike). Legacy render.ts and ass.ts use localeCompare,
 * which orders differently only for ids differing in case or non-ASCII.
 */
function sortedClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((left, right) => left.start - right.start || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/* ------------------------------------------------------------------------ */
/* Transitions (ported from server/src/media/transitions.ts, same semantics) */

/** What one clip's stream does for the transitions touching it. Fade times are in the clip's own seconds. */
export interface ClipTransitionPlan {
  extendSourceBy: number;
  holdLastFrameFor?: number;
  videoFadeIn?: { d: number; alpha: boolean };
  videoFadeOut?: { st: number; d: number };
  audioFadeIn?: number;
  audioFadeOut?: { st: number; d: number };
}

/**
 * transitions.ts planTransitions, unchanged: a crossfade into B borrows source
 * past the previous clip's out point (holding its last frame where the asset
 * runs out); a dip fades both sides through black around the cut.
 */
export function planVideoTransitions(clips: readonly Clip[], assetDurations: ReadonlyMap<string, number>, fps: number): Map<string, ClipTransitionPlan> {
  const plans = new Map<string, ClipTransitionPlan>();
  const planFor = (id: string): ClipTransitionPlan => {
    const existing = plans.get(id);
    if (existing) return existing;
    const plan: ClipTransitionPlan = { extendSourceBy: 0 };
    plans.set(id, plan);
    return plan;
  };
  const tolerance = 1 / fps + 1e-6;
  clips.forEach((clip, index) => {
    if (!clip.transition) return;
    const duration = Math.min(clip.transition.duration, clipTimelineDuration(clip));
    const previous = clips[index - 1];
    const adjacent = previous && Math.abs(previous.start + clipTimelineDuration(previous) - clip.start) <= tolerance
      ? previous
      : undefined;
    if (clip.transition.type === 'crossfade') {
      const opening = planFor(clip.id);
      opening.videoFadeIn = { d: duration, alpha: true };
      opening.audioFadeIn = duration;
      if (!adjacent) return;
      const speed = adjacent.speed ?? 1;
      const headroom = Math.max(0, (assetDurations.get(adjacent.assetId ?? '') ?? adjacent.out) - adjacent.out);
      const extend = Math.min(duration * speed, headroom);
      const overlap = extend / speed;
      const closing = planFor(adjacent.id);
      if (extend > 0) {
        closing.extendSourceBy = extend;
        closing.audioFadeOut = { st: clipTimelineDuration(adjacent), d: overlap };
      }
      if (duration - overlap > 1e-6) closing.holdLastFrameFor = duration - overlap;
      if (overlap > 0) opening.audioFadeIn = overlap;
      else delete opening.audioFadeIn;
      return;
    }
    const half = duration / 2;
    const opening = planFor(clip.id);
    opening.videoFadeIn = { d: half, alpha: false };
    opening.audioFadeIn = half;
    if (!adjacent) return;
    const seconds = clipTimelineDuration(adjacent);
    const out = { st: Math.max(0, seconds - half), d: Math.min(half, seconds) };
    const closing = planFor(adjacent.id);
    closing.videoFadeOut = out;
    closing.audioFadeOut = out;
  });
  return plans;
}

/* ------------------------------------------------------------------------ */
/* Keys                                                                     */

interface ValueKey { t: number; v: number[] }

function valueAt(keys: readonly ValueKey[], time: number): number[] {
  const first = keys[0]!;
  if (time <= first.t) return first.v;
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index]!;
    if (time <= right.t) {
      const left = keys[index - 1]!;
      const p = right.t > left.t ? (time - left.t) / (right.t - left.t) : 1;
      return left.v.map((value, at) => lerp(value, right.v[at]!, p));
    }
  }
  return keys[keys.length - 1]!.v;
}

const sameValue = (left: readonly number[], right: readonly number[]): boolean => left.every((value, at) => Math.abs(value - right[at]!) <= 1e-9);

/**
 * The part of a timeline-wide key list that a segment [start, end] needs:
 * the value at each edge, the keys strictly inside, then boundary keys that
 * only repeat their neighbour dropped (keys hold outside their range). An
 * unchanging list is one key at `start`.
 */
function sliceKeys(keys: readonly ValueKey[], start: number, end: number): ValueKey[] {
  if (keys.length === 0) return [];
  const inside = keys.filter((key) => key.t > start + RENDER_PLAN_EPSILON && key.t < end - RENDER_PLAN_EPSILON);
  const raw: ValueKey[] = [{ t: start, v: valueAt(keys, start) }, ...inside, { t: end, v: valueAt(keys, end) }];
  const rounded: ValueKey[] = [];
  for (const key of raw) {
    const t = key.t === start || key.t === end ? key.t : round6(key.t);
    const previous = rounded.at(-1);
    if (previous && !(t > previous.t)) continue;
    rounded.push({ t, v: key.v.map(round6) });
  }
  if (rounded.every((key) => sameValue(key.v, rounded[0]!.v))) return [rounded[0]!];
  while (rounded.length > 1 && sameValue(rounded[0]!.v, rounded[1]!.v)) rounded.shift();
  while (rounded.length > 1 && sameValue(rounded.at(-1)!.v, rounded.at(-2)!.v)) rounded.pop();
  return rounded;
}

/* ------------------------------------------------------------------------ */
/* Video                                                                    */

interface Picture {
  clip: Clip;
  info: PlanAssetInfo;
  trackIndex: number;
  z: number;
  /** First frame, first held frame, frame after the last. */
  first: number;
  holdFrom: number;
  end: number;
  holdAt: number;
  crop: ValueKey[];
  opacity: ValueKey[];
  dim: ValueKey[];
}

function upright(info: PlanAssetInfo): { width: number; height: number } {
  const quarter = (((Math.round((info.rotation ?? 0) / 90) % 4) + 4) % 4);
  return quarter % 2 === 1 ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

/**
 * Crop keys in the schema's convention (render.ts's static chain). A static
 * transform is one key. An animated one (render.ts zoompan, the RN preview)
 * pans inside the frame-shaped centre crop instead: when the source aspect
 * matches the frame the two conventions coincide and the move is two keys;
 * otherwise the move is sampled once per output frame, converted with
 * x = px (W - W/z) / (Cw - W/z), and simplified (simplifyCropKeys).
 */
function cropKeys(clip: Clip, info: PlanAssetInfo, width: number, height: number, first: number, fps: number): ValueKey[] {
  const from = clip.transform ?? { scale: 1, x: 0, y: 0 };
  const pose = (transform: { scale: number; x: number; y: number }): number[] =>
    [clamp(Math.max(1, transform.scale), 1, 10), clamp(transform.x, -1, 1), clamp(transform.y, -1, 1)];
  const start = first / fps;
  if (!clip.transformEnd) return [{ t: start, v: pose(from) }];
  const to = clip.transformEnd;
  const frames = Math.max(1, Math.round(clipTimelineDuration(clip) * fps));
  const source = upright(info);
  const cover = source.width > 0 && source.height > 0 ? Math.max(width / source.width, height / source.height) : 0;
  const coverWidth = cover > 0 ? source.width * cover : width;
  const coverHeight = cover > 0 ? source.height * cover : height;
  if (Math.abs(coverWidth - width) < 0.5 && Math.abs(coverHeight - height) < 0.5) {
    return [{ t: start, v: pose(from) }, { t: (first + frames) / fps, v: pose(to) }];
  }
  const convert = (pan: number, zoom: number, frame: number, covered: number): number => {
    const denominator = covered - frame / zoom;
    return Math.abs(denominator) < 1e-9 ? 0 : clamp((pan * (frame - frame / zoom)) / denominator, -1, 1);
  };
  const [fromZoom, fromX, fromY] = pose(from) as [number, number, number];
  const [toZoom, toX, toY] = pose(to) as [number, number, number];
  const keys: ValueKey[] = [];
  // Very long moves are sampled every few frames; the curve is smooth, and simplifying keeps the error in pixels.
  const stride = Math.max(1, Math.ceil(frames / MAX_CROP_SAMPLES));
  for (let frame = 0; frame <= frames; frame = frame === frames ? frames + 1 : Math.min(frames, frame + stride)) {
    const p = frame / frames;
    const zoom = lerp(fromZoom, toZoom, p);
    keys.push({
      t: (first + frame) / fps,
      v: [zoom, convert(lerp(fromX, toX, p), zoom, width, coverWidth), convert(lerp(fromY, toY, p), zoom, height, coverHeight)],
    });
  }
  return simplifyCropKeys(keys, { width, height, coverWidth, coverHeight });
}

const cropCache = new Map<string, ValueKey[]>();
const CROP_CACHE_SIZE = 512;

/**
 * cropKeys memoized on everything it reads, so a rebuild after an unrelated
 * edit does not re-sample and re-simplify every long zoom. Read-only results.
 */
function memoCropKeys(clip: Clip, info: PlanAssetInfo, width: number, height: number, first: number, fps: number): ValueKey[] {
  if (!clip.transformEnd) return cropKeys(clip, info, width, height, first, fps);
  const source = upright(info);
  const key = JSON.stringify([clip.transform ?? null, clip.transformEnd, clipTimelineDuration(clip), first, fps, width, height, source.width, source.height]);
  let keys = cropCache.get(key);
  if (!keys) {
    keys = cropKeys(clip, info, width, height, first, fps);
    cropCache.set(key, keys);
    if (cropCache.size > CROP_CACHE_SIZE) cropCache.delete(cropCache.keys().next().value!);
  }
  return keys;
}

/** Per-frame samples taken for one zoom at most; past this the samples spread out. */
const MAX_CROP_SAMPLES = 100_000;
/** Largest drift, in output pixels, that dropping a crop key may cause. */
const CROP_TOLERANCE_PX = 0.1;

interface CropFrame { width: number; height: number; coverWidth: number; coverHeight: number }

/**
 * How far apart two poses put the picture, in output pixels: the largest
 * distance between where each pose shows the same source point at the four
 * output corners. Poses are (scale, x, y) in the crop-key convention, with
 * the source measured in cover-fit output pixels (Cw x Ch).
 */
function poseDistance(left: readonly number[], right: readonly number[], frame: CropFrame): number {
  const place = (pose: readonly number[]): [number, number, number] => {
    const [scale, x, y] = pose as [number, number, number];
    return [scale, (frame.coverWidth * scale - frame.width) / 2 * (1 + x), (frame.coverHeight * scale - frame.height) / 2 * (1 + y)];
  };
  const [scaleA, oxA, oyA] = place(left);
  const [scaleB, oxB, oyB] = place(right);
  let worst = 0;
  for (const [u, v] of [[0, 0], [frame.width, 0], [0, frame.height], [frame.width, frame.height]] as const) {
    // Source point under (u, v) for pose A, then where pose B draws it.
    const sx = (u + oxA) / scaleA;
    const sy = (v + oyA) / scaleA;
    worst = Math.max(worst, Math.hypot(sx * scaleB - oxB - u, sy * scaleB - oyB - v));
  }
  return worst;
}

/**
 * Drops crop keys that linear interpolation between their neighbours
 * reproduces within CROP_TOLERANCE_PX (Douglas-Peucker on the pixel
 * distance), so a constant-scale pan is two keys and a long zoom a handful.
 * If the result still exceeds PLAN_LIMITS.keys the tolerance doubles until it
 * fits.
 */
function simplifyCropKeys(keys: ValueKey[], frame: CropFrame): ValueKey[] {
  if (keys.length <= 2) return keys;
  for (let tolerance = CROP_TOLERANCE_PX; ; tolerance *= 2) {
    const keep = new Uint8Array(keys.length);
    keep[0] = 1;
    keep[keys.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, keys.length - 1]];
    while (stack.length > 0) {
      const [from, to] = stack.pop()!;
      const left = keys[from]!;
      const right = keys[to]!;
      let worst = 0;
      let at = -1;
      for (let index = from + 1; index < to; index += 1) {
        const key = keys[index]!;
        const p = (key.t - left.t) / (right.t - left.t);
        const distance = poseDistance(key.v, left.v.map((value, axis) => lerp(value, right.v[axis]!, p)), frame);
        if (distance > worst) {
          worst = distance;
          at = index;
        }
      }
      if (at >= 0 && worst > tolerance) {
        keep[at] = 1;
        stack.push([from, at], [at, to]);
      }
    }
    const kept = keys.filter((_key, index) => keep[index] === 1);
    if (kept.length <= PLAN_LIMITS.keys) return kept;
  }
}

/** Two fades in series on one picture: dim = 1 - (1 - in)(1 - out), sampled at every key time. */
function combineDims(fadeIn: ValueKey[], fadeOut: ValueKey[]): ValueKey[] {
  if (fadeIn.length === 0) return fadeOut;
  if (fadeOut.length === 0) return fadeIn;
  const times = [...new Set([...fadeIn, ...fadeOut].map((key) => key.t))].sort((left, right) => left - right);
  return times.map((t) => ({ t, v: [1 - (1 - valueAt(fadeIn, t)[0]!) * (1 - valueAt(fadeOut, t)[0]!)] }));
}

function videoPictures(project: Project, fps: number, width: number, height: number, totalFrames: number,
  info: (clip: Clip) => PlanAssetInfo, transitions: Map<string, ClipTransitionPlan>): Picture[] {
  const pictures: Picture[] = [];
  let z = 0;
  project.tracks.filter((track) => track.kind === 'video').forEach((track, trackIndex) => {
    for (const clip of sortedClips(track.clips)) {
      if (!clip.assetId) continue;
      const media = info(clip);
      // render.ts draws only sources with a picture.
      if (media.kind === 'audio' || !(media.width > 0 && media.height > 0)) continue;
      const stack = z;
      z += 1;
      const plan = transitions.get(clip.id);
      const speed = clip.speed ?? 1;
      const extend = plan?.extendSourceBy ?? 0;
      const total = (clip.out + extend - clip.in) / speed + (plan?.holdLastFrameFor ?? 0);
      const first = planFrameAt(clip.start, fps);
      const end = Math.min(planFrameAt(clip.start + total, fps), totalFrames);
      if (end <= first || first >= totalFrames) continue;
      // Frames past the source become a hold of its last frame: a crossfade's
      // planned hold, or quantization reaching past the asset's end.
      let holdFrom = end;
      let holdAt = 0;
      if (media.kind === 'video') {
        const limit = plan?.holdLastFrameFor ? clip.out + extend : media.duration > 0 ? media.duration : Number.POSITIVE_INFINITY;
        if (Number.isFinite(limit)) {
          holdFrom = clamp(first + Math.ceil(((limit - clip.in) / speed) * fps - RENDER_PLAN_EPSILON), first, end);
          holdAt = Math.max(0, limit - 1 / Math.max(fps, media.fps ?? fps));
        }
      }
      const start = first / fps;
      const fadeIn = plan?.videoFadeIn;
      const fadeOut = plan?.videoFadeOut;
      const opacity: ValueKey[] = fadeIn?.alpha ? [{ t: start, v: [0] }, { t: start + fadeIn.d, v: [1] }] : [];
      const dimIn: ValueKey[] = fadeIn && !fadeIn.alpha ? [{ t: start, v: [1] }, { t: start + fadeIn.d, v: [0] }] : [];
      const dimOut: ValueKey[] = fadeOut ? [{ t: start + fadeOut.st, v: [0] }, { t: start + fadeOut.st + fadeOut.d, v: [1] }] : [];
      pictures.push({
        clip, info: media, trackIndex, z: stack, first, holdFrom, end, holdAt,
        crop: memoCropKeys(clip, media, width, height, first, fps),
        opacity,
        dim: combineDims(dimIn, dimOut),
      });
    }
  });
  return pictures;
}

function videoSegments(pictures: Picture[], fps: number, totalFrames: number): PlanVideoSegment[] {
  if (totalFrames === 0) return [];
  const edges = new Set<number>([0, totalFrames]);
  for (const picture of pictures) {
    edges.add(picture.first);
    edges.add(picture.holdFrom);
    edges.add(picture.end);
  }
  const frames = [...edges].filter((frame) => frame >= 0 && frame <= totalFrames).sort((left, right) => left - right);
  const segments: PlanVideoSegment[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const from = frames[index - 1]!;
    const to = frames[index]!;
    const start = from / fps;
    const end = to / fps;
    const layers = pictures
      .filter((picture) => picture.first <= from && to <= picture.end)
      .sort((left, right) => left.z - right.z)
      .map((picture): PlanVideoLayer => {
        const { clip, info } = picture;
        const still = info.kind === 'image';
        const speed = still ? 1 : clip.speed ?? 1;
        const layer: PlanVideoLayer = {
          clipId: clip.id,
          trackIndex: picture.trackIndex,
          z: picture.z,
          assetRef: { id: clip.assetId!, kind: still ? 'image' : 'video' },
          srcStart: still ? 0 : round6(clip.in + ((from - picture.first) * speed) / fps),
          speed,
          cropKeys: sliceKeys(picture.crop, start, end).map(({ t, v }): PlanCropKey => ({ t, scale: v[0]!, x: v[1]!, y: v[2]! })),
          opacityKeys: unitKeys(picture.opacity, start, end, 1),
          dimKeys: unitKeys(picture.dim, start, end, 0),
        };
        if (!still && from >= picture.holdFrom) layer.hold = { frameAt: round6(picture.holdAt) };
        return layer;
      });
    const previous = segments.at(-1);
    segments.push({ start: previous ? previous.end : start, end, layers });
  }
  return segments;
}

/** Sliced 0..1 keys; a list that never leaves `identity` is empty. */
function unitKeys(keys: ValueKey[], start: number, end: number, identity: number): PlanUnitKey[] {
  const sliced = sliceKeys(keys, start, end);
  if (sliced.every((key) => Math.abs(key.v[0]! - identity) <= 1e-9)) return [];
  return sliced.map(({ t, v }) => ({ t, value: clamp(v[0]!, 0, 1) }));
}

/* ------------------------------------------------------------------------ */
/* Audio                                                                    */

interface DuckWindow { start: number; end: number }

/** duck.ts duckWindows: the ducking clips' spans, sorted and merged when they touch. */
export function planDuckWindows(clips: readonly Clip[]): DuckWindow[] {
  const spans = clips
    .filter((clip) => clip.duck)
    .map((clip) => ({ start: clip.start, end: clip.start + clipTimelineDuration(clip) }))
    .sort((left, right) => left.start - right.start);
  const merged: DuckWindow[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** duck.ts rounds every time to the millisecond before it reaches the expression. */
const ms = (value: number): number => Number(value.toFixed(3));

/** One window's 0..1 duck amount at t, duck.ts's rise x fall. */
function windowAmount(window: DuckWindow, time: number): number {
  const rise = ms(Math.max(0, window.start - DUCK_RAMP));
  const fall = ms(window.end + DUCK_RAMP);
  return clamp((time - rise) / DUCK_RAMP, 0, 1) * clamp((fall - time) / DUCK_RAMP, 0, 1);
}

/** The duck.ts envelope as a gain: 1 - (1 - floor) x max over windows. */
function duckGain(windows: readonly DuckWindow[], time: number): number {
  const amount = windows.reduce((most, window) => Math.max(most, windowAmount(window, time)), 0);
  return 1 - ms(1 - DUCK_FLOOR) * amount;
}

/**
 * Gain keys for a bed entry over [from, to]: clip volume times the duck
 * envelope. The envelope is piecewise linear between ramp corners and the
 * points where two windows' ramps cross; a window shorter than its two ramps
 * multiplies rise by fall, so that stretch is sampled every 10 ms.
 */
function gainKeys(volume: number, windows: readonly DuckWindow[], from: number, to: number): Array<{ t: number; gain: number }> {
  const times = new Set<number>([from, to]);
  for (const window of windows) {
    const rise = ms(Math.max(0, window.start - DUCK_RAMP));
    const fall = ms(window.end + DUCK_RAMP);
    for (const corner of [rise, rise + DUCK_RAMP, fall - DUCK_RAMP, fall]) times.add(corner);
    if (fall - rise < 2 * DUCK_RAMP) {
      for (let time = fall - DUCK_RAMP; time < rise + DUCK_RAMP; time += 0.01) times.add(time);
    }
    for (const other of windows) {
      if (other === window) continue;
      const otherRise = ms(Math.max(0, other.start - DUCK_RAMP));
      // This window's fall meets the other's rise halfway between their ramp anchors.
      if (otherRise < fall && otherRise + DUCK_RAMP > fall - DUCK_RAMP) times.add((fall + otherRise) / 2);
    }
  }
  const sorted = [...times].filter((time) => time >= from && time <= to).sort((left, right) => left - right);
  const keys: Array<{ t: number; gain: number }> = [];
  for (const time of sorted) {
    const t = round6(time);
    const previous = keys.at(-1);
    if (previous && !(t > previous.t)) continue;
    keys.push({ t, gain: round6(volume * duckGain(windows, time)) });
  }
  // Drop interior keys that sit on the line between their neighbours.
  const simplified: Array<{ t: number; gain: number }> = [];
  keys.forEach((key, index) => {
    const before = simplified.at(-1);
    const after = keys[index + 1];
    if (before && after) {
      const expected = lerp(before.gain, after.gain, (key.t - before.t) / (after.t - before.t));
      if (Math.abs(expected - key.gain) <= 1e-9) return;
    }
    simplified.push(key);
  });
  if (simplified.every((key) => key.gain === simplified[0]!.gain)) return [simplified[0]!];
  return simplified;
}

/* ------------------------------------------------------------------------ */
/* Overlays                                                                 */

function overlayBox(clip: Clip, width: number, height: number, aspect: number): PlanOverlay['box'] {
  const placement = clip.overlay ?? DEFAULT_PLACEMENT;
  // render.ts: the sticker is scaled to an even width, height by aspect (scale=w:-2), centred on the placement.
  const w = even(width * placement.width);
  return {
    x: Math.round(placement.x * width),
    y: Math.round(placement.y * height),
    w,
    h: even(w * aspect),
    rotationDeg: placement.rotation,
  };
}

/**
 * Emoji sticker: render.ts rasterized the text in Apple Color Emoji at 320 px
 * and scaled that PNG to the sticker width, so the box takes the PNG's aspect
 * (one emoji line is 1.3125 em tall) and the payload is fitted inside it.
 * Stickers are meant for emoji: any other character in one is set by Core
 * Text's fallback (Apple Color Emoji has no letters) and measured with the
 * fallback width, so a text sticker's fit is approximate.
 */
function emojiOverlay(clip: Clip, text: string, width: number, height: number): Pick<PlanOverlay, 'box' | 'emoji'> {
  const { widthEm } = measureEmojiRun(text, 'Montserrat-Bold');
  const lineEm = EMOJI_ASCENT_EM + EMOJI_DESCENT_EM;
  const rasterPx = 320;
  const aspect = Math.max(2, Math.ceil(lineEm * rasterPx)) / Math.max(2, Math.ceil(Math.max(widthEm, 1e-6) * rasterPx));
  const box = overlayBox(clip, width, height, aspect);
  const size = Math.min(box.w / Math.max(widthEm, 1e-6), box.h / lineEm);
  return {
    box,
    emoji: {
      text,
      sizePx: round3(size),
      x: round3((box.w - widthEm * size) / 2),
      y: round3((box.h - lineEm * size) / 2 + EMOJI_ASCENT_EM * size),
      width: round3(widthEm * size),
    },
  };
}

/**
 * Callout card, laid out the way callout.ts draws it at 88 px (padding 0.6 em,
 * radius 0.45 em, glyph gap 0.35 em, rounded at that size), then scaled to the
 * sticker width. The label is set in the bundled face (callout.ts used the
 * system bold; intended), and the verdict glyph is a 0.8 em vector mark
 * centred on the line where callout.ts drew a text glyph.
 */
function calloutOverlay(clip: Clip, callout: NonNullable<Clip['callout']>, text: string, width: number, height: number): Pick<PlanOverlay, 'box' | 'callout'> {
  const face: PlanFontFace = 'Montserrat-Bold';
  const metrics = fontMetrics(face);
  const font = CALLOUT_FONT_PX;
  const padding = Math.round(font * 0.6);
  const radius = Math.round(font * 0.45);
  const gap = Math.round(font * 0.35);
  const shape = callout.variant === 'check' ? 'check' : callout.variant === 'x' ? 'cross' : undefined;
  const glyphSide = shape ? Math.round(font * 0.8) : 0;
  const textWidth = measureText(text, face, font);
  const textHeight = ((metrics.ascender + metrics.descender) * font) / metrics.unitsPerEm;
  const line = Math.max(textHeight, glyphSide);
  const lead = shape ? glyphSide + gap : 0;
  const cardWidth = Math.max(2, Math.ceil(lead + textWidth + padding * 2));
  const cardHeight = Math.max(2, Math.ceil(line + padding * 2));
  const box = overlayBox(clip, width, height, cardHeight / cardWidth);
  const k = box.w / cardWidth;
  const label: PlanCallout['label'] = {
    text,
    font: face,
    sizePx: round3(font * k),
    x: round3((padding + lead) * k),
    y: round3((padding + (line - textHeight) / 2 + (metrics.ascender * font) / metrics.unitsPerEm) * k),
    width: round3(textWidth * k),
    color: '#FFFFFF',
  };
  // Keys in draw order: card, glyph, label.
  const payload: PlanCallout = {
    variant: callout.variant,
    card: { x: 0, y: 0, w: box.w, h: box.h, radiusPx: round3(radius * k), color: callout.bg ?? CALLOUT_BG },
    ...(shape ? {
      glyph: {
        shape,
        x: round3(padding * k),
        y: round3((padding + (line - glyphSide) / 2) * k),
        w: round3(glyphSide * k),
        h: round3(glyphSide * k),
        strokePx: round3(Math.max(0.5, glyphSide * 0.14 * k)),
        color: callout.color ?? CALLOUT_ACCENT[callout.variant],
      },
    } : {}),
    label,
  };
  return { box, callout: payload };
}

/**
 * One overlay clip's kind, box and payload at an output size: what `overlays`
 * emits for it, minus id, z and timing. Exported so a preview can redraw a
 * sticker being dragged by patching only its overlay (a parameter-only plan
 * update) and land exactly where the next full build puts it. `info` is the
 * clip's asset (required for media stickers); undefined when the clip draws nothing.
 */
export function planOverlayLayout(clip: Clip, width: number, height: number, info?: PlanAssetInfo): Omit<PlanOverlay, 'id' | 'z' | 'start' | 'end'> | undefined {
  if (clip.assetId) {
    if (!info) throw new RenderPlanBuildError(`Asset ${clip.assetId} referenced by clip ${clip.id} is unknown`);
    const source = upright(info);
    const aspect = source.width > 0 && source.height > 0 ? source.height / source.width : 1;
    if (info.kind === 'video') {
      // Intended divergence: legacy looped b-roll from its source start; the plan trims it like a clip.
      return {
        kind: 'broll',
        box: overlayBox(clip, width, height, aspect),
        media: { assetRef: { id: clip.assetId, kind: 'video' }, srcStart: round6(clip.in), speed: clip.speed ?? 1, loop: false },
      };
    }
    if (info.kind === 'image') {
      return info.animated
        ? { kind: 'gif', box: overlayBox(clip, width, height, aspect), media: { assetRef: { id: clip.assetId, kind: 'image' }, srcStart: 0, speed: 1, loop: true } }
        : { kind: 'image', box: overlayBox(clip, width, height, aspect), media: { assetRef: { id: clip.assetId, kind: 'image' }, srcStart: 0, speed: 1 } };
    }
    return undefined;
  }
  if (clip.text && clip.callout) return { kind: 'callout', ...calloutOverlay(clip, clip.callout, clip.text, width, height) };
  if (clip.text) return { kind: 'emoji', ...emojiOverlay(clip, clip.text, width, height) };
  return undefined;
}

function overlays(project: Project, width: number, height: number, duration: number, info: (clip: Clip) => PlanAssetInfo): PlanOverlay[] {
  const out: PlanOverlay[] = [];
  let z = 0;
  for (const track of project.tracks) {
    if (track.kind !== 'overlay') continue;
    for (const clip of sortedClips(track.clips)) {
      const start = round6(clip.start);
      const end = round6(Math.min(clip.start + clipTimelineDuration(clip), duration));
      const item = planOverlayLayout(clip, width, height, clip.assetId ? info(clip) : undefined);
      if (!item || !(end > start)) continue;
      out.push({ id: clip.id, z, start, end, ...item } as PlanOverlay);
      z += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Captions                                                                 */

/** What ass.ts renders a caption with when the clip carries no style. */
const LEGACY_CAPTION_STYLE: CaptionStyle = { font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold' };

interface CaptionEvent {
  clip: Clip;
  style: CaptionStyle;
  laneKey: string;
  start: number;
  end: number;
}

/**
 * ass.ts captionEvents: one lane per vertical anchor (alignment, custom
 * anchor, margin), and inside a lane a caption ends where the next begins.
 * Lanes are numbered by first appearance on the timeline.
 */
export function planCaptionLanes(project: Project): Array<{ clip: Clip; style: CaptionStyle; lane: number; start: number; end: number }> {
  const clips = project.tracks.filter((track) => track.kind === 'caption')
    .flatMap((track) => track.clips)
    .filter((clip) => Boolean(clip.text));
  const events: CaptionEvent[] = sortedClips(clips).map((clip) => {
    const style = clip.style ?? LEGACY_CAPTION_STYLE;
    const alignment = style.anchorPct !== undefined ? 5 : style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2;
    const margin = style.position === 'center' || style.anchorPct !== undefined ? 0 : 1;
    return { clip, style, laneKey: `${alignment}:${style.anchorPct ?? ''}:${margin}`, start: clip.start, end: clip.start + clipTimelineDuration(clip) };
  });
  const lanes = new Map<string, CaptionEvent[]>();
  const order: string[] = [];
  for (const event of events) {
    const lane = lanes.get(event.laneKey) ?? [];
    if (!lanes.has(event.laneKey)) order.push(event.laneKey);
    const previous = lane.at(-1);
    if (previous && previous.end > event.start) previous.end = Math.max(previous.start, event.start);
    lane.push(event);
    lanes.set(event.laneKey, lane);
  }
  return events.map((event) => ({ clip: event.clip, style: event.style, lane: order.indexOf(event.laneKey), start: event.start, end: event.end }));
}

/** FNV-1a, 32 bits, as 8 hex digits: a stable content hash with no dependency. */
function fnv1a(text: string, seed = 0x811c9dc5): string {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * One caption, laid out the way libass sets it today, at the 1080-wide design
 * frame and then scaled to the output (so a preview and an export break lines
 * identically):
 * - ASS Fontsize is the CELL height: libass scales the face so OS/2
 *   winAscent + winDescent equals it, so the em is Fontsize x unitsPerEm /
 *   (winAscent + winDescent) (0.64 for Montserrat; checked against a libass
 *   render: Fontsize 100 draws a 45 px cap height and puts the baseline
 *   winDescent above the margin). Lines are one cell apart.
 * - Wrapping is greedy within 1080 - 2 x 40 px, then balanced to even line
 *   widths at the same line count (close to libass WrapStyle 0, not
 *   identical), shrinking in 5% steps past three lines.
 * - Bottom/top captions sit 12% of the height from the edge, centre ones and
 *   custom anchors are centred on their anchor.
 * Stroke (default 3 px), the 1 px drop shadow and the margins are the ASS
 * values at 1080 wide, scaled with the frame (legacy kept them at fixed
 * pixels at 720p and 4K; intended).
 */
function planCaption(
  event: { clip: Clip; style: CaptionStyle; lane: number; start: number; end: number },
  format: Project['format'],
  width: number,
): PlanCaption | undefined {
  const { clip, style } = event;
  const design = designFrame(format);
  const k = width / design.width;
  const face = captionFaceFor(style.font);
  const metrics = fontMetrics(face);
  const karaoke = style.words?.length ? style.words : undefined;
  const split = karaoke ? { words: karaoke.map((word) => word.w), breaks: new Set<number>() } : captionWords(clip.text ?? '');
  if (split.words.length === 0) return undefined;
  const cell = Math.max(10, Math.round(style.sizePct !== undefined ? design.height * style.sizePct / 100 : style.size * design.width / 1080));
  const winBox = metrics.winAscent + metrics.winDescent;
  const em = (cell * metrics.unitsPerEm) / winBox;
  const layout = layoutCaption({
    words: split.words,
    breaks: split.breaks,
    face,
    sizePx: em,
    maxWidth: design.width - 2 * CAPTION_SIDE_MARGIN,
    maxLines: CAPTION_MAX_LINES,
  });
  const fittedCell = cell * layout.scale;
  const ascent = (fittedCell * metrics.winAscent) / winBox;
  const block = fittedCell * layout.lines.length;
  const margin = Math.max(0, Math.round(design.height * CAPTION_SAFE_MARGIN_PCT / 100));
  const top = style.anchorPct !== undefined
    ? design.height * style.anchorPct / 100 - block / 2
    : style.position === 'top' ? margin
      : style.position === 'center' ? (design.height - block) / 2
        : design.height - margin - block;

  // Karaoke: document word times are relative to words[0].s; the plan's are absolute and inside the caption.
  const base = karaoke?.[0]?.s ?? 0;
  let previousStart = event.start;
  const times = karaoke?.map((word) => {
    const s = Math.max(previousStart, clamp(clip.start + (word.s - base), event.start, event.end));
    previousStart = s;
    return { s: round6(s), e: round6(Math.max(s, clamp(clip.start + (word.e - base), event.start, event.end))) };
  });
  const lines: PlanCaptionLine[] = layout.lines.map((line, lineIndex) => {
    const x = (design.width - line.width) / 2;
    const planned: PlanCaptionLine = {
      text: line.text,
      x: round3(x * k),
      y: round3((top + lineIndex * fittedCell + ascent) * k),
      width: round3(line.width * k),
    };
    if (times) {
      if (line.rightToLeft || line.approximate) {
        // Text the face does not set (right-to-left or fallback script): the
        // layout cannot place its words, so the line is ONE karaoke word that
        // Core Text draws as a single bidi run, lit from its first word's
        // time to its last word's end.
        const first = times[line.words[0]!.index]!;
        const last = times[line.words.at(-1)!.index]!;
        planned.words = [{ w: line.text, s: first.s, e: Math.max(first.s, last.e), x: planned.x }];
      } else {
        planned.words = line.words.map((word) => {
          const time = times[word.index]!;
          return { w: word.w, s: time.s, e: Math.max(time.s, time.e), x: round3((x + word.x) * k) };
        });
      }
    }
    return planned;
  });
  const look = {
    font: face,
    sizePx: round3(layout.sizePx * k),
    color: style.color,
    strokeColor: style.strokeColor ?? '#000000',
    strokePx: round3((style.strokePx ?? 3) * k),
    emphasisColor: style.emphasisColor ?? DEFAULT_EMPHASIS,
    shadow: { color: '#000000', opacity: round6(SHADOW_OPACITY), offsetPx: round3(1 * k) },
    align: 'center' as const,
    lines,
    fitted: {
      shrunk: layout.shrunk,
      scale: layout.scale,
      ...(layout.overflow ? { overflow: true } : {}),
      ...(layout.approximate ? { approximate: true } : {}),
    },
  };
  // Everything that changes the caption's pixels; times only pick the sung-word count, which the cache keys separately.
  const pixels = JSON.stringify({ ...look, lines: lines.map((line) => ({ ...line, words: line.words?.map(({ w, x }) => ({ w, x })) })) });
  return {
    id: clip.id,
    rev: `${fnv1a(pixels)}${fnv1a(pixels, 0x01000193)}`,
    start: round6(event.start),
    end: round6(event.end),
    lane: event.lane,
    ...look,
  };
}

/* ------------------------------------------------------------------------ */
/* The plan                                                                 */

/** A count for people: 2100 -> "2,100", with no locale dependency. */
function count(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The plan caps (PLAN_LIMITS) bound hostile input; a real edit should never
 * reach them, and when one does the user gets a plain reason instead of a
 * degraded plan. Native enforces the same caps on every plan it is handed,
 * including previews built with selfCheck: false.
 */
function checkProjectFits(project: Project, width: number, height: number, duration: number): void {
  const fail = (message: string): never => {
    throw new RenderPlanBuildError(message);
  };
  if (Math.max(width, height) > PLAN_LIMITS.longSidePx || Math.min(width, height) > PLAN_LIMITS.shortSidePx) {
    fail(`The output size ${width} x ${height} is larger than ${PLAN_LIMITS.longSidePx} x ${PLAN_LIMITS.shortSidePx}.`);
  }
  if (duration > PLAN_LIMITS.durationSec) {
    fail(`This edit runs ${Math.round(duration / 60)} minutes; the limit is ${PLAN_LIMITS.durationSec / 3600} hours.`);
  }
  const clips = (kind: Project['tracks'][number]['kind']): Clip[] => project.tracks.filter((track) => track.kind === kind).flatMap((track) => track.clips);
  const stickers = clips('overlay').filter((clip) => clip.assetId || clip.text).length;
  if (stickers > PLAN_LIMITS.overlays) fail(`This edit has ${count(stickers)} stickers; the limit is ${count(PLAN_LIMITS.overlays)}.`);
  const captionCount = clips('caption').filter((clip) => clip.text).length;
  if (captionCount > PLAN_LIMITS.captions) fail(`This edit has ${count(captionCount)} captions; the limit is ${count(PLAN_LIMITS.captions)}.`);
}

function checkSegments(segments: PlanVideoSegment[]): PlanVideoSegment[] {
  if (segments.length > PLAN_LIMITS.segments) {
    throw new RenderPlanBuildError(`This edit changes picture ${count(segments.length)} times; the limit is ${count(PLAN_LIMITS.segments)}.`);
  }
  const crowded = segments.find((segment) => segment.layers.length > PLAN_LIMITS.layersPerSegment);
  if (crowded) {
    throw new RenderPlanBuildError(`${crowded.layers.length} video clips overlap at ${crowded.start.toFixed(1)} s; the limit is ${PLAN_LIMITS.layersPerSegment}.`);
  }
  return segments;
}

/**
 * Builds RenderPlan v1 and, unless `selfCheck` is false, checks it against the
 * strict schema (throws on a builder bug rather than handing an executor a
 * plan it must refuse). Content never makes it throw; an unknown asset or a
 * fractional fps does.
 */
export function buildRenderPlan(project: Project, target: PlanTarget, options: BuildRenderPlanOptions): RenderPlan {
  const fps = target.fps ?? project.fps;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    throw new RenderPlanBuildError(`RenderPlan v1 needs a whole-number fps from 1 to 120, not ${fps}; a rational rate such as 30000/1001 needs a schema feature`);
  }
  const width = even(target.size.w);
  const height = even(target.size.h);
  // Same quantization as the clip edges, so a clip ending at the project end
  // ends on the last frame; any length at all gets at least one frame.
  const totalFrames = project.duration > 0 ? Math.max(1, planFrameAt(project.duration, fps)) : 0;
  const duration = totalFrames / fps;

  checkProjectFits(project, width, height, duration);

  const infos = new Map<string, PlanAssetInfo>();
  const info = (clip: Clip): PlanAssetInfo => {
    const id = clip.assetId!;
    let found = infos.get(id);
    if (!found) {
      found = options.assetInfo(id);
      if (!found) throw new RenderPlanBuildError(`Asset ${id} referenced by clip ${clip.id} is unknown`);
      infos.set(id, found);
    }
    return found;
  };

  // Transitions are planned per video track over the whole track, as render.ts does.
  const transitions = new Map<string, ClipTransitionPlan>();
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue;
    const ordered = sortedClips(track.clips);
    if (!ordered.some((clip) => clip.transition)) continue;
    const durations = new Map<string, number>();
    for (const clip of ordered) if (clip.assetId) durations.set(clip.assetId, info(clip).duration);
    for (const [id, plan] of planVideoTransitions(ordered, durations, fps)) transitions.set(id, plan);
  }

  const pictures = videoPictures(project, fps, width, height, totalFrames, info, transitions);

  // Audio: every video/audio clip with sound, in render.ts input order. The
  // bed (everything but the ducking audio clips) is ducked under them.
  const sounding: Array<{ clip: Clip; kind: 'video' | 'audio'; media: PlanAssetInfo }> = [];
  for (const track of project.tracks) {
    if (track.kind !== 'video' && track.kind !== 'audio') continue;
    for (const clip of sortedClips(track.clips)) {
      if (!clip.assetId) continue;
      const media = info(clip);
      if (media.hasAudio && media.kind !== 'image') sounding.push({ clip, kind: track.kind, media });
    }
  }
  if (sounding.length > PLAN_LIMITS.audio) {
    throw new RenderPlanBuildError(`This edit has ${count(sounding.length)} clips with sound; the limit is ${count(PLAN_LIMITS.audio)}.`);
  }
  const duckers = sounding.filter((entry) => entry.kind === 'audio' && entry.clip.duck).map((entry) => entry.clip);
  const windows = planDuckWindows(duckers);
  const audio: PlanAudioEntry[] = [];
  for (const { clip, media } of sounding) {
    const plan = transitions.get(clip.id);
    const speed = clip.speed ?? 1;
    const at = clip.start;
    let out = clip.out + (plan?.extendSourceBy ?? 0);
    if (at >= duration) continue;
    // The master stops at the plan's duration (render.ts atrim=0:duration).
    if (at + (out - clip.in) / speed > duration) out = clip.in + (duration - at) * speed;
    if (!(out > clip.in)) continue;
    const entry = { at: round6(at), in: round6(clip.in), out: round6(out), speed };
    const length = (entry.out - entry.in) / speed;
    const declick = Math.min(EDGE_DECLICK, length / 2);
    const fade = (seconds: number | undefined): PlanAudioEntry['fadeIn'] => (seconds === undefined
      ? { duration: round6(declick), curve: 'halfSine' }
      : { duration: round6(Math.min(seconds, length)), curve: 'linear' });
    const ducked = !duckers.includes(clip);
    audio.push({
      id: audio.some((other) => other.id === clip.id) ? `${clip.id}#${audio.length}` : clip.id,
      clipId: clip.id,
      assetRef: { id: clip.assetId!, kind: media.kind === 'audio' ? 'audio' : 'video' },
      ...entry,
      gainKeys: gainKeys(clip.volume ?? 1, ducked ? windows : [], entry.at, round6(entry.at + length)),
      fadeIn: fade(plan?.audioFadeIn),
      fadeOut: fade(plan?.audioFadeOut?.d),
    });
  }

  const lanes = planCaptionLanes(project);
  reserveCaptionLayouts(lanes.length);
  const captions = lanes
    .map((event) => ({ ...event, end: Math.min(event.end, duration) }))
    .filter((event) => event.end > event.start)
    .map((event) => planCaption(event, project.format, width))
    .filter((caption): caption is PlanCaption => caption !== undefined && caption.end > caption.start);

  const plan: RenderPlan = {
    version: RENDER_PLAN_VERSION,
    requires: [],
    revision: options.revision,
    buildSeq: options.buildSeq,
    size: { w: width, h: height },
    fps,
    duration,
    color: target.color,
    background: PLAN_BACKGROUND,
    loudness: { ...PLAN_LOUDNESS, targetLufs: target.loudness === false ? null : PLAN_LOUDNESS.targetLufs },
    video: { segments: checkSegments(videoSegments(pictures, fps, totalFrames)) },
    overlays: overlays(project, width, height, duration, info),
    captions,
    audio,
  };
  if (options.selfCheck === false) return plan;
  const checked = renderPlanSchema.safeParse(plan);
  if (!checked.success) {
    const problems = checked.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new RenderPlanBuildError(`buildRenderPlan produced an invalid plan: ${problems}`);
  }
  return plan;
}
