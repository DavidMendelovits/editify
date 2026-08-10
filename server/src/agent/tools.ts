import {
  OPERATION_CATALOG,
  captionStyleSchema,
  operationParamsSchemas,
  operationSchema,
  type Operation,
  type CaptionStyle,
  type Clip,
  type Project,
} from '@editify/shared';
import { z, ZodError, type ZodTypeAny } from 'zod';
import type { AssetStore } from '../db/asset-store.js';
import { ProjectStore, VersionConflictError } from '../db/project-store.js';
import type { TranscriptWord } from '../db/transcript-store.js';
import { OperationError } from '../operations/apply.js';
import type { InsightService } from '../services/insight-service.js';
import type { TranscriptService } from '../services/transcript-service.js';

export interface ToolContext {
  projectId: string;
  projects: ProjectStore;
  assets: AssetStore;
  styleDoc: string | null;
  currentVersion: number;
  transcripts: TranscriptService;
  insights: InsightService;
  appliedOperations?: Operation[];
}

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodTypeAny;
  execute(ctx: ToolContext, input: unknown): Promise<unknown>;
}

const emptyInputSchema = operationParamsSchemas.undo;
const assetInputSchema = z.object({ assetId: z.string().min(1) }).strict();
const captionFromTranscriptSchema = z.object({
  clipId: z.string().min(1),
  wordsPerChunk: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
  style: captionStyleSchema.optional(),
}).strict();

export interface TranscriptCaptionChunk {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  start: number;
  duration: number;
}

export function chunkTranscriptForClip(
  words: TranscriptWord[],
  clip: Pick<Clip, 'start' | 'in' | 'out' | 'speed'>,
  wordsPerChunk = 3,
): TranscriptCaptionChunk[] {
  const eligible = words.filter((word) => word.s >= clip.in && word.s < clip.out && word.e > word.s);
  const groups: TranscriptWord[][] = [];
  for (const word of eligible) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (!current || current.length >= wordsPerChunk || (previous && word.s - previous.e > 0.6)) {
      groups.push([word]);
    } else {
      current.push(word);
    }
  }
  const speed = clip.speed ?? 1;
  const timelineEnd = clip.start + (clip.out - clip.in) / speed;
  return groups.flatMap((group) => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return [];
    const start = clip.start + (first.s - clip.in) / speed;
    const mappedEnd = clip.start + (Math.min(last.e, clip.out) - clip.in) / speed;
    const end = Math.min(timelineEnd, Math.max(mappedEnd, start + 0.25));
    if (end <= start) return [];
    return [{
      text: group.map((word) => word.w).join(' '),
      sourceStart: first.s,
      sourceEnd: Math.min(last.e, clip.out),
      start,
      duration: end - start,
    }];
  });
}

const operationDescriptions: Record<Operation['type'], string> = {
  add_clip: 'Add a media clip to a video or audio track. assetId must come from list_assets and clip.id must be unique; use readable IDs such as clip-hook-1. clip.in and clip.out are source-time seconds, clip.start is an absolute timeline second, and timeline duration is (out-in)/speed.',
  remove_clip: 'Remove a non-caption clip by its unique clipId.',
  split_clip: 'Split a clip at an absolute timeline second `at` strictly inside the clip. Optionally provide a unique readable newClipId for the right-hand clip. This is timeline time, not source time.',
  trim_clip: 'Change a clip source range. `in` and `out` are source-time seconds and out must remain greater than in. Timeline duration becomes (out-in)/speed.',
  move_clip: 'Move a clip so `start` is an absolute timeline second. An optional trackId may move it only to another track of the same kind.',
  reorder_clips: 'Reorder every clip in a track. clipIds must contain each current clip ID exactly once; the operation lays clips sequentially from timeline second 0.',
  set_volume: 'Set a clip volume from 0 (silent) to 1 (full volume).',
  set_speed: 'Set playback speed as a 0.1–8 multiplier. Timeline duration is (out-in)/speed, so 1.25 is 25% faster.',
  set_transform: 'Set a clip crop/placement transform: scale 0.1–10, x -1–1, and y -1–1.',
  add_caption: 'Add a timed caption. Use a unique readable clip.id, absolute timeline seconds for clip.start, and a caption-local range where clip.in is normally 0 and clip.out is its duration. Prefer trackId `captions`; style supports font, size, color, position, and emphasis.',
  update_caption: 'Update an existing caption by clipId. start is an absolute timeline second; in/out are caption-local seconds and out must remain greater than in.',
  remove_caption: 'Remove an existing caption by its clipId.',
  set_format: 'Set the project canvas format to 9:16, 1:1, or 16:9.',
  undo: 'Undo the latest non-undone project operation using project history. Input must be an empty object.',
};

function operationResult(project: Project): unknown {
  return {
    ok: true,
    version: project.version,
    duration: project.duration,
    tracks: project.tracks.map((track) => ({ id: track.id, kind: track.kind, clipCount: track.clips.length })),
  };
}

