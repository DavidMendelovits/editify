import {
  EDITING_PRESETS,
  OPERATION_CATALOG,
  PRESETS_BY_NAME,
  captionStyleSchema,
  clipSchema,
  clipTimelineDuration,
  operationParamsSchemas,
  operationSchema,
  presetSchema,
  type Operation,
  type CaptionStyle,
  type Clip,
  type EditingPreset,
  type PresetName,
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
  preset: presetSchema.shape.name.optional(),
}).strict();

const addClipsSchema = z.object({ trackId: z.string().min(1), clips: z.array(clipSchema).min(1).max(100) }).strict();
const splitClipsSchema = z.object({
  cuts: z.array(operationParamsSchemas.split_clip).min(1).max(100),
}).strict();
const closeGapsSchema = z.object({ trackId: z.string().min(1) }).strict();
const removeWordsSchema = z.object({
  wordIndexes: z.array(z.union([z.number().int().min(0), z.tuple([z.number().int().min(0), z.number().int().min(0)])])).min(1).optional(),
  matches: z.array(z.string().trim().min(1)).min(1).optional(),
  keptGapMs: z.union([z.literal(60), z.literal(150), z.literal(320)]).default(150),
}).strict().refine((value) => Boolean(value.wordIndexes) !== Boolean(value.matches), {
  message: 'Provide exactly one of wordIndexes or matches',
});
const removeSilenceSchema = z.object({
  minSilenceSeconds: z.number().min(0.05).max(10).default(0.5),
  padSeconds: z.number().min(0).max(2).default(0.15),
  protectLoudGaps: z.boolean().default(true),
}).strict();
const presetNameSchema = z.object({ name: presetSchema.shape.name }).strict();

export interface TranscriptCaptionChunk {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  start: number;
  duration: number;
  words: Array<{ w: string; s: number; e: number }>;
}

export interface CaptionChunkOptions {
  wordsPerChunk: number;
  maxWordsPerChunk?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  maxCharsPerSecond?: number;
}

export function chunkTranscriptForClip(
  words: TranscriptWord[],
  clip: Pick<Clip, 'start' | 'in' | 'out' | 'speed'>,
  options: number | CaptionChunkOptions = 3,
): TranscriptCaptionChunk[] {
  const settings: CaptionChunkOptions = typeof options === 'number' ? { wordsPerChunk: options } : options;
  const targetWords = settings.wordsPerChunk;
  const maxWords = settings.maxWordsPerChunk ?? targetWords;
  const maxDuration = settings.maxDurationSec ?? Number.POSITIVE_INFINITY;
  const maxCps = settings.maxCharsPerSecond ?? Number.POSITIVE_INFINITY;
  const eligible = words.filter((word) => word.s >= clip.in && word.s < clip.out && word.e > word.s);
  const groups: TranscriptWord[][] = [];
  for (const word of eligible) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const prospective = current ? [...current, word] : [word];
    const prospectiveDuration = (prospective.at(-1)?.e ?? word.e) - (prospective[0]?.s ?? word.s);
    const chars = prospective.map((candidate) => candidate.w).join(' ').length;
    const exceedsCps = prospective.length > 1 && chars / Math.max(prospectiveDuration, 0.01) > maxCps;
    if (!current || current.length >= maxWords || (previous && word.s - previous.e >= 0.6)
      || prospectiveDuration > maxDuration || exceedsCps
      || (current.length >= targetWords && /[,;:]$/.test(previous?.w ?? ''))) {
      groups.push([word]);
    } else {
      current.push(word);
    }
  }
  const speed = clip.speed ?? 1;
  const timelineEnd = clip.start + (clip.out - clip.in) / speed;
  const chunks = groups.flatMap((group) => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return [];
    const start = clip.start + (first.s - clip.in) / speed;
    const mappedEnd = clip.start + (Math.min(last.e, clip.out) - clip.in) / speed;
    const end = Math.min(timelineEnd, Math.max(mappedEnd, start + (settings.minDurationSec ?? 0.25)));
    if (end <= start) return [];
    return [{
      text: group.map((word) => word.w).join(' '),
      sourceStart: first.s,
      sourceEnd: Math.min(last.e, clip.out),
      start,
      duration: end - start,
      words: group.map((word) => ({
        w: word.w,
        s: clip.start + (word.s - clip.in) / speed,
        e: clip.start + (Math.min(word.e, clip.out) - clip.in) / speed,
      })),
    }];
  });
  return clampChunkOverlaps(chunks);
}

