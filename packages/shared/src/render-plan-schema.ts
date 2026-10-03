import { z } from 'zod';
import { captionFaceSchema } from './caption-fonts.js';
import { calloutSchema } from './packets.js';

/*
 * RenderPlan v1: the frozen contract between the shared plan builder
 * (buildRenderPlan), the native compositor (editify-engine) and the server
 * render. Plan decisions 2A + OV4, OV7, OV10, 4A + OV6, 8A in
 * ~/.claude/plans/on-device-export.md.
 *
 * The builder makes every layout and timing decision; an executor only draws
 * what the plan says. If an executor needs to choose something (a size, a
 * position, a fade length, a word's timing, which clip is on top), the plan is
 * missing a field: add it here, never infer it in Swift or ffmpeg.
 *
 * Executor semantics shared by every section:
 *
 * - Time: seconds on the output timeline, from 0 to `duration`. Frame k is
 *   sampled at t = k / fps. A span [start, end) includes start and excludes end.
 *   Keyframes (`*Keys`) carry absolute timeline seconds, are strictly
 *   increasing in `t`, interpolate linearly between neighbours, and hold the
 *   first/last value outside their range.
 * - Space: output pixels of `size`, origin at the top-left, x right, y down.
 *   A preview drawn at another size scales every coordinate by view.w / size.w
 *   (plans keep the output aspect, so one factor serves both axes).
 * - Colour: hex colours are sRGB-encoded (BT.709 primaries, sRGB transfer).
 *   Compositing happens in linear, extended-range BT.2020: every source (SDR,
 *   HLG, PQ) and every graphic is converted into it before blending, and
 *   opacity and dimming are applied there. Graphics (overlays, emoji,
 *   callouts, captions, the background) are placed at the BT.2408 reference
 *   white of 203 nits, so sRGB white is 203 cd/m2 in an HLG master and plain
 *   100% white in an SDR one. The composite is then encoded to `color`.
 * - Draw order, bottom to top: `background`, then the current segment's video
 *   layers by ascending `z`, then the overlays on screen by ascending `z`, then
 *   the captions on screen by ascending `lane`. Video layers always sit below
 *   overlays, and overlays below captions, whatever their numbers.
 * - Media: an `assetRef` names a source, never a location. The device's media
 *   ladder (local original, proxy, server copy) resolves it; the plan does not.
 */

/** Plans whose `version` differs are refused outright: there is no migration between versions. */
export const RENDER_PLAN_VERSION = 1;

/** Float slack for comparing builder-computed times (segment joins, key bounds). */
export const RENDER_PLAN_EPSILON = 1e-6;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #RRGGBB colour');
const hexColorWithAlpha = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, 'expected a #RRGGBB or #RRGGBBAA colour');
const seconds = z.number().finite().min(0);
const pixels = z.number().finite();
/** Same range as a clip's `speed`. Never zero or negative: reverse playback is not a v1 feature. */
const speedSchema = z.number().finite().min(0.1).max(8);

export const assetRefSchema = z.object({
  /** The document's `clip.assetId`. */
  id: z.string().min(1),
  kind: z.enum(['video', 'audio', 'image']),
}).strict();
export type AssetRef = z.infer<typeof assetRefSchema>;

