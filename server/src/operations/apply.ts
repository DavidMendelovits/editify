import { randomUUID } from 'node:crypto';
import {
  clipTimelineDuration,
  deriveProjectDuration,
  projectSchema,
  type Clip,
  type Operation,
  type Project,
  type Track,
} from '@editify/shared';

export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationError';
  }
}

function findClip(project: Project, clipId: string): { track: Track; clip: Clip; index: number } {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((candidate) => candidate.id === clipId);
    if (index >= 0) {
      const clip = track.clips[index];
      if (clip) return { track, clip, index };
    }
  }
  throw new OperationError(`Clip ${clipId} was not found`);
}

function findTrack(project: Project, trackId: string): Track {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new OperationError(`Track ${trackId} was not found`);
  return track;
}

function assertUniqueClipId(project: Project, clipId: string): void {
  if (project.tracks.some((track) => track.clips.some((clip) => clip.id === clipId))) {
    throw new OperationError(`Clip ${clipId} already exists`);
  }
}

function validateTrim(clip: Clip): void {
  if (clip.out <= clip.in) throw new OperationError('Clip out point must be after its in point');
}

export interface TimeRange { start: number; end: number }

export function mergeTimeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges.map((range) => ({ ...range })).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}

function removedBefore(ranges: TimeRange[], time: number): number {
  return ranges.reduce((total, range) => total + Math.max(0, Math.min(time, range.end) - range.start), 0);
}

function keptPieces(start: number, end: number, ranges: TimeRange[]): TimeRange[] {
  let cursor = start;
  const pieces: TimeRange[] = [];
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= end) break;
    if (range.start > cursor) pieces.push({ start: cursor, end: Math.min(range.start, end) });
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) break;
  }
  if (cursor < end) pieces.push({ start: cursor, end });
  return pieces.filter((piece) => piece.end > piece.start);
}

function rippleTrack(track: Track, ranges: TimeRange[], allClipIds: Set<string>): void {
  const next: Clip[] = [];
  for (const original of track.clips) {
    const speed = original.speed ?? 1;
    const timelineEnd = original.start + clipTimelineDuration(original);
    const pieces = keptPieces(original.start, timelineEnd, ranges);
    pieces.forEach((piece, pieceIndex) => {
      const sourceOffsetStart = (piece.start - original.start) * speed;
      const sourceOffsetEnd = (piece.end - original.start) * speed;
      let id = pieceIndex === 0 ? original.id : `${original.id}-ripple-${pieceIndex + 1}`;
      let suffix = pieceIndex + 1;
      while (pieceIndex > 0 && allClipIds.has(id)) id = `${original.id}-ripple-${++suffix}`;
      allClipIds.add(id);
      const words = original.style?.words?.filter((word) => word.s >= piece.start && word.s < piece.end)
        .map((word) => ({
          ...word,
          s: word.s - removedBefore(ranges, word.s),
          e: Math.min(word.e, piece.end) - removedBefore(ranges, Math.min(word.e, piece.end)),
        })).filter((word) => word.e > word.s);
      next.push({
        ...original,
        id,
        start: piece.start - removedBefore(ranges, piece.start),
        in: original.in + sourceOffsetStart,
        out: original.in + sourceOffsetEnd,
        ...(original.style ? { style: { ...original.style, ...(words ? { words } : {}) } } : {}),
      });
    });
  }
  track.clips = next.sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
}

