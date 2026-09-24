import { z } from 'zod';
import { calloutSchema } from './packets.js';

export const projectFormatSchema = z.enum(['9:16', '1:1', '16:9']);
export type ProjectFormat = z.infer<typeof projectFormatSchema>;

export const captionStyleSchema = z.object({
  font: z.string().min(1).default('Montserrat'),
  size: z.number().min(10).max(200).default(52),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
  position: z.enum(['top', 'center', 'bottom']).default('bottom'),
  emphasis: z.enum(['none', 'bold', 'highlight']).default('bold'),
  anchorPct: z.number().min(0).max(100).optional(),
  sizePct: z.number().min(1).max(25).optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokePx: z.number().min(0).max(20).optional(),
  emphasisColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  words: z.array(z.object({
    w: z.string().min(1),
    s: z.number().min(0),
    e: z.number().min(0),
  }).refine((word) => word.e > word.s, { message: 'word end must be after start' })).optional(),
});
export type CaptionStyle = z.infer<typeof captionStyleSchema>;

export const transformSchema = z.object({
  scale: z.number().min(0.1).max(10).default(1),
  x: z.number().min(-1).max(1).default(0),
  y: z.number().min(-1).max(1).default(0),
});
export type ClipTransform = z.infer<typeof transformSchema>;

/**
 * Sticker placement on the frame, normalized so one document renders the same
 * at every resolution: `x`/`y` are the sticker centre as fractions of frame
 * width/height, `width` is the sticker width as a fraction of frame width
 * (height follows the source aspect), `rotation` is clockwise degrees.
 */
export const overlayPlacementSchema = z.object({
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.35),
  width: z.number().min(0.04).max(1).default(0.28),
  rotation: z.number().min(-180).max(180).default(0),
});
export type OverlayPlacement = z.infer<typeof overlayPlacementSchema>;

/**
 * Transition INTO a clip at its timeline start. `crossfade` overlaps the
 * previous clip by borrowing up to `duration` seconds of source material past
 * its out point (timeline positions never move); `dip` fades through black
 * symmetrically around the cut and needs no extra material.
 */
export const transitionSchema = z.object({
  type: z.enum(['crossfade', 'dip']),
  duration: z.number().min(0.1).max(2).default(0.5),
});
export type ClipTransition = z.infer<typeof transitionSchema>;

const clipObjectSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1).optional(),
  start: z.number().min(0),
  in: z.number().min(0),
  out: z.number().positive(),
  volume: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.1).max(8).optional(),
  text: z.string().min(1).optional(),
  style: captionStyleSchema.optional(),
  transform: transformSchema.optional(),
  /**
   * When set, the crop/zoom animates linearly from `transform` (or identity)
   * to `transformEnd` across the clip's timeline duration — punch-ins and
   * Ken Burns moves are just a start and an end pose.
   */
  transformEnd: transformSchema.optional(),
  /** Sticker placement — only meaningful on overlay-track clips. */
  overlay: overlayPlacementSchema.optional(),
  /** Transition into this clip — only meaningful on video-track clips. */
  transition: transitionSchema.optional(),
  /** Duck all other audio beneath this clip while it plays (voiceover). */
  duck: z.boolean().optional(),
  /** Callout card treatment — overlay-track clips whose `text` is a callout line. */
  callout: calloutSchema.optional(),
});

function validateClipRange(clip: { in: number; out: number }, ctx: z.RefinementCtx): void {
  if (clip.out <= clip.in) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'out must be greater than in', path: ['out'] });
  }
}

export const clipSchema = clipObjectSchema.superRefine(validateClipRange);
export type Clip = z.infer<typeof clipSchema>;

export const trackSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['video', 'audio', 'caption', 'overlay']),
  clips: z.array(clipSchema),
});
export type Track = z.infer<typeof trackSchema>;

export const projectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  format: projectFormatSchema,
  fps: z.number().int().min(1).max(120).default(30),
  duration: z.number().min(0),
  tracks: z.array(trackSchema),
  version: z.number().int().min(0),
});
export type Project = z.infer<typeof projectSchema>;

export const newProjectSchema = z.object({
  title: z.string().min(1).max(120).default('Untitled edit'),
  format: projectFormatSchema.default('9:16'),
  fps: z.number().int().min(1).max(120).default(30),
});
export type NewProject = z.infer<typeof newProjectSchema>;

const clipIdParams = z.object({ clipId: z.string().min(1) });