const CHUNK_GAP_SEC = 0.001;
const MIN_CHUNK_DURATION_SEC = 0.15;

// minDurationSec can push a chunk past the next chunk's start, which renders as stacked captions.
// Clamping only shortens chunks, so the postcondition start_{i+1} >= start_i + duration_i survives drops.
function clampChunkOverlaps(chunks: TranscriptCaptionChunk[]): TranscriptCaptionChunk[] {
  const sorted = [...chunks].sort((left, right) => left.start - right.start);
  const kept: TranscriptCaptionChunk[] = [];
  for (const [index, chunk] of sorted.entries()) {
    const next = sorted[index + 1];
    if (!next) { kept.push(chunk); continue; }
    const limit = next.start - CHUNK_GAP_SEC;
    if (chunk.start + chunk.duration <= limit) { kept.push(chunk); continue; }
    const duration = limit - chunk.start;
    if (duration >= MIN_CHUNK_DURATION_SEC) kept.push({ ...chunk, duration });
  }
  return kept;
}

interface ClipSnapshot {
  trackId: string;
  clip: Clip;
}

function snapshotClips(project: Project): Map<string, ClipSnapshot> {
  return new Map(project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, { trackId: track.id, clip }] as const)));
}

function compactClip(trackId: string, clip: Clip): Record<string, unknown> {
  return {
    id: clip.id, trackId,
    ...(clip.assetId ? { assetId: clip.assetId } : {}),
    start: clip.start, in: clip.in, out: clip.out,
    ...(clip.volume !== undefined && clip.volume !== 1 ? { volume: clip.volume } : {}),
    ...(clip.speed !== undefined && clip.speed !== 1 ? { speed: clip.speed } : {}),
    ...(clip.text ? { text: clip.text } : {}),
    ...(clip.style ? { style: clip.style } : {}),
    ...(clip.transform && (clip.transform.scale !== 1 || clip.transform.x !== 0 || clip.transform.y !== 0)
      ? { transform: clip.transform } : {}),
  };
}

function equalExceptStart(left: Clip, right: Clip): boolean {
  const { start: _leftStart, ...leftRest } = left;
  const { start: _rightStart, ...rightRest } = right;
  return JSON.stringify(leftRest) === JSON.stringify(rightRest);
}

export function createMutationDelta(before: Project, after: Project, extraNotes: string[] = []): Record<string, unknown> {
  const beforeClips = snapshotClips(before);
  const afterClips = snapshotClips(after);
  const changed: Array<Record<string, unknown>> = [];
  const shifts = new Map<string, { trackId: string; fromSec: number; bySec: number; count: number }>();
  for (const [id, current] of afterClips) {
    const previous = beforeClips.get(id);
    if (!previous) {
      changed.push(compactClip(current.trackId, current.clip));
      continue;
    }
    if (previous.trackId === current.trackId && previous.clip.start !== current.clip.start
      && equalExceptStart(previous.clip, current.clip)) {
      const bySec = current.clip.start - previous.clip.start;
      const key = `${current.trackId}:${bySec.toFixed(9)}`;
      const run = shifts.get(key);
      if (run) {
        run.fromSec = Math.min(run.fromSec, previous.clip.start);
        run.count += 1;
      } else shifts.set(key, { trackId: current.trackId, fromSec: previous.clip.start, bySec, count: 1 });
    } else if (previous.trackId !== current.trackId || JSON.stringify(previous.clip) !== JSON.stringify(current.clip)) {
      changed.push(compactClip(current.trackId, current.clip));
    }
  }
  const removedClipIds = [...beforeClips.keys()].filter((id) => !afterClips.has(id));
  const notes = [...extraNotes];
  if (changed.length > 20) notes.push(`${changed.length - 20} additional changed clips omitted.`);
  return {
    ok: true,
    version: after.version,
    changedClips: changed.slice(0, 20),
    removedClipIds,
    shifted: [...shifts.values()].sort((left, right) => left.trackId.localeCompare(right.trackId) || left.fromSec - right.fromSec),
    notes,
  };
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
  ripple_delete_ranges: 'Atomically delete and close multiple absolute timeline ranges on one video/audio track. Overlaps are merged; intersecting clips are split or trimmed, later clips shift left, and captions are cut and shifted with the deleted time.',
  set_clip_properties: 'Atomically batch-update 1-100 clips. Each update names clipId and one or more of volume, speed, transform, or absolute timeline start. Any invalid update rejects the entire operation.',
  set_format: 'Set the project canvas format to 9:16, 1:1, or 16:9.',
  undo: 'Undo the latest non-undone project operation using project history. Input must be an empty object.',
};