export function applyOperation(input: Project, operation: Operation): Project {
  if (operation.type === 'undo') {
    throw new OperationError('Undo requires operation history and must be applied by ProjectStore');
  }

  const project = structuredClone(input);

  switch (operation.type) {
    case 'add_clip': {
      assertUniqueClipId(project, operation.params.clip.id);
      const track = findTrack(project, operation.params.trackId);
      if (track.kind === 'caption') throw new OperationError('Use add_caption for caption tracks');
      track.clips.push(operation.params.clip);
      break;
    }
    case 'remove_clip': {
      const { track, index } = findClip(project, operation.params.clipId);
      if (track.kind === 'caption') throw new OperationError('Use remove_caption for caption clips');
      track.clips.splice(index, 1);
      break;
    }
    case 'split_clip': {
      const { track, clip, index } = findClip(project, operation.params.clipId);
      const end = clip.start + clipTimelineDuration(clip);
      if (operation.params.at <= clip.start || operation.params.at >= end) {
        throw new OperationError(`Split point must be inside the clip (${clip.start}–${end})`);
      }
      const splitSourceTime = clip.in + (operation.params.at - clip.start) * (clip.speed ?? 1);
      const rightId = operation.params.newClipId ?? randomUUID();
      assertUniqueClipId(project, rightId);
      const right: Clip = { ...clip, id: rightId, start: operation.params.at, in: splitSourceTime };
      clip.out = splitSourceTime;
      track.clips.splice(index + 1, 0, right);
      break;
    }
    case 'trim_clip': {
      const { clip } = findClip(project, operation.params.clipId);
      if (operation.params.in !== undefined) clip.in = operation.params.in;
      if (operation.params.out !== undefined) clip.out = operation.params.out;
      validateTrim(clip);
      break;
    }
    case 'move_clip': {
      const found = findClip(project, operation.params.clipId);
      found.clip.start = operation.params.start;
      if (operation.params.trackId && operation.params.trackId !== found.track.id) {
        const destination = findTrack(project, operation.params.trackId);
        if (destination.kind !== found.track.kind) throw new OperationError('Clips can only move between tracks of the same kind');
        found.track.clips.splice(found.index, 1);
        destination.clips.push(found.clip);
      }
      break;
    }
    case 'reorder_clips': {
      const track = findTrack(project, operation.params.trackId);
      const existingIds = new Set(track.clips.map((clip) => clip.id));
      if (operation.params.clipIds.length !== track.clips.length || operation.params.clipIds.some((id) => !existingIds.has(id))) {
        throw new OperationError('clipIds must contain every clip on the track exactly once');
      }
      if (new Set(operation.params.clipIds).size !== operation.params.clipIds.length) {
        throw new OperationError('clipIds contains duplicates');
      }
      const byId = new Map(track.clips.map((clip) => [clip.id, clip]));
      track.clips = operation.params.clipIds.map((id) => byId.get(id) as Clip);
      let cursor = 0;
      for (const clip of track.clips) {
        clip.start = cursor;
        cursor += clipTimelineDuration(clip);
      }
      break;
    }
    case 'set_volume': {
      findClip(project, operation.params.clipId).clip.volume = operation.params.volume;
      break;
    }
    case 'set_speed': {
      findClip(project, operation.params.clipId).clip.speed = operation.params.speed;
      break;
    }
    case 'set_transform': {
      findClip(project, operation.params.clipId).clip.transform = operation.params.transform;
      break;
    }
    case 'add_caption': {
      assertUniqueClipId(project, operation.params.clip.id);
      let track = project.tracks.find((candidate) => candidate.id === operation.params.trackId);
      if (!track) {
        track = { id: operation.params.trackId, kind: 'caption', clips: [] };
        project.tracks.push(track);
      }
      if (track.kind !== 'caption') throw new OperationError('Caption clips require a caption track');
      track.clips.push(operation.params.clip);
      break;
    }
    case 'update_caption': {
      const { track, clip } = findClip(project, operation.params.clipId);
      if (track.kind !== 'caption') throw new OperationError('update_caption only accepts caption clips');
      const { clipId: _clipId, ...updates } = operation.params;
      Object.assign(clip, updates);
      validateTrim(clip);
      break;
    }
    case 'remove_caption': {
      const { track, index } = findClip(project, operation.params.clipId);
      if (track.kind !== 'caption') throw new OperationError('remove_caption only accepts caption clips');
      track.clips.splice(index, 1);
      break;
    }
    case 'ripple_delete_ranges': {
      const target = findTrack(project, operation.params.trackId);
      if (target.kind === 'caption') throw new OperationError('ripple_delete_ranges requires a video or audio track');
      const ranges = mergeTimeRanges(operation.params.ranges);
      const allClipIds = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
      rippleTrack(target, ranges, allClipIds);
      for (const track of project.tracks.filter((candidate) => candidate.kind === 'caption')) {
        rippleTrack(track, ranges, allClipIds);
      }
      break;
    }
    case 'set_clip_properties': {
      const resolved = operation.params.updates.map((update) => ({ update, clip: findClip(project, update.clipId).clip }));
      for (const { update, clip } of resolved) {
        if (update.volume !== undefined) clip.volume = update.volume;
        if (update.speed !== undefined) clip.speed = update.speed;
        if (update.transform !== undefined) clip.transform = update.transform;
        if (update.start !== undefined) clip.start = update.start;
        validateTrim(clip);
      }
      break;
    }
    case 'set_format': {
      project.format = operation.params.format;
      break;
    }
  }

  project.version += 1;
  project.duration = deriveProjectDuration(project);
  return projectSchema.parse(project);
}