const rippleRangeSchema = z.object({
  start: z.number().min(0),
  end: z.number().positive(),
}).refine((range) => range.end > range.start, { message: 'range end must be after start', path: ['end'] });

const clipPropertyUpdateSchema = clipIdParams.extend({
  volume: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.1).max(8).optional(),
  transform: transformSchema.optional(),
  start: z.number().min(0).optional(),
  in: z.number().min(0).optional(),
  out: z.number().positive().optional(),
  duck: z.boolean().optional(),
}).refine(
  (update) => update.volume !== undefined || update.speed !== undefined
    || update.transform !== undefined || update.start !== undefined
    || update.in !== undefined || update.out !== undefined
    || update.duck !== undefined,
  { message: 'Each update must set at least one property' },
);

export const operationParamsSchemas = {
  add_clip: z.object({ trackId: z.string().min(1), clip: clipSchema }),
  remove_clip: clipIdParams,
  split_clip: clipIdParams.extend({ at: z.number().min(0), newClipId: z.string().min(1).optional() }),
  trim_clip: clipIdParams.extend({ in: z.number().min(0).optional(), out: z.number().positive().optional() }),
  move_clip: clipIdParams.extend({ start: z.number().min(0), trackId: z.string().min(1).optional() }),
  reorder_clips: z.object({ trackId: z.string().min(1), clipIds: z.array(z.string().min(1)).min(1) }),
  set_volume: clipIdParams.extend({ volume: z.number().min(0).max(1) }),
  set_speed: clipIdParams.extend({ speed: z.number().min(0.1).max(8) }),
  set_transform: clipIdParams.extend({
    transform: transformSchema,
    /** Present → animate from `transform` to this pose; absent → static (clears any zoom). */
    transformEnd: transformSchema.optional(),
  }),
  set_overlay: clipIdParams.extend({ overlay: overlayPlacementSchema }),
  set_transition: clipIdParams.extend({ transition: transitionSchema.nullable() }),
  add_caption: z.object({
    trackId: z.string().min(1).default('captions'),
    clip: clipObjectSchema.extend({ text: z.string().min(1) }).superRefine(validateClipRange),
  }),
  update_caption: clipIdParams.extend({
    text: z.string().min(1).optional(),
    start: z.number().min(0).optional(),
    in: z.number().min(0).optional(),
    out: z.number().positive().optional(),
    style: captionStyleSchema.optional(),
  }),
  remove_caption: clipIdParams,
  ripple_delete_ranges: z.object({
    trackId: z.string().min(1),
    ranges: z.array(rippleRangeSchema).min(1).max(50),
  }),
  set_clip_properties: z.object({
    updates: z.array(clipPropertyUpdateSchema).min(1).max(100),
  }).superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.updates.forEach((update, index) => {
      if (seen.has(update.clipId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'clipId may appear only once', path: ['updates', index, 'clipId'] });
      }
      seen.add(update.clipId);
    });
  }),
  set_format: z.object({ format: projectFormatSchema }),
  undo: z.object({}).strict(),
  redo: z.object({}).strict(),
  /** Not an agent tool: only the client's per-turn Revert issues this. */
  revert_run: z.object({ runId: z.string().min(1) }),
} as const;

export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_clip'), params: operationParamsSchemas.add_clip }),
  z.object({ type: z.literal('remove_clip'), params: operationParamsSchemas.remove_clip }),
  z.object({ type: z.literal('split_clip'), params: operationParamsSchemas.split_clip }),
  z.object({ type: z.literal('trim_clip'), params: operationParamsSchemas.trim_clip }),
  z.object({ type: z.literal('move_clip'), params: operationParamsSchemas.move_clip }),
  z.object({ type: z.literal('reorder_clips'), params: operationParamsSchemas.reorder_clips }),
  z.object({ type: z.literal('set_volume'), params: operationParamsSchemas.set_volume }),
  z.object({ type: z.literal('set_speed'), params: operationParamsSchemas.set_speed }),
  z.object({ type: z.literal('set_transform'), params: operationParamsSchemas.set_transform }),
  z.object({ type: z.literal('set_overlay'), params: operationParamsSchemas.set_overlay }),
  z.object({ type: z.literal('set_transition'), params: operationParamsSchemas.set_transition }),
  z.object({ type: z.literal('add_caption'), params: operationParamsSchemas.add_caption }),
  z.object({ type: z.literal('update_caption'), params: operationParamsSchemas.update_caption }),
  z.object({ type: z.literal('remove_caption'), params: operationParamsSchemas.remove_caption }),
  z.object({ type: z.literal('ripple_delete_ranges'), params: operationParamsSchemas.ripple_delete_ranges }),
  z.object({ type: z.literal('set_clip_properties'), params: operationParamsSchemas.set_clip_properties }),
  z.object({ type: z.literal('set_format'), params: operationParamsSchemas.set_format }),
  z.object({ type: z.literal('undo'), params: operationParamsSchemas.undo }),
  z.object({ type: z.literal('redo'), params: operationParamsSchemas.redo }),
  z.object({ type: z.literal('revert_run'), params: operationParamsSchemas.revert_run }),
]);
export type Operation = z.infer<typeof operationSchema>;