/**
 * One crop/zoom pose for a video layer. The layer always fills the whole
 * output frame; the key picks which part of the source shows.
 *
 * Convention (identical to render.ts's static chain, `scale` with
 * force_original_aspect_ratio=increase to W*s x H*s, then `crop` W x H at
 * (iw-W)/2*(1+x), and to the static branch of safezone.sourceYToScreen):
 *
 *   W, H   = plan.size
 *   sw, sh = the source's upright display size in pixels (after its
 *            preferred transform / rotation tag)
 *   c      = max(W / sw, H / sh) * scale        cover-fit, then zoom
 *   ox     = (sw * c - W) / 2 * (1 + x)         x = -1 left edge, 0 centred, 1 right edge
 *   oy     = (sh * c - H) / 2 * (1 + y)         y = -1 top edge,  0 centred, 1 bottom edge
 *
 * Output point (u, v) shows source point ((u + ox) / c, (v + oy) / c). The
 * visible source rect is origin (ox / c, oy / c), size (W / c, H / c). A source
 * point at normalized height n (0 top, 1 bottom) lands at screen y = n * sh * c - oy.
 *
 * `scale` is at least 1 (render.ts treats anything below 1 as 1, and the
 * builder clamps). x/y pan across the overflow of the zoomed cover image, so
 * they move the picture even at scale 1 when the source aspect differs from
 * the frame's.
 *
 * Animated zooms: render.ts's zoompan branch (clips with `transformEnd`), and
 * the RN preview, pan inside the frame-shaped centre crop instead. For a pose
 * (z, px, py) in that convention the equivalent key here is
 *   x = px * (W - W / z) / (Cw - W / z),   Cw = sw * max(W / sw, H / sh)
 * (0 when the denominator is 0), and likewise for y with H, Ch. The two agree
 * whenever the source aspect equals the frame's, so a move is then two keys;
 * otherwise the builder samples the move once per output frame so that linear
 * interpolation here reproduces it.
 */
export const cropKeySchema = z.object({
  t: seconds,
  scale: z.number().finite().min(1).max(10),
  x: z.number().finite().min(-1).max(1),
  y: z.number().finite().min(-1).max(1),
}).strict();
export type CropKey = z.infer<typeof cropKeySchema>;

/** A 0..1 value at timeline second `t`, for opacity and dim ramps. */
export const unitKeySchema = z.object({
  t: seconds,
  value: z.number().finite().min(0).max(1),
}).strict();
export type UnitKey = z.infer<typeof unitKeySchema>;

/**
 * One video clip's picture inside a segment.
 *
 * Source time at timeline t is `srcStart + (t - segment.start) * speed`. A clip
 * that spans several segments appears in each, with `srcStart` continuing
 * where the previous segment left off; the executor never carries state
 * between segments.
 */
export const videoLayerSchema = z.object({
  /** The document clip this layer draws: for selection handles and diagnostics, never for timing. */
  clipId: z.string().min(1),
  /** Index of the clip's track among the project's video tracks, in document order (0 = first). */
  trackIndex: z.number().int().min(0),
  /**
   * Stacking within the segment: higher draws on top. Unique per segment.
   * Later video tracks sit above earlier ones; inside a crossfade the incoming
   * clip sits above the outgoing one.
   */
  z: z.number().int(),
  /** `video`, or `image` for a still on a video track (it ignores srcStart and speed). */
  assetRef: assetRefSchema,
  /** Source seconds shown at `segment.start`. */
  srcStart: seconds,
  speed: speedSchema,
  /** At least one key. One key is a static pose. */
  cropKeys: z.array(cropKeySchema).min(1),
  /**
   * Layer alpha, multiplied in before the layer is composited over what is
   * below it (a crossfade fades the incoming layer from 0 to 1 over the
   * outgoing one). Empty means fully opaque.
   */
  opacityKeys: z.array(unitKeySchema),
  /**
   * Fade toward black while staying opaque, as ffmpeg's `fade` without alpha:
   * pixel = source * (1 - value). A dip to black ramps the outgoing layer 0 to
   * 1 and the incoming one 1 to 0. Absent or empty means no dimming.
   */
  dimKeys: z.array(unitKeySchema).optional(),
  /**
   * Freeze-frame: the layer shows the single source frame at `frameAt` (source
   * seconds; the latest frame whose presentation time is at or before it) for
   * the whole segment, and `srcStart`/`speed` do not move the picture. Used
   * where a crossfade outlasts the outgoing clip's source handles
   * (transitions.ts `holdLastFrameFor`).
   */
  hold: z.object({ frameAt: seconds }).strict().optional(),
}).strict();
export type VideoLayer = z.infer<typeof videoLayerSchema>;

/**
 * A span of the timeline where the set of video layers is constant: one
 * AVVideoCompositionInstruction on the device. Segments tile [0, duration]
 * with no gaps or overlaps; a stretch with no picture is a segment with no
 * layers (the background shows).
 */