async function executeOperation(ctx: ToolContext, type: Operation['type'], rawInput: unknown): Promise<unknown> {
  try {
    const params = operationParamsSchemas[type].parse(rawInput);
    const operation = operationSchema.parse({ type, params });
    const before = requireProject(ctx);
    const project = applyMany(ctx, [operation]);
    return createMutationDelta(before, project);
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

function requireProject(ctx: ToolContext): Project {
  const project = ctx.projects.get(ctx.projectId);
  if (!project) throw new OperationError(`Project ${ctx.projectId} was not found`);
  ctx.currentVersion = project.version;
  return project;
}

function applyMany(ctx: ToolContext, operations: Operation[]): Project {
  let project: Project;
  try {
    project = ctx.projects.applyOperations(ctx.projectId, operations, ctx.currentVersion);
  } catch (error) {
    if (!(error instanceof VersionConflictError)) throw error;
    ctx.currentVersion = error.actual;
    project = ctx.projects.applyOperations(ctx.projectId, operations, ctx.currentVersion);
  }
  ctx.currentVersion = project.version;
  ctx.appliedOperations?.push(...operations);
  return project;
}

async function executeBatch(ctx: ToolContext, operations: Operation[], notes: string[] = []): Promise<unknown> {
  try {
    const before = requireProject(ctx);
    const after = applyMany(ctx, operations);
    return createMutationDelta(before, after, notes);
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export interface TimelineTranscriptWord {
  index: number;
  text: string;
  timelineStart: number;
  timelineEnd: number;
  sourceStart: number;
  sourceEnd: number;
  clipId: string;
  trackId: string;
  assetId: string;
}

export interface TimelineTranscript {
  words: TimelineTranscriptWord[];
  rows: Array<[number, string, number]>;
  segments: Array<[number, string, number, number]>;
}

export function buildTimelineTranscript(project: Project, getTranscript: (assetId: string) => ReturnType<TranscriptService['get']>): TimelineTranscript {
  const words: TimelineTranscriptWord[] = [];
  const segments: Array<[number, string, number, number]> = [];
  const clips = project.tracks.filter((track) => track.kind === 'video')
    .flatMap((track) => track.clips.map((clip) => ({ trackId: track.id, clip })))
    .sort((left, right) => left.clip.start - right.clip.start || left.trackId.localeCompare(right.trackId) || left.clip.id.localeCompare(right.clip.id));
  for (const { trackId, clip } of clips) {
    if (!clip.assetId) continue;
    const transcript = getTranscript(clip.assetId);
    if (!transcript) continue;
    const speed = clip.speed ?? 1;
    const clipWords = transcript.words.filter((word) => word.s >= clip.in && word.s < clip.out && word.e > word.s);
    const firstIndex = words.length;
    for (const word of clipWords) {
      words.push({
        index: words.length,
        text: word.w,
        timelineStart: clip.start + (word.s - clip.in) / speed,
        timelineEnd: clip.start + (Math.min(word.e, clip.out) - clip.in) / speed,
        sourceStart: word.s,
        sourceEnd: Math.min(word.e, clip.out),
        clipId: clip.id,
        trackId,
        assetId: clip.assetId,
      });
    }
    for (const segment of transcript.segments) {
      const included = words.slice(firstIndex).filter((word) => word.sourceStart >= segment.s && word.sourceStart < segment.e);
      const first = included[0];
      const last = included.at(-1);
      if (!first || !last) continue;
      segments.push([first.index, included.map((word) => word.text).join(' '), first.timelineStart, last.timelineEnd]);
    }
  }
  return { words, rows: words.map((word) => [word.index, word.text, word.timelineStart]), segments };
}

export function planWordCutRanges(
  words: Array<{ start: number; end: number; selected: boolean }>,
  clipStart: number,
  clipEnd: number,
  keptGapMs = 150,
): Array<{ start: number; end: number }> {
  const halfGap = keptGapMs / 2000;
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < words.length) {
    if (!words[index]?.selected) { index += 1; continue; }
    const first = index;
    while (index + 1 < words.length && words[index + 1]?.selected) index += 1;
    const last = index;
    const runStart = words[first]?.start ?? clipStart;
    const runEnd = words[last]?.end ?? clipEnd;
    const left = first > 0 ? words[first - 1]?.end ?? clipStart : clipStart;
    const right = last + 1 < words.length ? words[last + 1]?.start ?? clipEnd : clipEnd;
    const start = Math.max(clipStart, runStart - Math.min(Math.max(0, runStart - left), halfGap));
    const end = Math.min(clipEnd, runEnd + Math.min(Math.max(0, right - runEnd), halfGap));
    if (end > start) ranges.push({ start, end });
    index += 1;
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

function median(values: number[]): number {
  if (!values.length) return Number.NEGATIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function energyCells(rmsDb: number[], cellSeconds: number, start: number, end: number): Array<{ index: number; db: number }> {
  const first = Math.max(0, Math.floor(start / cellSeconds));
  const last = Math.min(rmsDb.length, Math.ceil(end / cellSeconds));
  return rmsDb.slice(first, last).map((db, offset) => ({ index: first + offset, db }));
}

async function captionClipFromTranscript(ctx: ToolContext, rawInput: unknown): Promise<unknown> {
  try {
    const input = captionFromTranscriptSchema.parse(rawInput);
    const project = requireProject(ctx);
    const videoClip = project.tracks.filter((track) => track.kind === 'video')
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === input.clipId);
    if (!videoClip) return { ok: false, error: `Video clip ${input.clipId} was not found` };
    if (!videoClip.assetId) return { ok: false, error: `Video clip ${input.clipId} has no asset` };
    const transcript = ctx.transcripts.get(videoClip.assetId);
    if (!transcript) return { ok: false, error: `No transcript for asset ${videoClip.assetId}` };

    const prefix = `cap-${videoClip.id}-`;
    const clipStart = videoClip.start;
    const clipEnd = videoClip.start + clipTimelineDuration(videoClip);
    // Replace, never stack: anything already covering this clip's timeline span goes, whoever made it.
    const existingIds = project.tracks.filter((track) => track.kind === 'caption')
      .flatMap((track) => track.clips.filter((caption) => caption.id.startsWith(prefix)
        || (caption.start < clipEnd && caption.start + clipTimelineDuration(caption) > clipStart))
        .map((caption) => caption.id));
    const preset = input.preset ? PRESETS_BY_NAME[input.preset] : undefined;
    const chunks = chunkTranscriptForClip(transcript.words, videoClip, preset ? {
      wordsPerChunk: preset.captions.wordsPerChunk.target,
      maxWordsPerChunk: preset.captions.wordsPerChunk.max,
      minDurationSec: preset.captions.chunkDurationSec.min,
      maxDurationSec: preset.captions.chunkDurationSec.max,
      maxCharsPerSecond: preset.captions.maxCharsPerSecond,
    } : input.wordsPerChunk);
    const style: CaptionStyle = input.style ?? (preset ? {
      font: 'Montserrat', size: 64, color: preset.captions.fill, position: 'center', emphasis: 'highlight',
      anchorPct: preset.captions.verticalAnchorPct, sizePct: preset.captions.fontSizePct,
      strokeColor: preset.captions.strokeColor, strokePx: preset.captions.strokePx,
      emphasisColor: preset.captions.emphasisColor,
    } : {
      font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'bottom', emphasis: 'bold',
    });
    const operations: Operation[] = existingIds.map((clipId) => operationSchema.parse({ type: 'remove_caption', params: { clipId } }));
    for (const [index, chunk] of chunks.entries()) {
      operations.push(operationSchema.parse({
        type: 'add_caption',
        params: {
          trackId: 'captions',
          clip: {
            id: `${prefix}${index + 1}`,
            start: chunk.start,
            in: 0,
            out: chunk.duration,
            text: preset?.captions.uppercase ? chunk.text.toUpperCase() : preset ? chunk.text : chunk.text.toUpperCase(),
            style: { ...style, words: chunk.words },
          },
        },
      }));
    }
    const notes = existingIds.length
      ? [`Removed ${existingIds.length} existing caption clip(s) overlapping ${videoClip.id} before inserting.`] : [];
    if (!operations.length) return { ...createMutationDelta(project, project, notes), captionsAdded: 0 };
    const after = applyMany(ctx, operations);
    return { ...createMutationDelta(project, after, notes), captionsAdded: chunks.length };
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

async function removeWords(ctx: ToolContext, rawInput: unknown): Promise<unknown> {
  try {
    const input = removeWordsSchema.parse(rawInput);
    const project = requireProject(ctx);
    const transcript = buildTimelineTranscript(project, (assetId) => ctx.transcripts.get(assetId));
    const selected = new Set<number>();
    if (input.wordIndexes) {
      for (const item of input.wordIndexes) {
        const [start, end] = typeof item === 'number' ? [item, item] : [Math.min(...item), Math.max(...item)];
        if (end >= transcript.words.length) throw new OperationError(`Word index ${end} is outside the timeline transcript`);
        for (let index = start; index <= end; index += 1) selected.add(index);
      }
    } else {
      const normalize = (value: string): string => value.toLowerCase().replace(/^\W+|\W+$/g, '');
      const timelineTokens = transcript.words.map((word) => normalize(word.text));
      for (const match of input.matches ?? []) {
        const phrase = match.split(/\s+/).map(normalize).filter(Boolean);
        if (!phrase.length) continue;
        for (let start = 0; start + phrase.length <= timelineTokens.length; start += 1) {
          if (phrase.every((token, offset) => timelineTokens[start + offset] === token)) {
            for (let offset = 0; offset < phrase.length; offset += 1) selected.add(start + offset);
          }
        }
      }
    }
    if (!selected.size) return { ...createMutationDelta(project, project, ['No matching timeline words were found.']), wordsRemoved: 0 };

    const operations: Operation[] = [];
    const tracks = new Map<string, Array<{ start: number; end: number }>>();
    const byClip = new Map<string, TimelineTranscriptWord[]>();
    for (const word of transcript.words) {
      const list = byClip.get(word.clipId) ?? [];
      list.push(word);
      byClip.set(word.clipId, list);
    }
    for (const clipWords of byClip.values()) {
      if (!clipWords.some((word) => selected.has(word.index))) continue;
      const clip = project.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === clipWords[0]?.clipId);
      if (!clip) continue;
      const ranges = planWordCutRanges(clipWords.map((word) => ({
        start: word.timelineStart, end: word.timelineEnd, selected: selected.has(word.index),
      })), clip.start, clip.start + clipTimelineDuration(clip), input.keptGapMs);
      const list = tracks.get(clipWords[0]?.trackId ?? '') ?? [];
      list.push(...ranges);
      tracks.set(clipWords[0]?.trackId ?? '', list);
    }
    for (const [trackId, ranges] of tracks) {
      operations.push(operationSchema.parse({ type: 'ripple_delete_ranges', params: { trackId, ranges: mergeRanges(ranges) } }));
    }
    if (!operations.length) return { ...createMutationDelta(project, project), wordsRemoved: 0 };
    const after = applyMany(ctx, operations);
    return {
      ...createMutationDelta(project, after, ['Word indices shifted — re-read get_timeline_transcript before another remove_words.']),
      wordsRemoved: selected.size,
    };
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) return { ok: false, error: error.message };
    throw error;
  }
}

async function removeSilence(ctx: ToolContext, rawInput: unknown): Promise<unknown> {
  try {
    const input = removeSilenceSchema.parse(rawInput);
    const project = requireProject(ctx);
    const timeline = buildTimelineTranscript(project, (assetId) => ctx.transcripts.get(assetId));
    const rangesByTrack = new Map<string, Array<{ start: number; end: number }>>();
    let gapsCut = 0;
    let gapsProtected = 0;
    for (let index = 0; index + 1 < timeline.words.length; index += 1) {
      const left = timeline.words[index];
      const right = timeline.words[index + 1];
      if (!left || !right || left.clipId !== right.clipId || left.trackId !== right.trackId) continue;
      const gapDuration = right.timelineStart - left.timelineEnd;
      if (gapDuration < input.minSilenceSeconds) continue;
      const asset = ctx.assets.get(left.assetId);
      if (!asset) continue;
      const speed = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === left.clipId)?.speed ?? 1;
      const stored = ctx.transcripts.get(left.assetId);
      if (!stored) continue;
      const energy = input.protectLoudGaps ? (stored.energy ?? await ctx.transcripts.ensureEnergy(asset)) : undefined;
      const gapCells = energy ? energyCells(energy.rmsDb, energy.cellSeconds, left.sourceEnd, right.sourceStart) : [];
      const speechCells = energy ? timeline.words.filter((word) => word.assetId === left.assetId && word.clipId === left.clipId)
        .flatMap((word) => energyCells(energy.rmsDb, energy.cellSeconds, word.sourceStart, word.sourceEnd).map((cell) => cell.db)) : [];
      const isLoud = Boolean(energy) && median(gapCells.map((cell) => cell.db)) >= median(speechCells) - 12;
      const list = rangesByTrack.get(left.trackId) ?? [];
      if (isLoud && energy) {
        gapsProtected += 1;
        if (gapDuration > 2 && gapCells.length) {
          const peak = gapCells.reduce((best, cell) => cell.db > best.db ? cell : best, gapCells[0] as { index: number; db: number });
          const keepThroughSource = (peak.index + 1) * energy.cellSeconds + 0.4 * speed;
          const cutStart = left.timelineEnd + Math.max(0, keepThroughSource - left.sourceEnd) / speed;
          const cutEnd = right.timelineStart - input.padSeconds;
          if (cutEnd > cutStart) { list.push({ start: cutStart, end: cutEnd }); gapsCut += 1; }
        }
      } else {
        const start = left.timelineEnd + input.padSeconds;
        const end = right.timelineStart - input.padSeconds;
        if (end > start) { list.push({ start, end }); gapsCut += 1; }
      }
      rangesByTrack.set(left.trackId, list);
    }
    const operations = [...rangesByTrack].filter(([, ranges]) => ranges.length).map(([trackId, ranges]) =>
      operationSchema.parse({ type: 'ripple_delete_ranges', params: { trackId, ranges: mergeRanges(ranges) } }));
    const merged = [...rangesByTrack.values()].flatMap(mergeRanges);
    const removedSec = merged.reduce((total, range) => total + range.end - range.start, 0);
    if (!operations.length) return { ...createMutationDelta(project, project), removedSec: 0, gapsCut, gapsProtected };
    const after = applyMany(ctx, operations);
    return { ...createMutationDelta(project, after), removedSec, gapsCut, gapsProtected };
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) return { ok: false, error: error.message };
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
    {
      name: 'get_timeline_transcript',
      description: 'Read the speech currently audible on the edited video timeline. Returns compact word rows [globalWordIndex,text,timelineStartSec] and sentence rows [firstWordIndex,text,startSec,endSec]. Word indexes remain valid only until the next timeline mutation.',
      schema: emptyInputSchema,
      execute: async (ctx, input) => {
        emptyInputSchema.parse(input);
        const timeline = buildTimelineTranscript(requireProject(ctx), (assetId) => ctx.transcripts.get(assetId));
        return { words: timeline.rows, segments: timeline.segments };
      },
    },
    {
      name: 'list_presets',
      description: 'List the built-in editing presets with their target content. Fetch a matching preset before applying a named style or content-specific edit.',
      schema: emptyInputSchema,
      execute: async (_ctx, input) => {
        emptyInputSchema.parse(input);
        return EDITING_PRESETS.map(({ name, description, targetContent }) => ({ name, description, targetContent }));
      },
    },
    {
      name: 'get_preset',
      description: 'Get every actionable parameter and rationale for one built-in editing preset. Presets guide editorial judgment; they are not rigid law.',
      schema: presetNameSchema,
      execute: async (_ctx, input) => PRESETS_BY_NAME[presetNameSchema.parse(input).name],
    },
  ];

  const batchTools: ToolDef[] = [
    {
      name: 'add_clips',
      description: 'Preferred batch form of add_clip. Atomically add 1-100 media clips to one video/audio track in the supplied order. All clip IDs must be globally unique; source in/out and absolute timeline starts are seconds.',
      schema: addClipsSchema,
      execute: async (ctx, rawInput) => {
        const input = addClipsSchema.parse(rawInput);
        return await executeBatch(ctx, input.clips.map((clip) => operationSchema.parse({ type: 'add_clip', params: { trackId: input.trackId, clip } })));
      },
    },
    {
      name: 'split_clips',
      description: 'Preferred batch form of split_clip. Atomically split 1-100 clips at absolute timeline seconds. Any invalid cut rejects the whole batch.',
      schema: splitClipsSchema,
      execute: async (ctx, rawInput) => {
        const input = splitClipsSchema.parse(rawInput);
        return await executeBatch(ctx, input.cuts.map((params) => operationSchema.parse({ type: 'split_clip', params })));
      },
    },
    {
      name: 'remove_words',
      description: 'Descript-style transcript cut. Select global timeline word indexes/ranges or exact word matches (mutually exclusive), retain half of keptGapMs on each side, and ripple-delete all selected runs atomically. Re-read the timeline transcript afterward.',
      schema: removeWordsSchema,
      execute: removeWords,
    },
    {
      name: 'remove_silence',
      description: 'Remove long gaps between timeline words, keeping padSeconds at speech edges. With protectLoudGaps, gaps within 12 dB of speech are protected as laughter/reaction; reactions over 2 seconds may be shortened through the energy peak plus 0.4 seconds.',
      schema: removeSilenceSchema,
      execute: removeSilence,
    },
    {
      name: 'close_gaps',
      description: 'Repack one track sequentially from its first clip start, preserving chronological order. Call after speed or trim changes unless black gaps are explicitly intended.',
      schema: closeGapsSchema,
      execute: async (ctx, rawInput) => {
        try {
          const { trackId } = closeGapsSchema.parse(rawInput);
          const project = requireProject(ctx);
          const track = project.tracks.find((candidate) => candidate.id === trackId);
          if (!track) throw new OperationError(`Track ${trackId} was not found`);
          const ordered = [...track.clips].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
          let cursor = ordered[0]?.start ?? 0;
          const updates: Array<{ clipId: string; start: number }> = [];
          for (const clip of ordered) {
            if (Math.abs(clip.start - cursor) > 1e-9) updates.push({ clipId: clip.id, start: cursor });
            cursor += clipTimelineDuration(clip);
          }
          if (!updates.length) return createMutationDelta(project, project, ['Track already had no gaps.']);
          return await executeBatch(ctx, [operationSchema.parse({ type: 'set_clip_properties', params: { updates } })]);
        } catch (error) {
          if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) return { ok: false, error: error.message };
          throw error;
        }
      },
    },
  ];

  const operationTools = OPERATION_CATALOG.map<ToolDef>((name) => ({
    name,
    description: operationDescriptions[name],
    schema: operationParamsSchemas[name],
    execute: async (ctx, input) => await executeOperation(ctx, name, input),
  }));
  return [...readTools, ...batchTools, ...operationTools];
}

export function isOperationTool(name: string): name is Operation['type'] {
  return (OPERATION_CATALOG as readonly string[]).includes(name);
}
