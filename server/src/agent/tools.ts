import {
  EDITING_PRESETS,
  OPERATION_CATALOG,
  PACKETS_BY_ID,
  PRESETS_BY_NAME,
  STYLE_PACKETS,
  captionStyleSchema,
  clipSchema,
  clipTimelineDuration,
  operationParamsSchemas,
  operationSchema,
  presetSchema,
  stylePacketSchema,
  type Operation,
  type CaptionStyle,
  type Clip,
  type EditingPreset,
  type PresetName,
  type Project,
} from '@editify/shared';
import { z, ZodError, type ZodTypeAny } from 'zod';
import type { AssetStore, StoredAsset } from '../db/asset-store.js';
import { ProjectStore, VersionConflictError } from '../db/project-store.js';
import type { StoredTranscript, TranscriptWord } from '../db/transcript-store.js';
import { ensureSoundLibrary } from '../media/sound-library.js';
import { OperationError } from '../operations/apply.js';
import {
  buildTimelineTranscript,
  normalizeWord,
  planSilenceRanges,
  planWordRemovalRanges,
} from '../services/cleanup.js';
import type { DissectService } from '../services/dissect-service.js';
import type { InsightService } from '../services/insight-service.js';
import type { TranscriptService } from '../services/transcript-service.js';

export { buildTimelineTranscript, planWordCutRanges } from '../services/cleanup.js';
export type { TimelineTranscript, TimelineTranscriptWord } from '../services/cleanup.js';

export interface ToolContext {
  projectId: string;
  projects: ProjectStore;
  assets: AssetStore;
  styleDoc: string | null;
  currentVersion: number;
  transcripts: TranscriptService;
  insights: InsightService;
  dissections?: DissectService;
  appliedOperations?: Operation[];
  /** Checkpoint id for the whole turn — stamped on every operation it logs. */
  runId?: string;
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
  clipId: z.string().min(1).optional(),
  clipIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  wordsPerChunk: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
  style: captionStyleSchema.optional(),
  preset: presetSchema.shape.name.optional(),
}).strict().refine((value) => Boolean(value.clipId) !== Boolean(value.clipIds), {
  message: 'Provide exactly one of clipId or clipIds',
});

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
const cutToBeatsSchema = z.object({
  clipId: z.string().min(1),
  maxCuts: z.number().int().min(1).max(30).default(12),
}).strict();
const presetNameSchema = z.object({ name: presetSchema.shape.name }).strict();
/**
 * Either a built-in id or a whole packet inline — a look derived from a saved
 * style profile or a dissected reference is a packet like any other, it just
 * has no entry in the built-in table.
 */
const applyPacketSchema = z.object({
  packetId: z.string().min(1).optional(),
  packet: stylePacketSchema.optional(),
}).strict();

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
    ...(clip.transformEnd ? { transformEnd: clip.transformEnd } : {}),
    ...(clip.overlay ? { overlay: clip.overlay } : {}),
    ...(clip.transition ? { transition: clip.transition } : {}),
    ...(clip.duck ? { duck: true } : {}),
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
  // Structural comparison catches top-level changes (format, duration) that the
  // clip diff above cannot see; a batch tool with nothing to do lands here too.
  const changedDoc = JSON.stringify({ ...before, version: 0 }) !== JSON.stringify({ ...after, version: 0 });
  const didChange = changed.length > 0 || removedClipIds.length > 0 || shifts.size > 0 || changedDoc;
  if (!didChange) notes.push('No change: the project already matched this request.');
  return {
    ok: true,
    changed: didChange,
    version: after.version,
    changedClips: changed.slice(0, 20),
    removedClipIds,
    shifted: [...shifts.values()].sort((left, right) => left.trackId.localeCompare(right.trackId) || left.fromSec - right.fromSec),
    notes,
  };
}