export const operationBatchSchema = z.object({
  ops: z.array(operationSchema).min(1).max(100),
  baseVersion: z.number().int().min(0),
});

/** Chat messages carry pasted transcripts, so the cap is generous rather than prose-sized. */
export const MAX_CHAT_MESSAGE_CHARS = 24000;

export const chatRequestSchema = z.object({ message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS) });
/** `POST /projects/:id/chat/improve` — rewrite a casual message before it is sent. */
export const improveRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS),
  /** The user's previous message, so a follow-up reads as a refinement of it. */
  previous: z.string().trim().max(MAX_CHAT_MESSAGE_CHARS).optional(),
});
export const improveResponseSchema = z.object({
  improved: z.string().nullable(),
  changes: z.array(z.string()).optional(),
});
export type ImproveResponse = z.infer<typeof improveResponseSchema>;
export const agentResponseSchema = z.object({
  reply: z.string().min(1),
  ops: z.array(operationSchema).max(100),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export const agentTraceStepSchema = z.object({
  /** 'thought' carries the model's own reasoning text in `summary`; everything else is a tool call. */
  kind: z.literal('thought').optional(),
  tool: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  summary: z.string(),
});
export type AgentTraceStep = z.infer<typeof agentTraceStepSchema>;

export const chatResponseSchema = z.object({
  reply: z.string(),
  trace: z.array(agentTraceStepSchema),
  opsApplied: z.array(operationSchema),
  doc: projectSchema,
  /** Checkpoint id for this turn — the handle the client's Revert reverts. */
  runId: z.string().optional(),
});
export type ChatResponse = z.infer<typeof chatResponseSchema>;

export const assetMetadataSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  duration: z.number().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  fps: z.number().min(0),
  hasAudio: z.boolean(),
  /**
   * Proxy/thumbnail generation runs after the import responds, so a fresh asset
   * is 'processing' until its media is on disk. Rows that predate this default
   * to 'ready'.
   */
  status: z.enum(['processing', 'ready', 'error']).default('ready'),
  /** User-given name in the media library; falls back to `originalName` when unset. */
  label: z.string().optional(),
  originalUrl: z.string(),
  proxyUrl: z.string(),
  thumbnailUrl: z.string(),
  // 20 frames tiled 20x1, ordered left to right over [0, duration]; tile k covers [k*duration/20, (k+1)*duration/20).
  filmstripUrl: z.string(),
  createdAt: z.string(),
});
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

export const assetInsightsSchema = z.object({
  assetId: z.string(),
  hook: z.object({
    start: z.number(),
    end: z.number(),
    text: z.string(),
    reason: z.string(),
  }).nullable(),
  highlights: z.array(z.object({
    start: z.number(),
    end: z.number(),
    text: z.string(),
    score: z.number().min(0).max(1),
    label: z.string(),
  })),
  summary: z.string(),
  generatedAt: z.string(),
});
export type AssetInsights = z.infer<typeof assetInsightsSchema>;

export const soundCategorySchema = z.enum(['whoosh', 'impact', 'pop', 'ui', 'riser', 'music']);
export type SoundCategory = z.infer<typeof soundCategorySchema>;

/** One entry of the built-in sound library. `assetId` is ready for `add_clip`. */
export const librarySoundSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: soundCategorySchema,
  duration: z.number().min(0),
  assetId: z.string(),
  url: z.string(),
});
export type LibrarySound = z.infer<typeof librarySoundSchema>;

/**
 * ffmpeg-only dissection of a source video: cut cadence, audio energy, tempo,
 * and where burned-in graphics/captions live. All times are source seconds.
 */