async function executeOperation(ctx: ToolContext, type: Operation['type'], rawInput: unknown): Promise<unknown> {
  try {
    const params = operationParamsSchemas[type].parse(rawInput);
    const operation = operationSchema.parse({ type, params });
    const project = applyOne(ctx, operation);
    return operationResult(project);
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

function applyOne(ctx: ToolContext, operation: Operation): Project {
  let project: Project;
  try {
    project = ctx.projects.applyOperations(ctx.projectId, [operation], ctx.currentVersion);
  } catch (error) {
    if (!(error instanceof VersionConflictError)) throw error;
    ctx.currentVersion = error.actual;
    project = ctx.projects.applyOperations(ctx.projectId, [operation], ctx.currentVersion);
  }
  ctx.currentVersion = project.version;
  ctx.appliedOperations?.push(operation);
  return project;
}

async function captionClipFromTranscript(ctx: ToolContext, rawInput: unknown): Promise<unknown> {
  try {
    const input = captionFromTranscriptSchema.parse(rawInput);
    let project = ctx.projects.get(ctx.projectId);
    if (!project) return { ok: false, error: `Project ${ctx.projectId} was not found` };
    ctx.currentVersion = project.version;
    const videoClip = project.tracks.filter((track) => track.kind === 'video')
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === input.clipId);
    if (!videoClip) return { ok: false, error: `Video clip ${input.clipId} was not found` };
    if (!videoClip.assetId) return { ok: false, error: `Video clip ${input.clipId} has no asset` };
    const transcript = ctx.transcripts.get(videoClip.assetId);
    if (!transcript) return { ok: false, error: `No transcript for asset ${videoClip.assetId}` };

    const prefix = `cap-${videoClip.id}-`;
    const existingIds = project.tracks.filter((track) => track.kind === 'caption')
      .flatMap((track) => track.clips.filter((caption) => caption.id.startsWith(prefix)).map((caption) => caption.id));
    for (const clipId of existingIds) {
      project = applyOne(ctx, operationSchema.parse({ type: 'remove_caption', params: { clipId } }));
    }

    const chunks = chunkTranscriptForClip(transcript.words, videoClip, input.wordsPerChunk);
    const style: CaptionStyle = input.style ?? {
      font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'bottom', emphasis: 'bold',
    };
    for (const [index, chunk] of chunks.entries()) {
      project = applyOne(ctx, operationSchema.parse({
        type: 'add_caption',
        params: {
          trackId: 'captions',
          clip: {
            id: `${prefix}${index + 1}`,
            start: chunk.start,
            in: 0,
            out: chunk.duration,
            text: chunk.text.toUpperCase(),
            style,
          },
        },
      }));
    }
    return { ok: true, captionsAdded: chunks.length, version: project.version };
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export function createToolRegistry(): ToolDef[] {
  const readTools: ToolDef[] = [
    {
      name: 'get_project',
      description: 'Get the complete current project document, including tracks, clips, timing, format, duration, and version. Call this after mutations when you need fresh clip state.',
      schema: emptyInputSchema,
      execute: async (ctx, input) => {
        emptyInputSchema.parse(input);
        const project = ctx.projects.get(ctx.projectId);
        if (!project) return { ok: false, error: `Project ${ctx.projectId} was not found` };
        ctx.currentVersion = project.version;
        return project;
      },
    },
    {
      name: 'list_assets',
      description: 'List imported media assets available for clips. Use an asset id from this result as add_clip.assetId. Duration is source-time seconds.',
      schema: emptyInputSchema,
      execute: async (ctx, input) => {
        emptyInputSchema.parse(input);
        return ctx.assets.list().map(({ id, originalName, duration, width, height, hasAudio }) => ({
          id, originalName, duration, width, height, hasAudio,
        }));
      },
    },
    {
      name: 'get_style_profile',
      description: 'Get the latest natural-language editing style document, or null when no style profile exists.',
      schema: emptyInputSchema,
      execute: async (ctx, input) => {
        emptyInputSchema.parse(input);
        return ctx.styleDoc;
      },
    },
    {
      name: 'get_transcript',
      description: 'Get an asset transcript by assetId. Returns language, segments, wordCount, and compact word tuples [word, sourceStartSeconds, sourceEndSeconds]. Use source timestamps for trims.',
      schema: assetInputSchema,
      execute: async (ctx, input) => {
        const { assetId } = assetInputSchema.parse(input);
        const transcript = ctx.transcripts.get(assetId);
        if (!transcript) return { ok: false, error: `No transcript for asset ${assetId}` };
        return {
          language: transcript.language,
          segments: transcript.segments,
          wordCount: transcript.words.length,
          words: transcript.words.map((word) => [word.w, word.s, word.e]),
        };
      },
    },
    {
      name: 'get_insights',
      description: 'Get or lazily compute transcript-only hook and highlight insights for an assetId. Timestamps are source-time seconds suitable for add_clip in/out trims.',
      schema: assetInputSchema,
      execute: async (ctx, input) => {
        const { assetId } = assetInputSchema.parse(input);
        const asset = ctx.assets.get(assetId);
        if (!asset) return { ok: false, error: `Asset ${assetId} was not found` };
        const result = await ctx.insights.getOrCreate(asset);
        return result ?? { ok: false, error: `No transcript for asset ${assetId}` };
      },
    },
    {
      name: 'caption_clip_from_transcript',
      description: 'Replace generated captions for one video clip using its asset transcript. wordsPerChunk is 1-4 (default 3). Source word times are mapped through clip.in, clip.start, and speed to absolute timeline seconds. Default captions are uppercase Montserrat Bold, size 64, white, and bottom-positioned.',
      schema: captionFromTranscriptSchema,
      execute: captionClipFromTranscript,
    },
  ];

  const operationTools = OPERATION_CATALOG.map<ToolDef>((name) => ({
    name,
    description: operationDescriptions[name],
    schema: operationParamsSchemas[name],
    execute: async (ctx, input) => await executeOperation(ctx, name, input),
  }));
  return [...readTools, ...operationTools];
}

export function isOperationTool(name: string): name is Operation['type'] {
  return (OPERATION_CATALOG as readonly string[]).includes(name);
}
