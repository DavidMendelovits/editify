import { z } from 'zod';
import { planFontFaceSchema } from './caption-fonts.js';
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
 * SCHEMA EVOLUTION
 * - `requires` lists the critical features a plan uses beyond v1 (empty in
 *   v1). An executor refuses a plan that requires anything it does not know.
 *   Native exposes its supported-feature list, and the builder emits only
 *   features the target executor draws. Anything that changes pixels or sound
 *   in a way an older executor would get wrong (a new overlay kind, a new
 *   curve, a new enum value) is a feature and goes in `requires`.
 * - Executors ignore unknown keys: a new optional, non-critical field must not
 *   break an older executor. TS executors parse with
 *   parseRenderPlanForExecutor(), which checks `requires` and then strips unknown
 *   keys); Swift decodes with Codable, which ignores them by default.
 * - renderPlanSchema is strict (unknown keys and unknown features fail). It is
 *   for the builder's self-check and for tests, never for an executor.
 *
 * ORDERING (OV10)
 * Plans are ordered by (revision, buildSeq). An executor holding plan (R, S)
 * drops any plan that is not strictly newer. `revision` is the project
 * revision the plan was built from; `buildSeq` increases with every build on
 * the device (a rebuild for a new media resolution or a new target keeps the
 * revision and bumps buildSeq). buildSeq is per JS/player session, not
 * persisted: it restarts with the app. So an executor resets its ordering when
 * a new player instance (or a new export) receives its first plan, and only
 * orders the plans that one instance receives.
 *
 * TIME AND FRAMES
 * - Seconds on the output timeline, from 0 to `duration`. A span [start, end)
 *   includes start and excludes end; that holds for overlays and captions too.
 *   (Legacy render.ts enables overlays with `between(t, start, end)`, which
 *   includes the end frame: one frame of intended divergence.)
 * - Output frames: count = ceil(duration * fps - 1e-6); frame k shows timeline
 *   t = k / fps, for k in [0, count). A plan with duration 0 has no frames:
 *   executors refuse to export it, and a preview shows only the background.
 * - Segment boundaries sit on the frame grid (multiples of 1 / fps), joins are
 *   exact (each start is bit-for-bit the previous end), and the last segment
 *   ends exactly at `duration`. The builder quantizes BOTH edges of every clip
 *   with one function, planFrameAt(t, fps) = floor(t * fps + 1e-6): a clip on
 *   [start, end) covers frames [planFrameAt(start), planFrameAt(end)). The
 *   duration uses the same rule: duration = planFrameAt(project end) / fps,
 *   at least one frame when the project has any length, so a clip ending on
 *   the project's end never leaves a trailing background frame (an off-grid
 *   end such as 12.345 s at 30 fps ends on frame 370, not 371). Legacy
 *   render.ts computes
 *   trunc(t / (1 / fps)), which lands one frame early on exact frame times
 *   (61/30 gives frame 60): an intended divergence. Where a quantized end
 *   would ask for source past the asset's end, the builder ends the playing
 *   segment there and covers the remainder with a `hold`, never with frames
 *   the asset does not have. Audio `at` keeps the exact, unquantized time, so
 *   a clip's sound may sit up to one frame off its picture, as in legacy.
 * - Sampling: a layer or timed overlay whose source time at t is s shows the
 *   latest source frame with presentation time <= s + 1e-6. Always, not only
 *   for holds.
 * - Keyframes (`*Keys`) carry absolute timeline seconds, are strictly
 *   increasing in `t`, interpolate linearly between neighbours, and hold the
 *   first/last value outside their range.
 *
 * SPACE
 * Output pixels of `size`, origin top-left, x right, y down. A preview drawn
 * at another size scales every coordinate by view.w / size.w (plans keep the
 * output aspect, so one factor serves both axes). Still images and image
 * layers are drawn upright per their EXIF orientation; the builder sizes boxes
 * from the upright dimensions.
 *
 * COLOUR (4A + OV6)
 * Hex colours are sRGB-encoded (BT.709 primaries, sRGB transfer). Compositing
 * happens in LINEAR LIGHT, extended-range BT.2020: every source (SDR, HLG, PQ)
 * and every graphic is converted into it before blending, and opacity,
 * crossfades and dims are applied there. This deliberately changes the look
 * against legacy render.ts, whose ffmpeg fades blend gamma-encoded values: a
 * linear-light crossfade or dip stays brighter through the middle. P6 parity
 * goldens must expect that change rather than match legacy pixels. Graphics
 * (overlays, emoji, callouts, captions, the background) are placed at the
 * BT.2408 reference white of 203 nits: sRGB white is 203 cd/m2 in an HLG
 * master and plain 100% white in an SDR one. The composite is then encoded to
 * `color`.
 *
 * SDR video transfer: video tagged BT.709, BT.601/170M, gamma-tagged or
 * unspecified decodes as v = e^1.961 and an `sdr` master encodes as
 * e = v^(1/1.961) (Core Video's convention); sRGB-tagged sources and every
 * hex colour use IEC 61966-2-1. Changing this curve is a `requires` feature.
 *
 * Working-space scale: linear 1.0 is the 203-nit reference white (an HLG
 * signal of 0.75, PQ at 203 cd/m2, sRGB and BT.709 white all decode to 1.0;
 * the HLG nominal peak of 1000 cd/m2 is 1000 / 203 = 4.926).
 *
 * SDR TONE CURVE. In an `sdr` plan, every HDR source (HLG or PQ transfer) is
 * tone mapped BEFORE blending, per channel, on its linear BT.2020 values at
 * that scale, with knee k = 0.8:
 *   y = v                                    for v <= k
 *   y = k + (1 - k) * e / ((1 - k) + e)      for v > k, where e = v - k
 * a Reinhard shoulder approaching 1.0: reference white (1.0) lands at 0.9 and
 * the HLG peak (4.926) at 0.99. SDR sources and graphics are never tone
 * mapped. This is the device curve (EditifyCompositor.sdrCurve); the server
 * uses ffmpeg tonemap=hable with npl=100 today and must adopt this curve in
 * P6. Changing the curve later is a `requires` feature, since an older
 * executor would draw the old one.
 *
 * HLG OUTPUT. An `hlg` plan encodes the working space to BT.2100 HLG (1.0 to
 * signal 0.75). Values above the HLG peak (4.926 linear, for example from a
 * brighter PQ source) clip per channel at 4.926.
 *
 * DRAW ORDER, bottom to top: `background`, the current segment's video layers
 * by ascending `z`, the overlays on screen by ascending `z`, the captions on
 * screen by ascending `lane`. Video layers always sit below overlays, and
 * overlays below captions, whatever their numbers.
 *
 * MEDIA
 * An `assetRef` names a source, never a location. The device's media ladder
 * (local original, proxy, server copy) resolves it; the plan does not. GIF
 * frame delays under 2 cs play as 10 cs, as browsers and ffmpeg do.
 * B-roll overlays are picture only; the v1 builder gives them no sound (legacy
 * parity: render.ts maps no b-roll audio).
 * SECURITY: a plan is untrusted input. Any executor or server route resolves
 * every `assetRef.id` and `raster.id` ONLY within the requesting user's own
 * assets (the same scoping as the asset routes), never by bare id, or a plan
 * becomes a way to read someone else's media (IDOR).
 *
 * LIMITS
 * Every string, array and size is capped (PLAN_LIMITS) so a hostile plan
 * cannot make a server parse or render unbounded work. The caps sit well
 * above anything the builder emits for a real edit. The builder never
 * degrades content to fit them: a project over a count cap fails to build
 * with a RenderPlanBuildError a person can read ("10,100 stickers; the limit
 * is 10,000"), and only an overflowing caption shrinks (see fitted). Native
 * enforces the same caps on every plan it receives, since a preview may be
 * built with selfCheck: false and skip this schema.
 *
 * WHAT THE PLAN OWNS
 * The plan's size, fps, colour and loudness win. exportProject() options
 * carry only encoder knobs (bitrate, codec profile, keyframe interval), never
 * a second size, colour or loudness.
 *
 * BUILDER OBLIGATIONS (checked here where the schema can)
 * - Captions whose lane trimming leaves end <= start are dropped.
 * - The 8 ms edge declick is min(0.008, entry length / 2), so a very short
 *   entry still validates.
 * - B-roll: srcStart = clip.in, speed = clip.speed, loop false. GIFs: loop
 *   true, srcStart 0, speed 1. (Legacy opens every overlay with
 *   `-stream_loop -1` and no trim, so its b-roll shows source time t at
 *   timeline t; that is a bug the plan fixes, an intended P6 divergence.)
 * - One clip may produce several audio entries (a clip split by a hold, a
 *   looped bed): entry ids are unique, `clipId` repeats.
 * - Content never makes the builder throw: a caption too big for the caps
 *   shrinks further and says so in `fitted.overflow`, and a word longer than
 *   PLAN_LIMITS.textChars is hard-broken across lines.
 */

/** Plans whose `version` differs are refused outright: there is no migration between versions. */
export const RENDER_PLAN_VERSION = 1;

/**
 * Critical features this schema knows beyond v1. Empty: a v1 plan requires
 * nothing. A new feature is added here together with its fields.
 */
export const RENDER_PLAN_FEATURES: readonly string[] = [];

/** Float slack for comparing builder-computed times (key bounds, frame grid). */
export const RENDER_PLAN_EPSILON = 1e-6;

/**
 * Hard caps on a plan. Generous on purpose: they bound hostile input, not
 * real edits. There is no project-level duration cap in the document today,
 * so `durationSec` is the plan's own ceiling (4 hours).
 */
export const PLAN_LIMITS = {
  /** Longest side in pixels (4K UHD). */
  longSidePx: 3840,
  /** Shorter side in pixels: 3840 x 2160 either way round, never 3840 x 3840. */
  shortSidePx: 2160,
  durationSec: 4 * 60 * 60,
  /** Any one piece of text: a caption line, a word, a label, an emoji run. */
  textChars: 500,
  /** Ids, revs, feature names. */
  idChars: 128,
  requires: 32,
  segments: 20_000,
  layersPerSegment: 32,
  /** Per key array: a per-frame zoom sample over a 10-minute clip at 60 fps fits. */
  keys: 50_000,
  overlays: 10_000,
  captions: 10_000,
  linesPerCaption: 12,
  wordsPerLine: 200,
  audio: 10_000,
} as const;

const id = z.string().min(1).max(PLAN_LIMITS.idChars);
const text = z.string().min(1).max(PLAN_LIMITS.textChars);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #RRGGBB colour');
const hexColorWithAlpha = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, 'expected a #RRGGBB or #RRGGBBAA colour');
const seconds = z.number().finite().min(0);
const pixels = z.number().finite();
const size = z.number().finite().positive();
/** Same range as a clip's `speed`. Never zero or negative: reverse playback is not a v1 feature. */
const speedSchema = z.number().finite().min(0.1).max(8);
const unit = z.number().finite().min(0).max(1);

type UnknownKeys = 'strict' | 'strip';

/** Every schema twice from one definition: strict for builders and tests, stripping for executors. */
function planSchemas(mode: UnknownKeys) {
  const obj = <T extends z.ZodRawShape>(shape: T): z.ZodObject<T> =>
    (mode === 'strict' ? z.object(shape).strict() : z.object(shape)) as unknown as z.ZodObject<T>;

  const assetRef = obj({
    /** The document's `clip.assetId`. */
    id,
    kind: z.enum(['video', 'audio', 'image']),
  });

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
   *            preferred transform / rotation tag / EXIF orientation)
   *   c      = max(W / sw, H / sh) * scale        cover-fit, then zoom
   *   ox     = (sw * c - W) / 2 * (1 + x)         x = -1 left edge, 0 centred, 1 right edge
   *   oy     = (sh * c - H) / 2 * (1 + y)         y = -1 top edge,  0 centred, 1 bottom edge
   *
   * Output point (u, v) shows source point ((u + ox) / c, (v + oy) / c). The
   * visible source rect is origin (ox / c, oy / c), size (W / c, H / c). A
   * source point at normalized height n (0 top, 1 bottom) lands at screen
   * y = n * sh * c - oy.
   *
   * `scale` is at least 1 (render.ts treats anything below 1 as 1, and the
   * builder clamps). x/y pan across the overflow of the zoomed cover image, so
   * they move the picture even at scale 1 when the source aspect differs from
   * the frame's.
   *
   * Animated zooms: render.ts's zoompan branch (clips with `transformEnd`),
   * and the RN preview, pan inside the frame-shaped centre crop instead. For a
   * pose (z, px, py) in that convention the equivalent key here is
   *   x = px * (W - W / z) / (Cw - W / z),   Cw = sw * max(W / sw, H / sh)
   * (0 when the denominator is 0), and likewise for y with H, Ch. The two
   * agree whenever the source aspect equals the frame's, so a move is then two
   * keys; otherwise the builder samples the move once per output frame so that
   * linear interpolation here reproduces it.
   */
  const cropKey = obj({
    t: seconds,
    scale: z.number().finite().min(1).max(10),
    x: z.number().finite().min(-1).max(1),
    y: z.number().finite().min(-1).max(1),
  });

  /** A 0..1 value at timeline second `t`, for opacity and dim ramps. */
  const unitKey = obj({ t: seconds, value: unit });

  /**
   * One video clip's picture inside a segment.
   *
   * Source time at timeline t is `srcStart + (t - segment.start) * speed`. A
   * clip that spans several segments appears in each, with `srcStart`
   * continuing where the previous segment left off; the executor never
   * carries state between segments.
   */
  const videoLayer = obj({
    /** The document clip this layer draws: for selection handles and diagnostics, never for timing. */
    clipId: id,
    /** Index of the clip's track among the project's video tracks, in document order (0 = first). */
    trackIndex: z.number().int().min(0),
    /**
     * Stacking within the segment: higher draws on top. Unique per segment.
     * Later video tracks sit above earlier ones; inside a crossfade the
     * incoming clip sits above the outgoing one.
     */
    z: z.number().int(),
    /** `video`, or `image` for a still on a video track (it ignores srcStart and speed). */
    assetRef,
    /** Source seconds shown at `segment.start`. */
    srcStart: seconds,
    speed: speedSchema,
    /** At least one key. One key is a static pose. */
    cropKeys: z.array(cropKey).min(1).max(PLAN_LIMITS.keys),
    /**
     * Layer alpha, multiplied in (in linear light) before the layer is
     * composited over what is below it: a crossfade fades the incoming layer
     * from 0 to 1 over the outgoing one. Empty means fully opaque.
     */
    opacityKeys: z.array(unitKey).max(PLAN_LIMITS.keys),
    /**
     * Fade toward black while staying opaque, as ffmpeg's `fade` without
     * alpha but in linear light: pixel = source * (1 - value). A dip to black
     * ramps the outgoing layer 0 to 1 and the incoming one 1 to 0. Empty means
     * no dimming.
     */
    dimKeys: z.array(unitKey).max(PLAN_LIMITS.keys),
    /**
     * Freeze-frame: the layer shows the single source frame sampled at
     * `frameAt` (source seconds, by the sampling rule) for the whole segment,
     * and `srcStart`/`speed` do not move the picture. Used where a crossfade
     * outlasts the outgoing clip's source handles (transitions.ts
     * `holdLastFrameFor`).
     */
    hold: obj({ frameAt: seconds }).optional(),
  });

  /**
   * A span of the timeline where the set of video layers is constant: one
   * AVVideoCompositionInstruction on the device. Segments tile [0, duration]
   * on the frame grid with exact joins; a stretch with no picture is a segment
   * with no layers (the background shows).
   */
  const videoSegment = obj({
    start: seconds,
    end: seconds,
    /** N layers, any number of video tracks overlapping. */
    layers: z.array(videoLayer).max(PLAN_LIMITS.layersPerSegment),
  }).superRefine((segment, ctx) => {
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
        ['dimKeys', layer.dimKeys],
      ];
      for (const [name, keys] of keyed) {
        checkKeys(keys, segment.start, segment.end, 'segment', ctx, ['layers', index, name]);
      }
    });
  });

  /**
   * An overlay's rectangle, in output pixels.
   * Anchor: (x, y) is the CENTRE of the rectangle, not its top-left corner.
   * w and h are the unrotated size; the rectangle turns `rotationDeg` degrees
   * clockwise about its centre. Matches the document's overlay placement
   * (x/y centre fractions, clockwise rotation) and render.ts's `x - w/2`.
   *
   * Payload geometry (callout, emoji) is in BOX-LOCAL pixels: origin at the
   * top-left of the unrotated box, x right, y down, drawn before the box's
   * rotation is applied.
   */
  const overlayBox = obj({
    x: pixels,
    y: pixels,
    w: size,
    h: size,
    rotationDeg: z.number().finite().min(-180).max(180),
  });

  /**
   * Timed media inside an overlay. Source time at timeline t is
   * `srcStart + (t - overlay.start) * speed`; with `loop` it wraps modulo the
   * media's duration (GIFs), without it the last frame holds once the source
   * runs out. A still image ignores all three. B-roll overlays are picture
   * only; the v1 builder gives them no sound (legacy parity).
   */
  const overlayMedia = obj({
    assetRef,
    srcStart: seconds,
    speed: speedSchema,
    loop: z.boolean().optional(),
  });

  const rect = { x: pixels, y: pixels, w: size, h: size };

  /**
   * A callout card resolved to primitives, box-local, drawn in this order:
   * 1. `card`: a rounded rect, corner radius `radiusPx`, filled with `color`
   *    (may carry alpha).
   * 2. `glyph` (check and x variants only): a vector shape, never a font
   *    glyph, stroked with `strokePx`, round caps and round joins, in `color`,
   *    through points given as fractions of its rect:
   *      check: polyline (0.05, 0.55) (0.38, 0.88) (0.95, 0.12)
   *      cross: segments (0.12, 0.12)-(0.88, 0.88) and (0.88, 0.12)-(0.12, 0.88)
   * 3. `label`: one line of text in a bundled face, pen at (x, y) where y is
   *    the BASELINE, kerning on, ligatures off, never re-wrapped.
   * The look follows server/src/media/callout.ts, except the label face: the
   * plan draws a bundled face where legacy used the system bold (intended).
   */
  const callout = obj({
    variant: calloutSchema.shape.variant,
    card: obj({ ...rect, radiusPx: z.number().finite().min(0), color: hexColorWithAlpha }),
    glyph: obj({ shape: z.enum(['check', 'cross']), ...rect, strokePx: size, color: hexColor }).optional(),
    label: obj({
      text,
      font: planFontFaceSchema,
      sizePx: size,
      x: pixels,
      y: pixels,
      width: z.number().finite().min(0),
      color: hexColor,
    }),
  }).superRefine((card, ctx) => {
    const want = card.variant === 'check' ? 'check' : card.variant === 'x' ? 'cross' : undefined;
    if ((card.glyph?.shape) !== want) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: want ? `a ${card.variant} callout draws the ${want} glyph` : 'a card callout has no glyph',
        path: ['glyph'],
      });
    }
  });

  /**
   * Emoji sticker text, box-local: set on one line in Apple Color Emoji at
   * `sizePx` with its pen at (x, y), y the BASELINE. The builder fits it: one
   * uniform scale so the run's advance width fits the box width and its
   * ascent + descent fit the box height, centred both ways. Executors without
   * Apple Color Emoji draw the overlay's `raster` instead.
   */
  const emoji = obj({
    text,
    sizePx: size,
    x: pixels,
    y: pixels,
    width: z.number().finite().min(0),
  });

  /**
   * Anything drawn over the video and under the captions.
   *
   * - `image`, `gif`, `broll`: `media` is stretched to fill the box exactly (the
   *   builder sizes h from the media's upright aspect, as render.ts's
   *   `scale=w:-2`). image/gif take an `image` asset, broll a `video` asset.
   * - `emoji`: the `emoji` payload.
   * - `callout`: the `callout` payload.
   * - `raster` (emoji and callout only): an uploaded PNG of the finished box
   *   content, stretched to the box, for an executor that cannot draw the
   *   payload (no Apple Color Emoji on Linux). It must show the same pixels.
   *   The v1 builder never emits one. When a server executor needs it, the
   *   device draws it with its own OverlayGraphics (the same code that draws
   *   the payload on the phone) and uploads it with the render snapshot (T8),
   *   so the server's output matches the device's.
   */
  const overlay = obj({
    /** The document clip id. */
    id,
    kind: z.enum(['image', 'gif', 'emoji', 'callout', 'broll']),
    /** Stacking among overlays: higher draws on top. Unique across the plan. */
    z: z.number().int(),
    start: seconds,
    end: seconds,
    box: overlayBox,
    media: overlayMedia.optional(),
    emoji: emoji.optional(),
    callout: callout.optional(),
    raster: assetRef.optional(),
  }).superRefine((item, ctx) => {
    if (!(item.end > item.start)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `overlay end ${item.end} must be after its start ${item.start}`, path: ['end'] });
    }
    const mediaKind = { image: 'image', gif: 'image', broll: 'video', emoji: undefined, callout: undefined }[item.kind];
    if (mediaKind && !item.media) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${item.kind} overlay needs media`, path: ['media'] });
    } else if (mediaKind && item.media && item.media.assetRef.kind !== mediaKind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${item.kind} overlay needs a ${mediaKind} asset, not ${item.media.assetRef.kind}`, path: ['media', 'assetRef', 'kind'] });
    } else if (!mediaKind && item.media) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${item.kind} overlay carries no media`, path: ['media'] });
    }
    for (const payload of ['emoji', 'callout'] as const) {
      const wanted = item.kind === payload;
      if (wanted !== (item[payload] !== undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: wanted ? `a ${payload} overlay needs its ${payload} payload` : `a ${item.kind} overlay carries no ${payload} payload`,
          path: [payload],
        });
      }
    }
    if (item.raster && (mediaKind || item.raster.kind !== 'image')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: mediaKind ? `a ${item.kind} overlay has no raster; its media is the picture` : 'a raster is an image asset',
        path: ['raster'],
      });
    }
  });

  /**
   * A karaoke word. `s`/`e` are ABSOLUTE timeline seconds, inside the
   * caption's [start, end]. The document stores `captionStyle.words` relative
   * to the first word instead: renderers light word i at
   * `clip.start + (words[i].s - words[0].s)` (libass starts the `\k` clock at
   * the event start). The builder converts:
   *   s = clip.start + (word.s - words[0].s),  e = clip.start + (word.e - words[0].s)
   * then clamps both into the caption's (possibly lane-trimmed) span.
   *
   * A word is drawn in `emphasisColor` from `s` onward and in `color` before
   * it (ASS `\k`: an instant switch, not a sweep). `e` is kept for word-level
   * animation and the ASS durations; v1 executors do not draw with it.
   */
  const captionWord = obj({
    w: text,
    s: seconds,
    e: seconds,
    /** Pen x where the word starts, in output pixels (same space as the line's x). */
    x: pixels,
  });

  /**
   * One laid-out line, positioned by the shared caption layout (kern pairs
   * from the font tables, emoji widths from a table, OV7). The executor draws
   * `text` starting at pen position (x, y) with the font's kerning on and
   * ligatures off, and never re-wraps or re-centres it.
   *
   * Vertical metrics are the face's OS/2 winAscent and winDescent, as libass
   * uses them. Lines sit one CELL apart, cell = sizePx x (winAscent +
   * winDescent) / unitsPerEm, and a line's cell spans [y - winAscent x sizePx
   * / unitsPerEm, y + winDescent x sizePx / unitsPerEm]. Do not bound a line
   * with CTFontGetAscent/Descent: those are the hhea values (0.968 / 0.251 em
   * for Montserrat-Bold) and glyphs reach winAscent (1.109 em). Size a
   * caption bitmap from the cells plus stroke and shadow, or from the glyph
   * path bounds.
   */
  const captionLine = obj({
    text,
    /** Pen x of the first glyph (left edge of the advance box), output pixels. */
    x: pixels,
    /** The BASELINE, in output pixels from the top: not the line's top or centre. */
    y: pixels,
    /** Advance width of the whole line in pixels; with x it gives the line's horizontal extent. */
    width: z.number().finite().min(0),
    /**
     * Karaoke only. When present the line is drawn word by word, each word at
     * its own `x`, and the words joined by single spaces equal `text`. A line
     * the face cannot place word by word (right-to-left or fallback text) has
     * exactly one word, the whole line (see caption.fitted.approximate).
     *
     * ASS (P6 server writer): one Dialogue per line, `\an7\pos(x, y -
     * winAscent x sizePx / unitsPerEm)` (top-left of the line's cell), `\fs`
     * as in caption.sizePx, karaoke `\k` from these word times. Two accepted
     * differences: libass always applies ligatures (about 0.4 px per ligature
     * at 100 px), and captions containing colour emoji have no exact server
     * path in v1 (Linux libass has no colour emoji).
     */
    words: z.array(captionWord).min(1).max(PLAN_LIMITS.wordsPerLine).optional(),
  });

  const caption = obj({
    /** The document clip id. */
    id,
    /**
     * Content + style revision: a stable hash of everything that changes the
     * caption's pixels (text, words, style, layout). The CaptionRenderer's
     * cache key is (id, rev, sung-word count, scale), so any visible change
     * must change `rev` (OV10).
     */
    rev: id,
    /**
     * Timeline span, after lane overlap trimming (ass.ts: a lane's previous
     * caption ends where the next starts). The builder drops a caption that
     * trimming leaves empty.
     */
    start: seconds,
    end: seconds,
    /**
     * Vertical lane (one per distinct anchor: top, centre, bottom, each custom
     * anchorPct). Captions in one lane never overlap in time; captions in
     * different lanes may, and draw in ascending lane order.
     */
    lane: z.number().int().min(0),
    /** The bundled face: captionFaceFor(captionStyle.font). */
    font: planFontFaceSchema,
    /**
     * The Core Text font size in output pixels (CTFont size = sizePx), after
     * any shrink-to-fit. Emoji fall back to Apple Color Emoji at the same
     * size and advance exactly 1 em. This is NOT the ASS Fontsize, which
     * libass treats as the cell height: sizePx = Fontsize x unitsPerEm /
     * (winAscent + winDescent) x fitted.scale (1000 / 1562 for
     * Montserrat-Bold), and an ASS writer sets \fs = sizePx x (winAscent +
     * winDescent) / unitsPerEm.
     */
    sizePx: size,
    color: hexColor,
    /**
     * Outline around every glyph, drawn under the fill: a Core Graphics stroke
     * of the glyph outlines with line width 2 x strokePx (so it reaches
     * strokePx outside the glyph) and ROUND joins (libass outlines are round).
     *
     * Emoji in a caption are colour glyphs: they are never stroked and never
     * recoloured by `color` or `emphasisColor`; their shadow is their own
     * alpha silhouette.
     */
    strokeColor: hexColor,
    strokePx: z.number().finite().min(0),
    /** Sung karaoke words. Unused by captions without words. */
    emphasisColor: hexColor,
    /**
     * Drop shadow of the outlined text (libass `Shadow`: the glyphs plus
     * outline, offset offsetPx right and down, in `color` at `opacity`).
     * Absent means none.
     */
    shadow: obj({ color: hexColor, opacity: unit, offsetPx: z.number().finite().min(0) }).optional(),
    /**
     * A rounded backing box behind each line, like libass BorderStyle 3: the
     * line's cell (see captionLine: OS/2 winAscent / winDescent) horizontally
     * [x - padPx, x + width + padPx] and vertically grown by padPx. The
     * boxes of one caption are filled as ONE union at `opacity`, so where two
     * lines' boxes overlap the colour does not double. (libass fills per line,
     * so a P6 ASS writer doubles the overlap: an accepted difference.) Absent
     * means no box; the v1 builder emits none, since the document style has
     * no box.
     */
    box: obj({
      color: hexColor,
      opacity: unit,
      padPx: z.number().finite().min(0),
      radiusPx: z.number().finite().min(0),
    }).optional(),
    /**
     * How the layout aligned the lines. Lines already carry their x, so a
     * drawing executor ignores this; the ASS writer uses it for `\an`.
     */
    align: z.enum(['left', 'center', 'right']),
    lines: z.array(captionLine).min(1).max(PLAN_LIMITS.linesPerCaption),
    /**
     * Overflow receipt (OV7): the caption did not fit at its styled size, so
     * the layout shrank it by `scale` (sizePx already includes it). Never an
     * ellipsis. `shrunk: false` always has scale 1.
     * - `overflow: true`: even shrunk to the smallest normal step (0.25) it
     *   did not fit three lines, so it shrank to the largest scale that fits
     *   the PLAN_LIMITS caps (12 lines, 500 characters, 200 words a line),
     *   never below 0.15, and words longer than PLAN_LIMITS.textChars were
     *   hard-broken. Lines past 12 at 0.15 are the only text ever dropped.
     * - `approximate: true`: some text is in a script the bundled face does
     *   not cover (Greek, Thai, Hebrew, Arabic, CJK...). Core Text draws it in
     *   a system fallback face, and the layout measured it with a fallback
     *   width per script (1 em Han, Kana and Hangul; 0.68 em Greek; 0.43 em
     *   Arabic; 0.6 em otherwise), so its widths and wrap points are
     *   estimates. In karaoke, a line containing such text, or any
     *   right-to-left text, is ONE word: { w: the line's text, x: the line's
     *   x, s: its first word's start, e: its last word's end }. Core Text
     *   draws it as a single run with bidi, and it lights as a whole; lines
     *   in the face keep word-by-word lighting.
     * The builder omits both rather than writing false.
     */
    fitted: obj({
      shrunk: z.boolean(),
      scale: z.number().finite().positive().max(1),
      overflow: z.boolean().optional(),
      approximate: z.boolean().optional(),
    }),
  }).superRefine((item, ctx) => {
    if (!(item.end > item.start)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `caption end ${item.end} must be after its start ${item.start}`, path: ['end'] });
    }
    if (item.fitted.shrunk !== item.fitted.scale < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: item.fitted.shrunk ? 'a shrunk caption has a scale below 1' : 'an unshrunk caption has scale 1',
        path: ['fitted', 'scale'],
      });
    }
    const karaokeLines = item.lines.filter((line) => line.words).length;
    if (karaokeLines > 0 && karaokeLines < item.lines.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'either every line of a caption has words or none does', path: ['lines'] });
    }
    const inside = (time: number): boolean => time >= item.start - RENDER_PLAN_EPSILON && time <= item.end + RENDER_PLAN_EPSILON;
    let previousStart = -Infinity;
    item.lines.forEach((line, lineIndex) => {
      if (!line.words) return;
      if (line.words.map((word) => word.w).join(' ') !== line.text) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the line\'s words joined by spaces must equal its text', path: ['lines', lineIndex, 'words'] });
      }
      line.words.forEach((word, wordIndex) => {
        const path = ['lines', lineIndex, 'words', wordIndex];
        if (!inside(word.s) || !inside(word.e)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `word "${word.w}" [${word.s}, ${word.e}] is outside the caption's time [${item.start}, ${item.end}]; word times are absolute timeline seconds`,
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

  /**
   * Edge fade on an audio entry. `linear` is ffmpeg's `tri` (the crossfade
   * and dip ramps, which sum back to unity across a crossfade); `halfSine` is
   * ffmpeg's `hsin`, gain (1 - cos(pi * p)) / 2 (the 8 ms declick on plain
   * cuts). A fade-in starts at `at`; a fade-out ends at the entry's end. The
   * two may overlap on a short entry; their gains multiply.
   */
  const audioFade = obj({ duration: seconds, curve: z.enum(['linear', 'halfSine']) });

  /**
   * One stretch of sound: a video clip's own track, an audio clip, b-roll
   * sound. Plays source [in, out) of the asset's first audio track,
   * time-stretched by `speed` with pitch preserved (atempo / spectral),
   * starting at timeline `at` and ending at `at + (out - in) / speed`.
   *
   * Gain at t = gainKeys(t) x fadeIn(t) x fadeOut(t), linear amplitude.
   * gainKeys carry the clip volume and the duck ramps (duck.ts: 0.3 floor,
   * 0.12 s linear ramps) and nothing else; transition ramps (crossfade, dip)
   * and the declick live only in fadeIn/fadeOut.
   *
   * Output audio is stereo at 48 kHz. A mono source plays at unity gain in
   * both channels; a source with more than two channels is downmixed per
   * ITU-R BS.775 (L = L + 0.7071 C + 0.7071 Ls, R = R + 0.7071 C + 0.7071 Rs,
   * LFE dropped). Entries are then summed with no normalization (amix
   * normalize=0), and the master goes through `loudness`.
   */
  const audioEntry = obj({
    /** Unique among audio entries. */
    id,
    /** The document clip this sound comes from; one clip may give several entries. */
    clipId: id,
    /** A `video` asset (its own sound) or an `audio` asset. */
    assetRef,
    at: seconds,
    in: seconds,
    out: seconds,
    speed: speedSchema,
    /**
     * Linear amplitude keys, absolute timeline seconds inside the entry's
     * span. At least one. At most 1: the document volume is 0 to 1 and
     * AVAudioMix cannot amplify; loudness gain happens on the master.
     */
    gainKeys: z.array(obj({ t: seconds, gain: z.number().finite().min(0).max(1) })).min(1).max(PLAN_LIMITS.keys),
    fadeIn: audioFade,
    fadeOut: audioFade,
  }).superRefine((entry, ctx) => {
    if (entry.assetRef.kind === 'image') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an audio entry needs a video or audio asset', path: ['assetRef', 'kind'] });
    }
    if (!(entry.out > entry.in)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `audio out ${entry.out} must be after its in ${entry.in}`, path: ['out'] });
      return;
    }
    if (!(entry.speed > 0)) return;
    const end = audioEntryEnd(entry);
    checkKeys(entry.gainKeys, entry.at, end, 'audio entry', ctx, ['gainKeys']);
    const length = end - entry.at;
    for (const name of ['fadeIn', 'fadeOut'] as const) {
      if (entry[name].duration > length + RENDER_PLAN_EPSILON) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} ${entry[name].duration}s is longer than the entry (${length}s)`, path: [name, 'duration'] });
      }
    }
  });

  /**
   * Master loudness (8A). The gain rule is server/src/services/render-qa.ts's;
   * the limiter is always on. With `targetLufs` set:
   * 1. Measure the mix's integrated loudness I (EBU R128).
   * 2. Gain: none when I <= silentBelowLufs (nothing to normalize) or
   *    |I - targetLufs| <= deadbandLu (close enough); otherwise one gain of
   *    (targetLufs - I) dB, rounded to 0.1 dB.
   * 3. Limiter: always, whether or not step 2 applied gain, a look-ahead peak
   *    limiter at limiterCeilingDb (video delayed to match its latency on the
   *    device). Legacy render-qa.ts limits only when it applies gain, so an
   *    in-deadband master with hot peaks now gets limited: intended.
   * `truePeakLimitDb` is the acceptance limit for the finished file's true
   * peak (a QA warning above it, a test failure in CI), not a processing
   * setting: the ceiling sits under it for inter-sample headroom.
   * `targetLufs: null` turns all of it off: no gain, no limiter.
   */
  const loudness = obj({
    targetLufs: z.number().finite().max(0).nullable(),
    deadbandLu: z.number().finite().min(0),
    silentBelowLufs: z.number().finite().max(0),
    limiterCeilingDb: z.number().finite().max(0),
    truePeakLimitDb: z.number().finite().max(0),
  }).superRefine((value, ctx) => {
    if (value.limiterCeilingDb > value.truePeakLimitDb) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the limiter ceiling must sit at or under the true-peak limit', path: ['limiterCeilingDb'] });
    }
  });

  const plan = obj({
    version: z.literal(RENDER_PLAN_VERSION),
    /** Critical features beyond v1 that the executor must support (see SCHEMA EVOLUTION). Empty in v1. */
    requires: z.array(id).max(PLAN_LIMITS.requires),
    /** The project revision this plan was built from (OV10, OV1 snapshot key). */
    revision: z.number().int().min(0),
    /** Monotonic build counter for this JS/player session: plans order by (revision, buildSeq). */
    buildSeq: z.number().int().min(0),
    /** Output frame in pixels: at most PLAN_LIMITS.longSidePx by PLAN_LIMITS.shortSidePx, either orientation. */
    size: obj({
      w: z.number().int().positive().multipleOf(2).max(PLAN_LIMITS.longSidePx),
      h: z.number().int().positive().multipleOf(2).max(PLAN_LIMITS.longSidePx),
    }).refine((frame) => Math.min(frame.w, frame.h) <= PLAN_LIMITS.shortSidePx, {
      message: `the shorter side must be at most ${PLAN_LIMITS.shortSidePx} px`,
    }),
    fps: z.number().int().min(1).max(120),
    /** Output length in seconds, a whole number of frames. 0 only for a plan with nothing on it. */
    duration: seconds.max(PLAN_LIMITS.durationSec),
    /**
     * Output encoding (4A + OV6). `sdr`: BT.709 SDR, H.264 High 8-bit; HDR
     * sources are tone mapped. `hlg`: BT.2020 HLG, HEVC Main10. Compositing
     * is linear extended BT.2020 either way.
     */
    color: z.enum(['sdr', 'hlg']),
    /** Fills the frame under every layer (render.ts BASE_COLOR #0B0B0F). */
    background: hexColor,
    loudness,
    video: obj({ segments: z.array(videoSegment).max(PLAN_LIMITS.segments) }),
    overlays: z.array(overlay).max(PLAN_LIMITS.overlays),
    captions: z.array(caption).max(PLAN_LIMITS.captions),
    audio: z.array(audioEntry).max(PLAN_LIMITS.audio),
  }).superRefine((value, ctx) => {
    const { duration, fps } = value;
    const within = (end: number): boolean => end <= duration + RENDER_PLAN_EPSILON;

    if (mode === 'strict') {
      value.requires.forEach((feature, index) => {
        if (!RENDER_PLAN_FEATURES.includes(feature)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown required feature "${feature}"`, path: ['requires', index] });
        }
      });
    }

    const onGrid = (time: number): boolean => Math.abs(time * fps - Math.round(time * fps)) <= RENDER_PLAN_EPSILON;
    const segments = value.video.segments;
    if (duration === 0 && segments.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a plan with duration 0 has no segments', path: ['video', 'segments'] });
    }
    if (duration > 0 && segments.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `segments must cover [0, ${duration}]; use a segment with no layers for an empty stretch`, path: ['video', 'segments'] });
    }
    let cursor = 0;
    segments.forEach((segment, index) => {
      if (segment.start !== cursor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: index === 0
            ? `the first segment must start at 0, not ${segment.start}`
            : `segment ${index} starts at ${segment.start} but the previous one ends at ${cursor}; joins must be exact`,
          path: ['video', 'segments', index, 'start'],
        });
      }
      if (!onGrid(segment.end)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `segment end ${segment.end} is not on the 1/${fps} s frame grid`, path: ['video', 'segments', index, 'end'] });
      }
      cursor = segment.end;
    });
    if (segments.length > 0 && cursor !== duration) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `the last segment ends at ${cursor}, not at duration ${duration}`, path: ['video', 'segments', segments.length - 1, 'end'] });
    }

    const overlayZ = new Map<number, number>();
    value.overlays.forEach((item, index) => {
      if (!within(item.end)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `overlay ends at ${item.end}, past duration ${duration}`, path: ['overlays', index, 'end'] });
      }
      const other = overlayZ.get(item.z);
      if (other !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `overlays ${other} and ${index} share z ${item.z}; stacking order must be explicit`, path: ['overlays', index, 'z'] });
      } else {
        overlayZ.set(item.z, index);
      }
    });
    checkUniqueIds(value.overlays, ctx, 'overlays');

    value.captions.forEach((item, index) => {
      if (!within(item.end)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `caption ends at ${item.end}, past duration ${duration}`, path: ['captions', index, 'end'] });
      }
    });
    checkUniqueIds(value.captions, ctx, 'captions');
    const byLane = new Map<number, number[]>();
    value.captions.forEach((item, index) => {
      const lane = byLane.get(item.lane);
      if (lane) lane.push(index);
      else byLane.set(item.lane, [index]);
    });
    for (const indexes of byLane.values()) {
      const ordered = [...indexes].sort((left, right) => value.captions[left]!.start - value.captions[right]!.start);
      for (let at = 1; at < ordered.length; at += 1) {
        const previous = value.captions[ordered[at - 1]!]!;
        const current = value.captions[ordered[at]!]!;
        if (previous.end > current.start + RENDER_PLAN_EPSILON) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `captions ${previous.id} and ${current.id} overlap in lane ${current.lane}; a lane shows one caption at a time`,
            path: ['captions', ordered[at]!, 'start'],
          });
        }
      }
    }

    value.audio.forEach((entry, index) => {
      // A bad span or speed is already reported on the entry itself.
      if (entry.out > entry.in && entry.speed > 0 && !within(audioEntryEnd(entry))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `audio entry ends at ${audioEntryEnd(entry)}, past duration ${duration}`, path: ['audio', index] });
      }
    });
    checkUniqueIds(value.audio, ctx, 'audio');
  });

  return {
    assetRef, cropKey, unitKey, videoLayer, videoSegment, overlayBox, overlayMedia, callout, emoji, overlay,
    captionWord, captionLine, caption, audioFade, audioEntry, loudness, plan,
  };
}