export const videoSegmentSchema = z.object({
  start: seconds,
  end: seconds,
  /** N layers, any number of video tracks overlapping. */
  layers: z.array(videoLayerSchema),
}).strict().superRefine((segment, ctx) => {
  if (!(segment.end > segment.start)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `segment end ${segment.end} must be after its start ${segment.start}`, path: ['end'] });
  }
  const seen = new Map<number, number>();
  segment.layers.forEach((layer, index) => {
    const other = seen.get(layer.z);
    if (other !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `layers ${other} and ${index} share z ${layer.z}; stacking order must be explicit`,
        path: ['layers', index, 'z'],
      });
    } else {
      seen.set(layer.z, index);
    }
    const keyed: Array<['cropKeys' | 'opacityKeys' | 'dimKeys', Array<{ t: number }>]> = [
      ['cropKeys', layer.cropKeys],
      ['opacityKeys', layer.opacityKeys],
      ['dimKeys', layer.dimKeys ?? []],
    ];
    for (const [name, keys] of keyed) {
      checkKeys(keys, segment.start, segment.end, 'segment', ctx, ['layers', index, name]);
    }
  });
});
export type VideoSegment = z.infer<typeof videoSegmentSchema>;

/**
 * An overlay's rectangle, in output pixels.
 * Anchor: (x, y) is the CENTRE of the rectangle, not its top-left corner.
 * w and h are the unrotated size; the rectangle turns `rotationDeg` degrees
 * clockwise about its centre. Matches the document's overlay placement
 * (x/y centre fractions, clockwise rotation) and render.ts's `x - w/2`.
 */
export const overlayBoxSchema = z.object({
  x: pixels,
  y: pixels,
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
  rotationDeg: z.number().finite().min(-180).max(180),
}).strict();
export type OverlayBox = z.infer<typeof overlayBoxSchema>;

/**
 * Timed media inside an overlay. Source time at timeline t is
 * `srcStart + (t - overlay.start) * speed`; with `loop` it wraps modulo the
 * media's duration (GIFs), without it the last frame holds once the source
 * runs out. A still image ignores all three. B-roll overlays are picture
 * only: their sound, if any, is an `audio` entry.
 */
export const overlayMediaSchema = z.object({
  assetRef: assetRefSchema,
  srcStart: seconds,
  speed: speedSchema,
  loop: z.boolean().optional(),
}).strict();
export type OverlayMedia = z.infer<typeof overlayMediaSchema>;

/**
 * A callout card, the document's `calloutSchema` with every default resolved
 * so the executor picks nothing: `color` is the verdict glyph/accent colour,
 * `bg` the card fill (may carry alpha). The card is drawn the way
 * server/src/media/callout.ts rasterizes it (bold system face, verdict glyph
 * for check/x, ~0.6em padding, ~0.45em corner radius, ~0.35em glyph gap,
 * white label), scaled uniformly to fill the overlay box; the builder sizes
 * the box from the card's natural aspect.
 */
export const overlayCalloutSchema = z.object({
  variant: calloutSchema.shape.variant,
  text: z.string().min(1),
  color: hexColor,
  bg: hexColorWithAlpha,
}).strict();
export type OverlayCallout = z.infer<typeof overlayCalloutSchema>;

/**
 * Anything drawn over the video and under the captions.
 *
 * - `image`, `gif`, `broll`: `media` is stretched to fill the box exactly (the
 *   builder sizes h from the media's aspect, as render.ts's `scale=w:-2`).
 *   image/gif take an `image` asset, broll a `video` asset.
 * - `emoji`: `text` set on one line in Apple Color Emoji, its typographic
 *   bounds (advance width x line height) scaled to fill the box.
 * - `callout`: see overlayCalloutSchema.
 */