// Keyed by the catalog, not by Operation['type']: revert_run is an operation
// the client issues, never a tool the agent may call.
const operationDescriptions: Record<(typeof OPERATION_CATALOG)[number], string> = {
  add_clip: 'Add a media clip to a video, audio, or overlay track. assetId must come from list_assets and clip.id must be unique; use readable IDs such as clip-hook-1. clip.in and clip.out are source-time seconds, clip.start is an absolute timeline second, and timeline duration is (out-in)/speed. Overlay-track stickers use trackId `overlays` with in=0 and out=<display seconds>, plus either an image assetId or emoji `text`, and an optional `overlay` placement {x,y,width,rotation}.',
  remove_clip: 'Remove a non-caption clip by its unique clipId.',
  split_clip: 'Split a clip at an absolute timeline second `at` strictly inside the clip. Optionally provide a unique readable newClipId for the right-hand clip. This is timeline time, not source time.',
  trim_clip: 'Change a clip source range. `in` and `out` are source-time seconds and out must remain greater than in. Timeline duration becomes (out-in)/speed.',
  move_clip: 'Move a clip so `start` is an absolute timeline second. An optional trackId may move it only to another track of the same kind.',
  reorder_clips: 'Reorder every clip in a track. clipIds must contain each current clip ID exactly once; the operation lays clips sequentially from timeline second 0.',
  set_volume: 'Set a clip volume from 0 (silent) to 1 (full volume).',
  set_speed: 'Set playback speed as a 0.1–8 multiplier. Timeline duration is (out-in)/speed, so 1.25 is 25% faster.',
  set_transform: 'Set a clip crop/zoom pose: scale 1–10 (values under 1 render as 1), x -1–1, and y -1–1. Supplying transformEnd animates linearly from transform to transformEnd across the clip — the dynamic-zoom primitive. A tasteful punch-in goes from scale 1 to 1.08–1.15; omit transformEnd to clear any zoom.',
  set_overlay: 'Reposition an overlay-track sticker: x/y are the sticker centre as 0–1 fractions of the frame, width is the sticker width as a 0.04–1 fraction of frame width, rotation is clockwise degrees.',
  set_transition: 'Set or clear (transition: null) the transition INTO a video-track clip at its start. `crossfade` overlaps the previous clip by borrowing source frames past its out point — timeline positions never move; `dip` fades through black around the cut. duration 0.1–2s (0.3–0.5 reads snappy). For a whoosh-cut, keep the hard cut and add a whoosh from the sound library at the cut instead.',
  add_caption: 'Add a timed caption. Use a unique readable clip.id, absolute timeline seconds for clip.start, and a caption-local range where clip.in is normally 0 and clip.out is its duration. Prefer trackId `captions`; style supports font, size, color, position, and emphasis.',
  update_caption: 'Update an existing caption by clipId. start is an absolute timeline second; in/out are caption-local seconds and out must remain greater than in.',
  remove_caption: 'Remove an existing caption by its clipId.',
  ripple_delete_ranges: 'Atomically delete and close multiple absolute timeline ranges on one video/audio track. Overlaps are merged; intersecting clips are split or trimmed, later clips shift left, and captions are cut and shifted with the deleted time.',
  set_clip_properties: 'Atomically batch-update 1-100 clips — the preferred way to trim or retime many clips at once. Each update names clipId and one or more of volume, speed, transform, absolute timeline start, source-time in/out (out must stay greater than in), or duck (true ducks all other audio beneath this clip while it plays — the voiceover treatment). Any invalid update rejects the entire operation.',
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
  let versionBefore = ctx.currentVersion;
  try {
    project = ctx.projects.applyOperations(ctx.projectId, operations, ctx.currentVersion, ctx.runId);
  } catch (error) {
    if (!(error instanceof VersionConflictError)) throw error;
    ctx.currentVersion = error.actual;
    versionBefore = error.actual;
    project = ctx.projects.applyOperations(ctx.projectId, operations, ctx.currentVersion, ctx.runId);
  }
  ctx.currentVersion = project.version;
  // The store leaves the version alone when a write changed nothing. Recording such
  // an operation would give the client a receipt chip and a revert for a non-edit.
  if (project.version !== versionBefore) ctx.appliedOperations?.push(...operations);
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

/**
 * Cache read that falls back to running transcription on demand. A failed
 * import-time transcription never writes to the store, so this call doubles as
 * the retry; TranscriptService dedupes concurrent runs per asset.
 */
async function ensureTranscript(ctx: ToolContext, assetId: string): Promise<StoredTranscript | { error: string }> {
  const cached = ctx.transcripts.get(assetId);
  if (cached) return cached;
  const asset = ctx.assets.get(assetId);
  if (!asset) return { error: `Asset ${assetId} was not found` };
  if (!asset.hasAudio) return { error: `Asset ${assetId} has no audio to transcribe` };
  try {
    return await ctx.transcripts.transcribe(asset);
  } catch (error) {
    return { error: `Transcription failed for asset ${assetId}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function captionClipFromTranscript(ctx: ToolContext, rawInput: unknown): Promise<unknown> {
  try {
    const input = captionFromTranscriptSchema.parse(rawInput);
    const clipIds = input.clipIds ?? [input.clipId as string];
    if (clipIds.length === 1) return await captionOneClip(ctx, clipIds[0] as string, input);
    const results = [];
    let captionsAdded = 0;
    for (const clipId of clipIds) {
      const result = await captionOneClip(ctx, clipId, input);
      const record = result as { ok?: boolean; error?: string; captionsAdded?: number };
      captionsAdded += record.captionsAdded ?? 0;
      results.push(record.ok === false ? { clipId, ok: false, error: record.error } : { clipId, ok: true, captionsAdded: record.captionsAdded ?? 0 });
    }
    const failed = results.filter((result) => result.ok === false);
    return {
      ok: failed.length === 0,
      ...(failed.length ? { error: `${failed.length} of ${clipIds.length} clips failed; see results` } : {}),
      captionsAdded,
      version: ctx.currentVersion,
      results,
    };
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

async function captionOneClip(
  ctx: ToolContext,
  clipId: string,
  input: Omit<z.infer<typeof captionFromTranscriptSchema>, 'clipId' | 'clipIds'>,
): Promise<unknown> {
  try {
    const project = requireProject(ctx);
    const videoClip = project.tracks.filter((track) => track.kind === 'video')
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === clipId);
    if (!videoClip) return { ok: false, error: `Video clip ${clipId} was not found` };
    if (!videoClip.assetId) return { ok: false, error: `Video clip ${clipId} has no asset` };
    const transcript = await ensureTranscript(ctx, videoClip.assetId);
    if ('error' in transcript) return { ok: false, error: transcript.error };

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
      const timelineTokens = transcript.words.map((word) => normalizeWord(word.text));
      for (const match of input.matches ?? []) {
        const phrase = match.split(/\s+/).map(normalizeWord).filter(Boolean);
        if (!phrase.length) continue;
        for (let start = 0; start + phrase.length <= timelineTokens.length; start += 1) {
          if (phrase.every((token, offset) => timelineTokens[start + offset] === token)) {
            for (let offset = 0; offset < phrase.length; offset += 1) selected.add(start + offset);
          }
        }
      }
    }
    if (!selected.size) return { ...createMutationDelta(project, project, ['No matching timeline words were found.']), wordsRemoved: 0 };

    const tracks = planWordRemovalRanges(project, transcript.words, selected, input.keptGapMs);
    const operations: Operation[] = [...tracks].map(([trackId, ranges]) =>
      operationSchema.parse({ type: 'ripple_delete_ranges', params: { trackId, ranges } }));
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
    const { rangesByTrack, gapsCut, gapsProtected } = await planSilenceRanges(project, timeline.words, ctx, input);
    const operations = [...rangesByTrack].filter(([, ranges]) => ranges.length).map(([trackId, ranges]) =>
      operationSchema.parse({ type: 'ripple_delete_ranges', params: { trackId, ranges } }));
    const merged = [...rangesByTrack.values()].flat();
    const removedSec = merged.reduce((total, range) => total + range.end - range.start, 0);
    if (!operations.length) return { ...createMutationDelta(project, project), removedSec: 0, gapsCut, gapsProtected };
    const after = applyMany(ctx, operations);
    return { ...createMutationDelta(project, after), removedSec, gapsCut, gapsProtected };
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) return { ok: false, error: error.message };
    throw error;
  }
}

/** A cut this close to a clip edge — or to the previous cut — reads as a stutter, not a beat. */
const BEAT_MIN_SPACING_SEC = 0.25;

async function cutToBeats(ctx: ToolContext, rawInput: unknown): Promise<unknown> {
  try {
    const input = cutToBeatsSchema.parse(rawInput);
    const project = requireProject(ctx);
    const clip = project.tracks.filter((track) => track.kind === 'video')
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === input.clipId);
    if (!clip) return { ok: false, error: `Video clip ${input.clipId} was not found` };
    if (!clip.assetId) return { ok: false, error: `Video clip ${input.clipId} has no asset` };
    if (!ctx.dissections) return { ok: false, error: 'Dissection service is not available' };
    const asset = ctx.assets.get(clip.assetId);
    if (!asset) return { ok: false, error: `Asset ${clip.assetId} was not found` };
    // Same path as dissect_asset: an unmeasured asset gets measured here (slow once, then cached).
    const dissection = await ctx.dissections.getOrCreate(asset);

    const speed = clip.speed ?? 1;
    const end = clip.start + clipTimelineDuration(clip);
    const spaced: number[] = [];
    for (const peak of [...dissection.energyPeaks].sort((left, right) => left - right)) {
      if (peak <= clip.in || peak >= clip.out) continue;
      const at = Number((clip.start + (peak - clip.in) / speed).toFixed(6));
      if (at - clip.start < BEAT_MIN_SPACING_SEC || end - at < BEAT_MIN_SPACING_SEC) continue;
      if (at - (spaced.at(-1) ?? Number.NEGATIVE_INFINITY) < BEAT_MIN_SPACING_SEC) continue;
      spaced.push(at);
    }
    // Thinning rule: keep every Nth beat rather than ranking peak strength.
    // energyPeaks carries no amplitude, so "strongest" would be invented; an
    // even stride keeps the cuts spread across the whole clip.
    const stride = Math.max(1, Math.ceil(spaced.length / input.maxCuts));
    const cutTimes = spaced.filter((_unused, index) => index % stride === 0);
    if (!cutTimes.length) {
      return { ...createMutationDelta(project, project, [`No usable audio onsets inside ${clip.id}.`]), cutTimes: [] };
    }

    // Descending: each split leaves the left-hand piece under the original id,
    // so every earlier cut point is still inside `clip.id` when its turn comes.
    const operations = [...cutTimes].reverse().map((at, index) => operationSchema.parse({
      type: 'split_clip',
      params: { clipId: clip.id, at, newClipId: `${clip.id}-beat-${cutTimes.length - index}` },
    }));
    const after = applyMany(ctx, operations);
    const notes = spaced.length > cutTimes.length
      ? [`Thinned ${spaced.length} onsets to ${cutTimes.length} by keeping 1 in every ${stride}.`]
      : [];
    return { ...createMutationDelta(project, after, notes), cutTimes, tempoBpm: dissection.tempoBpm };
  } catch (error) {
    if (error instanceof OperationError || error instanceof ZodError || error instanceof VersionConflictError) return { ok: false, error: error.message };
    throw error;
  }
}

/** A hit this close to a cut is the same hit — a re-apply must not stack SFX. */
const SFX_DEDUPE_SEC = 0.15;
/** Trailing sliver of music shorter than this is not worth a clip. */
const BED_MIN_TILE_SEC = 0.01;

/**
 * Ids for the clips a packet sweep mints. Skipping ids already on the timeline
 * keeps a second packet from colliding with the first one's bed or cut SFX — an
 * add_clip id clash would reject the whole atomic batch.
 */
function createIdAllocator(project: Project): (prefix: string) => string {
  const taken = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const counters = new Map<string, number>();
  return (prefix) => {
    let next = counters.get(prefix) ?? 0;
    let id: string;
    do { next += 1; id = `${prefix}-${next}`; } while (taken.has(id));
    counters.set(prefix, next);
    taken.add(id);
    return id;
  };
}

/** Resolve a library sound, synthesizing the library once if it was never generated. */
async function resolveSound(ctx: ToolContext, soundId: string): Promise<StoredAsset | undefined> {
  const existing = ctx.assets.get(soundId);
  if (existing) return existing;
  await ensureSoundLibrary(ctx.assets);
  return ctx.assets.get(soundId);
}

async function applyStylePacket(ctx: ToolContext, rawInput: unknown): Promise<unknown> {
  try {
    const input = applyPacketSchema.parse(rawInput);
    const packet = input.packet ?? (input.packetId ? PACKETS_BY_ID.get(input.packetId) : undefined);
    if (!packet) {
      const ids = STYLE_PACKETS.map((candidate) => candidate.id).join(', ');
      return {
        ok: false,
        error: input.packetId
          ? `Unknown style packet ${input.packetId}. Valid ids: ${ids}`
          : `Pass packetId (one of: ${ids}) or an inline packet object.`,
      };
    }
    const project = requireProject(ctx);
    const { typography, zoom } = packet;
    const nextId = createIdAllocator(project);
    const operations: Operation[] = [];
    const notes: string[] = [];
    const guidance: string[] = [];

    // Typography. update_caption REPLACES the style object, so the merge starts
    // from the clip's own style — that is what carries `words`, and losing it
    // would silently destroy karaoke timing.
    const captions = project.tracks.filter((track) => track.kind === 'caption').flatMap((track) => track.clips);
    for (const caption of captions) {
      const style = captionStyleSchema.parse({
        ...caption.style,
        font: 'Montserrat',
        sizePct: typography.sizePct,
        color: typography.color,
        emphasisColor: typography.emphasisColor,
        strokeColor: typography.strokeColor,
        strokePx: typography.strokePx,
        anchorPct: typography.anchorPct,
        emphasis: typography.emphasis,
      });
      operations.push(operationSchema.parse({
        type: 'update_caption',
        params: {
          clipId: caption.id,
          ...(caption.text ? { text: typography.uppercase ? caption.text.toUpperCase() : caption.text } : {}),
          style,
        },
      }));
    }

    const videoTrack = project.tracks.find((track) => track.kind === 'video');
    const videoClips = [...(videoTrack?.clips ?? [])].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
    const videoEnd = videoClips.reduce((end, clip) => Math.max(end, clip.start + clipTimelineDuration(clip)), 0);
    const audioTrack = project.tracks.find((track) => track.kind === 'audio');
    // add_clip only auto-creates the `overlays` track, so without an audio track
    // there is nowhere to put a bed or a cut hit.
    if (!audioTrack && (packet.music.soundId || packet.transition.soundId)) {
      guidance.push('This project has no audio track, so the music bed and cut SFX were skipped — add_clip cannot create one. Add an audio track to the project, then re-apply the packet.');
    }

    // Music bed, tiled back-to-back under the video.
    if (audioTrack && packet.music.soundId && videoEnd > 0) {
      const bed = await resolveSound(ctx, packet.music.soundId);
      if (!bed?.duration) notes.push(`Music bed skipped — sound ${packet.music.soundId} is unavailable.`);
      else if (audioTrack.clips.some((clip) => clip.assetId === bed.id)) {
        notes.push(`Music bed skipped — ${bed.id} is already on ${audioTrack.id}.`);
      } else {
        ctx.assets.link(ctx.projectId, bed.id);
        for (let cursor = 0; videoEnd - cursor > BED_MIN_TILE_SEC; cursor += bed.duration) {
          operations.push(operationSchema.parse({
            type: 'add_clip',
            params: {
              trackId: audioTrack.id,
              clip: {
                id: nextId('music-bed'), assetId: bed.id, start: cursor, in: 0,
                out: Math.min(bed.duration, videoEnd - cursor), volume: packet.music.volume,
              },
            },
          }));
        }
      }
    }

    // Transitions at every adjacent cut, plus the packet's cut hit.
    const cutStarts: number[] = [];
    for (const [index, clip] of videoClips.entries()) {
      const previous = videoClips[index - 1];
      if (!previous) continue;
      const previousEnd = previous.start + clipTimelineDuration(previous);
      if (Math.abs(clip.start - previousEnd) > 1 / project.fps) continue;
      operations.push(operationSchema.parse({
        type: 'set_transition',
        params: {
          clipId: clip.id,
          transition: packet.transition.type === 'cut'
            ? null
            : { type: packet.transition.type, duration: packet.transition.duration },
        },
      }));
      cutStarts.push(clip.start);
    }

    if (audioTrack && packet.transition.soundId && cutStarts.length) {
      const sfx = await resolveSound(ctx, packet.transition.soundId);
      if (!sfx?.duration) notes.push(`Cut SFX skipped — sound ${packet.transition.soundId} is unavailable.`);
      else {
        ctx.assets.link(ctx.projectId, sfx.id);
        const placed = audioTrack.clips.filter((clip) => clip.assetId === sfx.id).map((clip) => clip.start);
        let added = 0;
        for (const at of cutStarts) {
          if (placed.some((existing) => Math.abs(existing - at) <= SFX_DEDUPE_SEC)) continue;
          operations.push(operationSchema.parse({
            type: 'add_clip',
            params: {
              trackId: audioTrack.id,
              clip: {
                id: nextId('sfx-cut'), assetId: sfx.id, start: at, in: 0,
                out: sfx.duration, volume: packet.transition.soundVolume,
              },
            },
          }));
          added += 1;
        }
        if (added < cutStarts.length) notes.push(`${cutStarts.length - added} cut(s) already carried a ${sfx.id} hit.`);
      }
    }

    // Punch-in cadence. An existing transformEnd is a deliberate move — leave it.
    if (zoom.cadence !== 'off') {
      for (const [index, clip] of videoClips.entries()) {
        if (zoom.cadence === 'sparse' && index % 3 !== 0) continue;
        if (clip.transformEnd) continue;
        operations.push(operationSchema.parse({
          type: 'set_transform',
          params: {
            clipId: clip.id,
            transform: { scale: 1, x: 0, y: 0 },
            transformEnd: { scale: zoom.scale, x: 0, y: 0 },
          },
        }));
      }
    }

    // The creative half: what the packet wants that only judgment can place.
    const missingWords = captions.filter((caption) => !caption.style?.words?.length).length;
    if (typography.karaoke && missingWords) {
      guidance.push(`Karaoke is part of this look but ${missingWords} caption clip(s) carry no word timings — run caption_clip_from_transcript with wordsPerChunk 3 on the source video clips, then re-apply this packet.`);
    }
    if (packet.callouts.density !== 'off') {
      const cadence = packet.callouts.density === 'every-line' ? 'roughly one per caption line' : 'roughly one per scene';
      guidance.push(`Callouts (${packet.callouts.density} — ${cadence}): add_clip on trackId 'overlays' with the callout line as clip.text, callout: {variant: 'check' | 'x' | 'card'}, and overlay: {x: 0.5, y: 0.3, width: 0.56, rotation: 0}; in: 0 and out: the seconds it holds. Use 'check' for the right way (${packet.colors.good ?? packet.colors.accent}), 'x' for the wrong way (${packet.colors.bad ?? packet.colors.accent}), and 'card' for a neutral card (${packet.colors.accent}).`);
    }
    if (packet.broll.density !== 'off') {
      const cadence = packet.broll.density === 'frequent' ? 'a cutaway every few shots' : 'only where the words name something visual';
      guidance.push(`B-roll (${packet.broll.density} — ${cadence}): cover narration moments with full-frame overlay clips — add_clip on trackId 'overlays' with a video assetId from list_assets, overlay: {x: 0.5, y: 0.5, width: 1, rotation: 0}, in: the source second to start from, and out: in plus the cutaway seconds.`);
    }
    const averageShot = videoClips.length ? videoEnd / videoClips.length : 0;
    const target = packet.pacing.targetShotSeconds;
    if (target && averageShot > target * 1.5) {
      guidance.push(`Pacing: shots average ${averageShot.toFixed(1)}s against this look's ${target}s target — tighten with cut_to_beats on the long clips, or split_clip plus trim_clip, until the average lands near ${target}s.`);
    }

    const after = operations.length ? applyMany(ctx, operations) : project;
    return { ...createMutationDelta(project, after, notes), guidance };
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
      description: 'List this project\'s media assets, the only ones you may cut with. Use an asset id from this result as add_clip.assetId. Duration is source-time seconds.',
      schema: emptyInputSchema,
      execute: async (ctx, input) => {
        emptyInputSchema.parse(input);
        // Scoped to the project: another project's footage is not yours to cut.
        return ctx.assets.listForProject(ctx.projectId).map(({ id, originalName, label, duration, width, height, hasAudio, mimeType }) => ({
          id, originalName, label, duration, width, height, hasAudio, mimeType,
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
      description: 'Get an asset transcript by assetId, transcribing on demand when none is stored yet (this can take a while for long media). Returns language, segments, wordCount, and compact word tuples [word, sourceStartSeconds, sourceEndSeconds]. Use source timestamps for trims.',
      schema: assetInputSchema,
      execute: async (ctx, input) => {
        const { assetId } = assetInputSchema.parse(input);
        const transcript = await ensureTranscript(ctx, assetId);
        if ('error' in transcript) return { ok: false, error: transcript.error };
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
        const transcript = await ensureTranscript(ctx, assetId);
        if ('error' in transcript) return { ok: false, error: transcript.error };
        const result = await ctx.insights.getOrCreate(asset);
        return result ?? { ok: false, error: `No transcript for asset ${assetId}` };
      },
    },
    {
      name: 'caption_clip_from_transcript',
      description: 'Replace generated captions for video clips using their asset transcripts, transcribing missing ones on demand. Pass clipId for one clip or clipIds for up to 100 in one call — always prefer clipIds when captioning several clips. wordsPerChunk is 1-4 (default 3). Source word times are mapped through clip.in, clip.start, and speed to absolute timeline seconds. Default captions are uppercase Montserrat Bold, size 64, white, and bottom-positioned.',
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
      name: 'dissect_asset',
      description: 'Measure a source video with ffmpeg only: scene-cut timestamps and cadence, audio energy curve and onset peaks, estimated tempo BPM, loudness, and spans where burned-in text/graphics sit (top/bottom zones). Use it to mirror a reference video\'s rhythm — cut on its cadence, land edits on its energy peaks. All times are source seconds. Slow on first call; cached afterwards.',
      schema: assetInputSchema,
      execute: async (ctx, input) => {
        const { assetId } = assetInputSchema.parse(input);
        const asset = ctx.assets.get(assetId);
        if (!asset) return { ok: false, error: `Asset ${assetId} was not found` };
        if (!ctx.dissections) return { ok: false, error: 'Dissection service is not available' };
        const dissection = await ctx.dissections.getOrCreate(asset);
        // Compact for the context window: cuts and peaks rounded, energy kept coarse.
        return {
          ...dissection,
          cuts: dissection.cuts.map((cut) => Math.round(cut * 100) / 100),
          energy: { cellSeconds: dissection.energy.cellSeconds, rmsDb: dissection.energy.rmsDb.map((db) => Math.round(db)) },
        };
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
    {
      name: 'get_style_packets',
      description: 'List the built-in style packets — a creator\'s repeatable look captured as data: typography, colour system, music bed, transition habit, punch-in cadence, and callout/b-roll density. Read one before calling apply_style_packet.',
      schema: emptyInputSchema,
      execute: async (_ctx, input) => {
        emptyInputSchema.parse(input);
        return STYLE_PACKETS;
      },
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
      name: 'cut_to_beats',
      description: 'Split one video clip on its measured audio onsets so the cuts land on the beat — the montage-pacing primitive. Beats come from the asset dissection (computed on first use, cached after); cuts stay at least 0.25s from the clip edges and from each other, and maxCuts (default 12, max 30) thins them evenly across the clip. Right-hand pieces are named <clipId>-beat-1..N left to right. Follow with reorder_clips, trim_clip, or set_speed to shape the rhythm.',
      schema: cutToBeatsSchema,
      execute: cutToBeats,
    },
    {
      name: 'apply_style_packet',
      description: 'Apply one style packet — either `packetId` for a built-in from get_style_packets, or a whole `packet` object inline (the shape get_style_packets returns; that is how a look derived from the user\'s style profile or a dissected reference arrives, usually pasted into the message). Runs in one atomic batch: restyle every caption to its typography (karaoke word timings are preserved), tile its music bed under the video, set its transition and cut SFX at every adjacent cut, and set its punch-in cadence. Returns the timeline delta plus `guidance` — the creative half (callouts, b-roll, pacing) that you still have to author yourself.',
      schema: applyPacketSchema,
      execute: applyStylePacket,
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
