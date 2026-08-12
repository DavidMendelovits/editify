import { z } from 'zod';

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
  kind: z.enum(['video', 'audio', 'caption']),
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
}).refine(
  (update) => update.volume !== undefined || update.speed !== undefined
    || update.transform !== undefined || update.start !== undefined,
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
  set_transform: clipIdParams.extend({ transform: transformSchema }),
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
  z.object({ type: z.literal('add_caption'), params: operationParamsSchemas.add_caption }),
  z.object({ type: z.literal('update_caption'), params: operationParamsSchemas.update_caption }),
  z.object({ type: z.literal('remove_caption'), params: operationParamsSchemas.remove_caption }),
  z.object({ type: z.literal('ripple_delete_ranges'), params: operationParamsSchemas.ripple_delete_ranges }),
  z.object({ type: z.literal('set_clip_properties'), params: operationParamsSchemas.set_clip_properties }),
  z.object({ type: z.literal('set_format'), params: operationParamsSchemas.set_format }),
  z.object({ type: z.literal('undo'), params: operationParamsSchemas.undo }),
]);
export type Operation = z.infer<typeof operationSchema>;

export const operationBatchSchema = z.object({
  ops: z.array(operationSchema).min(1).max(100),
  baseVersion: z.number().int().min(0),
});

export const chatRequestSchema = z.object({ message: z.string().trim().min(1).max(4000) });
export const agentResponseSchema = z.object({
  reply: z.string().min(1),
  ops: z.array(operationSchema).max(100),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export const agentTraceStepSchema = z.object({
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

export const renderRequestSchema = z.object({
  resolution: z.enum(['720p', '1080p', '4k']).default('1080p'),
});

export const styleAnalyzeSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(10),
});

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
  'reorder_clips', 'set_volume', 'set_speed', 'set_transform', 'add_caption',
  'update_caption', 'remove_caption', 'set_format', 'undo',
  'ripple_delete_ranges', 'set_clip_properties',
] as const;

export * from './presets.js';