export const overlaySchema = z.object({
  /** The document clip id. */
  id: z.string().min(1),
  kind: z.enum(['image', 'gif', 'emoji', 'callout', 'broll']),
  /** Stacking among overlays: higher draws on top. Unique across the plan. */
  z: z.number().int(),
  start: seconds,
  end: seconds,
  box: overlayBoxSchema,
  media: overlayMediaSchema.optional(),
  text: z.string().min(1).optional(),
  callout: overlayCalloutSchema.optional(),
}).strict().superRefine((overlay, ctx) => {
  if (!(overlay.end > overlay.start)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `overlay end ${overlay.end} must be after its start ${overlay.start}`, path: ['end'] });
  }
  const wants = {
    image: { media: 'image', text: false, callout: false },
    gif: { media: 'image', text: false, callout: false },
    broll: { media: 'video', text: false, callout: false },
    emoji: { media: undefined, text: true, callout: false },
    callout: { media: undefined, text: false, callout: true },
  } as const;
  const want = wants[overlay.kind];
  if (want.media && !overlay.media) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${overlay.kind} overlay needs media`, path: ['media'] });
  } else if (want.media && overlay.media && overlay.media.assetRef.kind !== want.media) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${overlay.kind} overlay needs a ${want.media} asset, not ${overlay.media.assetRef.kind}`, path: ['media', 'assetRef', 'kind'] });
  } else if (!want.media && overlay.media) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${overlay.kind} overlay carries no media`, path: ['media'] });
  }
  if (want.text !== (overlay.text !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: want.text ? 'an emoji overlay needs text' : `a ${overlay.kind} overlay carries no text`, path: ['text'] });
  }
  if (want.callout !== (overlay.callout !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: want.callout ? 'a callout overlay needs its callout' : `a ${overlay.kind} overlay carries no callout`, path: ['callout'] });
  }
});
export type Overlay = z.infer<typeof overlaySchema>;

/**
 * A karaoke word. `s`/`e` are ABSOLUTE timeline seconds, inside the caption's
 * [start, end]. The document stores `captionStyle.words` relative to the first
 * word instead: renderers light word i at `clip.start + (words[i].s - words[0].s)`
 * (libass starts the `\k` clock at the event start). The builder converts:
 *   s = clip.start + (word.s - words[0].s),  e = clip.start + (word.e - words[0].s)
 * then clamps both into the caption's (possibly lane-trimmed) span.
 *
 * A word is drawn in `emphasisColor` from `s` onward and in `color` before it
 * (ASS `\k`: an instant switch, not a sweep). `e` is kept for word-level
 * animation and the ASS durations; v1 executors do not draw with it.
 */
export const captionWordSchema = z.object({
  w: z.string().min(1),
  s: seconds,
  e: seconds,
  /** Pen x where the word starts, in output pixels (same space as the line's x). */
  x: pixels,
}).strict();
export type CaptionWord = z.infer<typeof captionWordSchema>;

/**
 * One laid-out line, positioned by the shared caption layout (kern pairs from
 * the font tables, emoji widths from a table, OV7). The executor draws `text`
 * starting at pen position (x, y) with the font's kerning on and ligatures
 * off, and never re-wraps or re-centres it.
 */
export const captionLineSchema = z.object({
  text: z.string().min(1),
  /** Pen x of the first glyph (left edge of the advance box), output pixels. */
  x: pixels,
  /** The BASELINE, in output pixels from the top: not the line's top or centre. */
  y: pixels,
  /** Advance width of the whole line in pixels; with x it gives the line's horizontal extent. */
  width: z.number().finite().min(0),
  /**
   * Karaoke only. When present the line is drawn word by word, each word at
   * its own `x`, and the words joined by single spaces equal `text`.
   */
  words: z.array(captionWordSchema).min(1).optional(),
}).strict();
export type CaptionLine = z.infer<typeof captionLineSchema>;

export const captionSchema = z.object({
  /** The document clip id. */
  id: z.string().min(1),
  /**
   * Content + style revision: a stable hash of everything that changes the
   * caption's pixels (text, words, style, layout). The CaptionRenderer's cache
   * key is (id, rev, sung-word count, scale), so any visible change must
   * change `rev` (OV10).
   */
  rev: z.string().min(1),
  /** Timeline span, after lane overlap trimming (ass.ts: a lane's previous caption ends where the next starts). */
  start: seconds,
  end: seconds,
  /**
   * Vertical lane (one per distinct anchor: top, centre, bottom, each custom
   * anchorPct). Captions in one lane never overlap in time; captions in
   * different lanes may, and draw in ascending lane order.
   */
  lane: z.number().int().min(0),
  font: captionFaceSchema,
  /** Final font size (em) in output pixels, after any shrink-to-fit. */
  sizePx: z.number().finite().positive(),
  color: hexColor,
  /** Outline around every glyph, drawn under the fill, extending strokePx outward. */
  strokeColor: hexColor,
  strokePx: z.number().finite().min(0),
  /** Sung karaoke words. Unused by captions without words. */
  emphasisColor: hexColor,
  /**
   * Drop shadow of the outlined text (libass `Shadow`: the glyphs plus outline,
   * offset offsetPx right and down, in `color` at `opacity`). Absent means none.
   */
  shadow: z.object({
    color: hexColor,
    opacity: z.number().finite().min(0).max(1),
    offsetPx: z.number().finite().min(0),
  }).strict().optional(),
  /**
   * A rounded backing box behind each line: horizontally [x - padPx,
   * x + width + padPx], vertically the face's ascender to descender at sizePx
   * around the baseline, grown by padPx. Absent means no box.
   */
  box: z.object({
    color: hexColor,
    opacity: z.number().finite().min(0).max(1),
    padPx: z.number().finite().min(0),
    radiusPx: z.number().finite().min(0),
  }).strict().optional(),
  /**
   * How the layout aligned the lines. Lines already carry their x, so a
   * drawing executor ignores this; the ASS writer uses it for `\an`.
   */
  align: z.enum(['left', 'center', 'right']),
  lines: z.array(captionLineSchema).min(1),
  /**
   * Overflow receipt (OV7): the caption did not fit at its styled size, so the
   * layout shrank it by `scale` (sizePx already includes it). Never an
   * ellipsis. `shrunk: false` always has scale 1.
   */
  fitted: z.object({
    shrunk: z.boolean(),
    scale: z.number().finite().positive().max(1),
  }).strict(),
}).strict().superRefine((caption, ctx) => {
  if (!(caption.end > caption.start)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `caption end ${caption.end} must be after its start ${caption.start}`, path: ['end'] });
  }
  if (caption.fitted.shrunk !== caption.fitted.scale < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: caption.fitted.shrunk ? 'a shrunk caption has a scale below 1' : 'an unshrunk caption has scale 1',
      path: ['fitted', 'scale'],
    });
  }
  const karaokeLines = caption.lines.filter((line) => line.words).length;
  if (karaokeLines > 0 && karaokeLines < caption.lines.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'either every line of a caption has words or none does', path: ['lines'] });
  }
  let previousStart = -Infinity;
  caption.lines.forEach((line, lineIndex) => {
    if (!line.words) return;
    if (line.words.map((word) => word.w).join(' ') !== line.text) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the line\'s words joined by spaces must equal its text', path: ['lines', lineIndex, 'words'] });
    }
    line.words.forEach((word, wordIndex) => {
      const path = ['lines', lineIndex, 'words', wordIndex];
      const inside = (time: number): boolean => time >= caption.start - RENDER_PLAN_EPSILON && time <= caption.end + RENDER_PLAN_EPSILON;
      if (!inside(word.s) || !inside(word.e)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `word "${word.w}" [${word.s}, ${word.e}] is outside the caption's time [${caption.start}, ${caption.end}]; word times are absolute timeline seconds`,
          path,
        });
      }
      if (word.e < word.s) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `word "${word.w}" ends before it starts`, path: [...path, 'e'] });
      }
      if (word.s < previousStart) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `word "${word.w}" starts before the word ahead of it`, path: [...path, 's'] });
      }
      previousStart = word.s;
    });
  });
});
export type Caption = z.infer<typeof captionSchema>;

