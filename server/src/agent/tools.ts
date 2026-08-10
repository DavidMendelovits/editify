import {
  OPERATION_CATALOG,
  operationParamsSchemas,
  operationSchema,
  type Operation,
  type Project,
} from '@editify/shared';
import { ZodError, type ZodTypeAny } from 'zod';
import type { AssetStore } from '../db/asset-store.js';
import { ProjectStore, VersionConflictError } from '../db/project-store.js';
import { OperationError } from '../operations/apply.js';

export interface ToolContext {
  projectId: string;
  projects: ProjectStore;
  assets: AssetStore;
  styleDoc: string | null;
  currentVersion: number;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodTypeAny;
  execute(ctx: ToolContext, input: unknown): Promise<unknown>;
}

const emptyInputSchema = operationParamsSchemas.undo;

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
    let project: Project;
    try {
      project = ctx.projects.applyOperations(ctx.projectId, [operation], ctx.currentVersion);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      ctx.currentVersion = error.actual;
      project = ctx.projects.applyOperations(ctx.projectId, [operation], ctx.currentVersion);
    }
    ctx.currentVersion = project.version;
    return operationResult(project);
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