export const assetDissectionSchema = z.object({
  assetId: z.string(),
  duration: z.number().min(0),
  /** Scene-change timestamps — the cut points. */
  cuts: z.array(z.number()),
  averageShotLength: z.number(),
  cutDensity: z.number(),
  /** Estimated musical tempo from audio energy periodicity, or null without audio. */
  tempoBpm: z.number().nullable(),
  loudnessLufs: z.number().nullable(),
  /** Coarse RMS energy curve for sparklines and beat-matching. */
  energy: z.object({ cellSeconds: z.number().positive(), rmsDb: z.array(z.number()) }),
  /** Times of prominent audio onsets (hits, beats, emphasis). */
  energyPeaks: z.array(z.number()),
  /** Spans where a frame zone carries text/graphic-like edge density. */
  overlayActivity: z.array(z.object({
    start: z.number(),
    end: z.number(),
    zone: z.enum(['top', 'bottom']),
  })),
  summary: z.string(),
  generatedAt: z.string(),
});
export type AssetDissection = z.infer<typeof assetDissectionSchema>;

export const renderRequestSchema = z.object({
  resolution: z.enum(['720p', '1080p', '4k']).default('1080p'),
  /** 'sdr' tone maps HDR sources to BT.709 so the export matches the preview. */
  hdr: z.enum(['sdr', 'hdr']).default('sdr'),
});

export const styleAnalyzeSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(10),
  name: z.string().min(1).max(60).optional(),
  /** Override the configured video analyzer for this run only. */
  analyzer: z.string().min(1).max(60).optional(),
  /** Watch every video again instead of reusing cached observations. */
  refresh: z.boolean().optional(),
});

export const styleAnalyzerSelectSchema = z.object({ analyzer: z.string().min(1).max(60) }).strict();

/** PATCH a style profile: rename it and/or hand-edit the style memory that briefs the agent. */
export const styleRenameSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  styleDoc: z.string().trim().min(1).max(20000).optional(),
}).refine((body) => body.name !== undefined || body.styleDoc !== undefined, { message: 'Send a name or a styleDoc' });

/**
 * Re-fit a caption's per-word karaoke timings onto edited text. Both the ASS
 * export and the preview overlay build the VISIBLE string from `style.words`,
 * so text edited without this would still render the old words.
 *
 * Same word count means a typo fix: every `s`/`e` is kept and only `w` swaps,
 * so hand edits never lose the transcript's timing. A different count
 * redistributes the original span across the new words by character length.
 */
export function refitCaptionWords(
  words: CaptionStyle['words'],
  text: string,
): CaptionStyle['words'] {
  if (!words?.length) return undefined;
  const next = text.split(/\s+/).filter(Boolean);
  if (next.length === 0) return undefined;
  if (next.length === words.length) return words.map((word, index) => ({ ...word, w: next[index] as string }));
  const start = words[0]!.s;
  const end = words[words.length - 1]!.e;
  const span = Math.max(end - start, next.length * MIN_WORD_SECONDS);
  const totalChars = next.reduce((sum, word) => sum + word.length, 0);
  let cursor = start;
  return next.map((word, index) => {
    const share = totalChars > 0 ? word.length / totalChars : 1 / next.length;
    // The last word lands exactly on the original end so the caption never
    // drifts past its own clip; every word keeps `e > s`, which the schema requires.
    const rawEnd = index === next.length - 1 ? start + span : cursor + span * share;
    const wordEnd = Math.max(rawEnd, cursor + MIN_WORD_SECONDS);
    const fitted = { w: word, s: round6(cursor), e: round6(wordEnd) };
    cursor = wordEnd;
    return fitted;
  });
}

/** Floor for a refitted word so `e > s` holds even for a one-character word. */
const MIN_WORD_SECONDS = 0.01;

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function clipTimelineDuration(clip: Clip): number {
  return (clip.out - clip.in) / (clip.speed ?? 1);
}

export function deriveProjectDuration(project: Pick<Project, 'tracks'>): number {
  return project.tracks.reduce(
    (projectMax, track) => Math.max(
      projectMax,
      ...track.clips.map((clip) => clip.start + clipTimelineDuration(clip)),
    ),
    0,
  );
}

export const OPERATION_CATALOG = [
  'add_clip', 'remove_clip', 'split_clip', 'trim_clip', 'move_clip',
  'reorder_clips', 'set_volume', 'set_speed', 'set_transform', 'set_overlay',
  'set_transition', 'add_caption', 'update_caption', 'remove_caption', 'set_format', 'undo', 'redo',
  'ripple_delete_ranges', 'set_clip_properties',
] as const;

export * from './presets.js';
export * from './packets.js';
export * from './checklists.js';
export * from './telemetry.js';