/**
 * Edge fade on an audio entry. `linear` is ffmpeg's `tri` (the crossfade and
 * dip ramps, which sum back to unity across a crossfade); `halfSine` is
 * ffmpeg's `hsin`, gain (1 - cos(pi * p)) / 2 (the 8 ms declick on plain cuts).
 * A fade-in starts at `at`; a fade-out ends at the entry's end.
 */
export const audioFadeSchema = z.object({
  duration: seconds,
  curve: z.enum(['linear', 'halfSine']),
}).strict();
export type AudioFade = z.infer<typeof audioFadeSchema>;

/**
 * One stretch of sound: a video clip's own track, an audio clip, b-roll sound.
 * Plays source [in, out) of the asset's first audio track, time-stretched by
 * `speed` with pitch preserved (atempo / spectral), starting at timeline `at`
 * and ending at `at + (out - in) / speed`. Entries are summed with no
 * normalization (amix normalize=0).
 *
 * Gain at t = gainKeys(t) x fadeIn(t) x fadeOut(t), linear amplitude. The
 * builder bakes the clip volume, duck ramps (duck.ts: 0.3 floor, 0.12 s linear
 * ramps), and any crossfade/dip windows into these; the executor applies
 * exactly that.
 */
export const audioEntrySchema = z.object({
  /** The document clip id. */
  id: z.string().min(1),
  /** A `video` asset (its own sound) or an `audio` asset. */
  assetRef: assetRefSchema,
  at: seconds,
  in: seconds,
  out: seconds,
  speed: speedSchema,
  /** Linear amplitude keys, absolute timeline seconds inside the entry's span. At least one. */
  gainKeys: z.array(z.object({ t: seconds, gain: z.number().finite().min(0).max(4) }).strict()).min(1),
  fadeIn: audioFadeSchema,
  fadeOut: audioFadeSchema,
}).strict().superRefine((entry, ctx) => {
  if (entry.assetRef.kind === 'image') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an audio entry needs a video or audio asset', path: ['assetRef', 'kind'] });
  }
  if (!(entry.out > entry.in)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `audio out ${entry.out} must be after its in ${entry.in}`, path: ['out'] });
    return;
  }
  const end = audioEntryEnd(entry);
  checkKeys(entry.gainKeys, entry.at, end, 'audio entry', ctx, ['gainKeys']);
  const length = end - entry.at;
  for (const name of ['fadeIn', 'fadeOut'] as const) {
    if (entry[name].duration > length + RENDER_PLAN_EPSILON) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} ${entry[name].duration}s is longer than the entry (${length}s)`, path: [name, 'duration'] });
    }
  }
});
export type AudioEntry = z.infer<typeof audioEntrySchema>;

/** Timeline second an audio entry stops playing. */
export function audioEntryEnd(entry: Pick<AudioEntry, 'at' | 'in' | 'out' | 'speed'>): number {
  return entry.at + (entry.out - entry.in) / entry.speed;
}

export const renderPlanSchema = z.object({
  version: z.literal(RENDER_PLAN_VERSION),
  /**
   * The project revision this plan was built from (OV10). Monotonic per
   * project: an executor holding revision R drops any plan below R, and a
   * server snapshot render is keyed by it (OV1).
   */
  revision: z.number().int().min(0),
  /** Output frame in pixels. Even, for 4:2:0 encoding. */
  size: z.object({
    w: z.number().int().positive().multipleOf(2),
    h: z.number().int().positive().multipleOf(2),
  }).strict(),
  fps: z.number().int().min(1).max(120),
  /** Output length in seconds. 0 only for a plan with nothing on it. */
  duration: seconds,
  /**
   * Output encoding (4A + OV6). `sdr`: BT.709 SDR, H.264 High 8-bit; HDR
   * sources are tone mapped. `hlg`: BT.2020 HLG, HEVC Main10. Compositing is
   * linear extended BT.2020 either way.
   */
  color: z.enum(['sdr', 'hlg']),
  /** Fills the frame under every layer (render.ts BASE_COLOR #0B0B0F). */
  background: hexColor,
  /**
   * Master loudness (8A). With `targetLufs`, the mix's integrated loudness is
   * measured, one gain stage brings it to the target, and a look-ahead
   * true-peak limiter holds peaks at `truePeakDb` (video delayed to match the
   * limiter's latency). `targetLufs: null` leaves the mix untouched: no gain,
   * no limiter.
   */
  loudness: z.object({
    targetLufs: z.number().finite().max(0).nullable(),
    truePeakDb: z.number().finite().max(0),
  }).strict(),
  video: z.object({ segments: z.array(videoSegmentSchema) }).strict(),
  overlays: z.array(overlaySchema),
  captions: z.array(captionSchema),
  audio: z.array(audioEntrySchema),
}).strict().superRefine((plan, ctx) => {
  const { duration } = plan;
  const within = (end: number): boolean => end <= duration + RENDER_PLAN_EPSILON;

  // Segments tile [0, duration] exactly: AVVideoComposition needs instructions
  // covering the whole composition, and a gap would be an executor decision.
  const segments = plan.video.segments;
  if (duration === 0 && segments.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a plan with duration 0 has no segments', path: ['video', 'segments'] });
  }
  if (duration > 0 && segments.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `segments must cover [0, ${duration}]; use a segment with no layers for an empty stretch`, path: ['video', 'segments'] });
  }
  let cursor = 0;
  segments.forEach((segment, index) => {
    if (Math.abs(segment.start - cursor) > RENDER_PLAN_EPSILON) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: index === 0
          ? `the first segment must start at 0, not ${segment.start}`
          : `segment ${index} starts at ${segment.start} but the previous one ends at ${cursor}; segments must be contiguous`,
        path: ['video', 'segments', index, 'start'],
      });
    }
    cursor = segment.end;
  });
  if (segments.length > 0 && Math.abs(cursor - duration) > RENDER_PLAN_EPSILON) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `the last segment ends at ${cursor}, not at duration ${duration}`, path: ['video', 'segments', segments.length - 1, 'end'] });
  }

  const overlayZ = new Map<number, number>();
  plan.overlays.forEach((overlay, index) => {
    if (!within(overlay.end)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `overlay ends at ${overlay.end}, past duration ${duration}`, path: ['overlays', index, 'end'] });
    }
    const other = overlayZ.get(overlay.z);
    if (other !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `overlays ${other} and ${index} share z ${overlay.z}; stacking order must be explicit`, path: ['overlays', index, 'z'] });
    } else {
      overlayZ.set(overlay.z, index);
    }
  });
  checkUniqueIds(plan.overlays, ctx, 'overlays');

  plan.captions.forEach((caption, index) => {
    if (!within(caption.end)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `caption ends at ${caption.end}, past duration ${duration}`, path: ['captions', index, 'end'] });
    }
  });
  checkUniqueIds(plan.captions, ctx, 'captions');
  const byLane = new Map<number, number[]>();
  plan.captions.forEach((caption, index) => byLane.set(caption.lane, [...(byLane.get(caption.lane) ?? []), index]));
  for (const indexes of byLane.values()) {
    const ordered = [...indexes].sort((left, right) => plan.captions[left]!.start - plan.captions[right]!.start);
    for (let at = 1; at < ordered.length; at += 1) {
      const previous = plan.captions[ordered[at - 1]!]!;
      const current = plan.captions[ordered[at]!]!;
      if (previous.end > current.start + RENDER_PLAN_EPSILON) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `captions ${previous.id} and ${current.id} overlap in lane ${current.lane}; a lane shows one caption at a time`,
          path: ['captions', ordered[at]!, 'start'],
        });
      }
    }
  }

  plan.audio.forEach((entry, index) => {
    // A bad span or speed is already reported on the entry itself.
    if (entry.out > entry.in && entry.speed > 0 && !within(audioEntryEnd(entry))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `audio entry ends at ${audioEntryEnd(entry)}, past duration ${duration}`, path: ['audio', index] });
    }
  });
  checkUniqueIds(plan.audio, ctx, 'audio');
});
export type RenderPlan = z.infer<typeof renderPlanSchema>;

/** Keys strictly increasing in t and inside [from, to]. */
function checkKeys(keys: ReadonlyArray<{ t: number }>, from: number, to: number, owner: string, ctx: z.RefinementCtx, path: Array<string | number>): void {
  keys.forEach((key, index) => {
    if (key.t < from - RENDER_PLAN_EPSILON || key.t > to + RENDER_PLAN_EPSILON) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `key at t=${key.t} is outside the ${owner} [${from}, ${to}]`, path: [...path, index, 't'] });
    }
    const previous = keys[index - 1];
    if (previous && !(key.t > previous.t)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `key at t=${key.t} must come after the previous key at t=${previous.t}`, path: [...path, index, 't'] });
    }
  });
}

function checkUniqueIds(items: ReadonlyArray<{ id: string }>, ctx: z.RefinementCtx, section: string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${section} id ${item.id} appears twice`, path: [section, index, 'id'] });
    seen.add(item.id);
  });
}