const strict = planSchemas('strict');
const lenient = planSchemas('strip');

/** Strict: unknown keys and unknown required features fail. For the builder's self-check and tests. */
export const renderPlanSchema = strict.plan;
/**
 * The stripping parse behind parseRenderPlanForExecutor. Unchecked: it does
 * not look at `requires`, so executors call parseRenderPlanForExecutor, never
 * this directly.
 */
export const renderPlanExecutorSchemaUnchecked = lenient.plan;

export const planAssetRefSchema = strict.assetRef;
export const planCropKeySchema = strict.cropKey;
export const planUnitKeySchema = strict.unitKey;
export const planVideoLayerSchema = strict.videoLayer;
export const planVideoSegmentSchema = strict.videoSegment;
export const planOverlayBoxSchema = strict.overlayBox;
export const planOverlayMediaSchema = strict.overlayMedia;
export const planCalloutSchema = strict.callout;
export const planEmojiSchema = strict.emoji;
export const planOverlaySchema = strict.overlay;
export const planCaptionWordSchema = strict.captionWord;
export const planCaptionLineSchema = strict.captionLine;
export const planCaptionSchema = strict.caption;
export const planAudioFadeSchema = strict.audioFade;
export const planAudioEntrySchema = strict.audioEntry;
export const planLoudnessSchema = strict.loudness;

export type RenderPlan = z.infer<typeof renderPlanSchema>;
export type PlanAssetRef = z.infer<typeof planAssetRefSchema>;
export type PlanCropKey = z.infer<typeof planCropKeySchema>;
export type PlanUnitKey = z.infer<typeof planUnitKeySchema>;
export type PlanVideoLayer = z.infer<typeof planVideoLayerSchema>;
export type PlanVideoSegment = z.infer<typeof planVideoSegmentSchema>;
export type PlanOverlayBox = z.infer<typeof planOverlayBoxSchema>;
export type PlanOverlayMedia = z.infer<typeof planOverlayMediaSchema>;
export type PlanCallout = z.infer<typeof planCalloutSchema>;
export type PlanEmoji = z.infer<typeof planEmojiSchema>;
export type PlanOverlay = z.infer<typeof planOverlaySchema>;
export type PlanCaptionWord = z.infer<typeof planCaptionWordSchema>;
export type PlanCaptionLine = z.infer<typeof planCaptionLineSchema>;
export type PlanCaption = z.infer<typeof planCaptionSchema>;
export type PlanAudioFade = z.infer<typeof planAudioFadeSchema>;
export type PlanAudioEntry = z.infer<typeof planAudioEntrySchema>;
export type PlanLoudness = z.infer<typeof planLoudnessSchema>;

/** Thrown when a plan needs a feature this executor does not draw. */
export class UnsupportedPlanError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    // Bounded: the names come from untrusted input and end up in logs and responses.
    const shown = missing.slice(0, 5).map((feature) => (feature.length > 64 ? `${feature.slice(0, 64)}...` : feature));
    const more = missing.length > shown.length ? ` and ${missing.length - shown.length} more` : '';
    super(`This renderer cannot draw a plan that requires: ${shown.join(', ')}${more}`);
    this.missing = missing.slice(0, PLAN_LIMITS.requires);
    this.name = 'UnsupportedPlanError';
  }
}

/**
 * How a TS executor (the server render, P6) reads a plan: refuse unsupported
 * `requires` first, so a plan using a newer enum value fails with the feature
 * name rather than a parse error, then parse ignoring unknown keys.
 */
export function parseRenderPlanForExecutor(input: unknown, supported: readonly string[] = RENDER_PLAN_FEATURES): RenderPlan {
  const head = z.object({ requires: z.array(z.string()).max(PLAN_LIMITS.requires) }).safeParse(input);
  const missing = head.success ? head.data.requires.filter((feature) => !supported.includes(feature)) : [];
  if (missing.length > 0) throw new UnsupportedPlanError(missing);
  return renderPlanExecutorSchemaUnchecked.parse(input);
}

/** Timeline second an audio entry stops playing. */
export function audioEntryEnd(entry: Pick<PlanAudioEntry, 'at' | 'in' | 'out' | 'speed'>): number {
  return entry.at + (entry.out - entry.in) / entry.speed;
}

/**
 * The frame a timeline time falls on: floor(t * fps + 1e-6). The builder
 * quantizes both edges of every clip with it (see TIME AND FRAMES).
 */
export function planFrameAt(t: number, fps: number): number {
  return Math.floor(t * fps + RENDER_PLAN_EPSILON);
}

/** Output frames a plan renders: ceil(duration * fps - 1e-6). */
export function planFrameCount(plan: Pick<RenderPlan, 'duration' | 'fps'>): number {
  return Math.max(0, Math.ceil(plan.duration * plan.fps - RENDER_PLAN_EPSILON));
}

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
