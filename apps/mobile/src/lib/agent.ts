/**
 * Local mirror of the agent-loop contract (SPEC-AGENT.md §A2/§B).
 *
 * These types intentionally live in `apps/mobile` rather than `@editify/shared`
 * so the UI stays decoupled from the server package while the agent loop lands.
 * Everything the agent hands back is treated as untrusted shape: `input` is
 * `unknown` and every read goes through a narrowing helper.
 */

import { presetTitle } from './presets';

export interface AgentTraceStep {
  /** 'thought' steps carry the agent's own reasoning text in `summary`. */
  kind?: 'thought';
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
}

/** Visual family for a step — drives the glyph and tint in the step feed. */
export type TraceKind =
  | 'thought'
  | 'read' | 'transcript' | 'insight' | 'preset'
  | 'add' | 'remove' | 'cut' | 'move' | 'batch'
  | 'audio' | 'speed' | 'frame' | 'caption' | 'format' | 'undo' | 'other';

const TOOL_KIND: Record<string, TraceKind> = {
  get_project: 'read',
  list_assets: 'read',
  get_style_profile: 'read',
  // Wave 2 read tools — transcript space, insights and presets (SPEC-WAVE2 §C/§D).
  get_transcript: 'transcript',
  get_timeline_transcript: 'transcript',
  get_insights: 'insight',
  list_presets: 'preset',
  get_preset: 'preset',
  add_clip: 'add',
  add_clips: 'add',
  remove_clip: 'remove',
  remove_words: 'remove',
  split_clip: 'cut',
  split_clips: 'cut',
  trim_clip: 'cut',
  ripple_delete_ranges: 'cut',
  move_clip: 'move',
  reorder_clips: 'move',
  close_gaps: 'move',
  set_clip_properties: 'batch',
  set_volume: 'audio',
  remove_silence: 'audio',
  set_speed: 'speed',
  set_transform: 'frame',
  add_caption: 'caption',
  update_caption: 'caption',
  remove_caption: 'caption',
  caption_clip_from_transcript: 'caption',
  set_format: 'format',
  undo: 'undo',
};

const KIND_GLYPH: Record<TraceKind, string> = {
  thought: '✻',
  read: '◎',
  transcript: '¶',
  insight: '★',
  preset: '◆',
  add: '+',
  remove: '×',
  cut: '/',
  move: '⇄',
  batch: '≡',
  audio: '♪',
  speed: '◔',
  frame: '⤢',
  caption: 'T',
  format: '▣',
  undo: '↺',
  other: '•',
};

/** Kinds that only observe the project — rendered muted in the step feed. */
const READ_KINDS: ReadonlySet<TraceKind> = new Set<TraceKind>(['thought', 'read', 'transcript', 'insight', 'preset']);

/** Warning glyph used for any step that came back `ok: false`. */
export const ERROR_GLYPH = '!';

export function traceKind(step: AgentTraceStep): TraceKind {
  if (step.kind === 'thought') return 'thought';
  return TOOL_KIND[step.tool] ?? 'other';
}

export function traceGlyph(step: AgentTraceStep): string {
  if (!step.ok) return ERROR_GLYPH;
  return KIND_GLYPH[traceKind(step)];
}

/** Read tools observe the project; everything else mutates it. */
export function isReadStep(step: AgentTraceStep): boolean {
  return READ_KINDS.has(traceKind(step));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Tool inputs are the operation's `params` object. Some providers echo the full
 * `{type, params}` operation instead, so unwrap that shape when we see it.
 */
function toolInput(step: AgentTraceStep): Record<string, unknown> {
  const raw = asRecord(step.input);
  const params = raw['params'];
  return typeof params === 'object' && params !== null ? params as Record<string, unknown> : raw;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function seconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`;
}

/**
 * Batch tools report their counts in the *result*, which the trace does not
 * carry — but the server's own summary line does ("cut 3 gaps"). Pull the
 * number out of it when it is there rather than inventing one.
 */
function countInSummary(step: AgentTraceStep, pattern: RegExp): number | undefined {
  const match = pattern.exec(step.summary);
  const value = match?.[1];
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Total seconds covered by a `[{start, end}]` range list. */
function totalRangeSeconds(ranges: unknown[]): number {
  return ranges.reduce<number>((total, range) => {
    const record = asRecord(range);
    const start = asNumber(record['start']);
    const end = asNumber(record['end']);
    return start !== undefined && end !== undefined && end > start ? total + (end - start) : total;
  }, 0);
}

/** `remove_words` takes `[index | [from, to]]`; count the words that covers. */
function countWordIndexes(value: unknown): number | undefined {
  const entries = asArray(value);
  if (!entries) return undefined;
  return entries.reduce<number>((total, entry) => {
    if (typeof entry === 'number') return total + 1;
    const span = asArray(entry);
    const from = asNumber(span?.[0]);
    const to = asNumber(span?.[1]);
    return from !== undefined && to !== undefined && to >= from ? total + (to - from + 1) : total;
  }, 0);
}

/** `video-main` → `video track`, so gap-hygiene steps read like sentences. */
function trackLabel(trackId: string): string {
  const words = trackId.replace(/-(main|\d+)$/, '').replaceAll('-', ' ').trim().toLowerCase();
  if (words.length === 0) return 'the track';
  return words.endsWith('track') ? words : `${words} track`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clipRef(input: Record<string, unknown>): string {
  return asText(input['clipId']) ?? 'a clip';
}

export function humanizeToolName(tool: string): string {
  const words = tool.replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Human-readable one-liner for a step, e.g. "Split clip at 4.2s". */
export function describeTraceStep(step: AgentTraceStep): string {
  if (step.kind === 'thought') return step.summary;
  // A step that changed nothing must not be labelled from its request: the
  // server already reported the truth, so show that instead of "Updated 3 clips".
  if (step.summary.startsWith('No change')) return 'No change: the project already matched this request';
  const input = toolInput(step);
  switch (step.tool) {
    case 'get_project':
      return 'Read the project timeline';
    case 'list_assets':
      return 'Listed the media library';
    case 'get_style_profile':
      return 'Read the style profile';
    case 'get_transcript':
      return 'Read the source transcript';
    case 'get_timeline_transcript':
      return 'Read the timeline transcript';
    case 'get_insights':
      return 'Read the hook and highlights';
    case 'list_presets':
      return 'Listed the editing presets';
    case 'get_preset': {
      const name = asText(input['name']);
      return name ? `Loaded the ${presetTitle(name)} preset` : 'Loaded an editing preset';
    }
    case 'add_clip': {
      const start = asNumber(asRecord(input['clip'])['start']);
      return start === undefined ? 'Added a clip' : `Added clip at ${seconds(start)}`;
    }
    case 'add_clips': {
      const clips = asArray(input['clips']);
      return clips ? `Added ${plural(clips.length, 'clip')}` : 'Added clips';
    }
    case 'remove_clip':
      return `Removed ${clipRef(input)}`;
    case 'split_clip': {
      const at = asNumber(input['at']);
      return at === undefined ? `Split ${clipRef(input)}` : `Split clip at ${seconds(at)}`;
    }
    case 'split_clips': {
      const cuts = asArray(input['cuts']);
      return cuts ? `Made ${plural(cuts.length, 'cut')}` : 'Split several clips';
    }
    case 'ripple_delete_ranges': {
      const ranges = asArray(input['ranges']);
      if (!ranges || ranges.length === 0) return 'Rippled out a range';
      const total = totalRangeSeconds(ranges);
      return total > 0
        ? `Rippled out ${plural(ranges.length, 'range')} (${seconds(total)})`
        : `Rippled out ${plural(ranges.length, 'range')}`;
    }
    case 'remove_words': {
      const matches = asArray(input['matches'])?.flatMap((value) => {
        const text = asText(value);
        return text ? [text] : [];
      });
      if (matches && matches.length > 0) {
        return `Removed ${matches.slice(0, 3).map((word) => `“${word}”`).join(', ')}${matches.length > 3 ? '…' : ''}`;
      }
      const count = countWordIndexes(input['wordIndexes']);
      return count === undefined ? 'Removed words' : `Removed ${plural(count, 'word')}`;
    }
    case 'remove_silence': {
      const gaps = countInSummary(step, /(\d+)\s+gaps?/i);
      if (gaps !== undefined) return `Removed silence (${plural(gaps, 'gap')})`;
      const minimum = asNumber(input['minSilenceSeconds']);
      return minimum === undefined ? 'Removed silence' : `Removed silence over ${seconds(minimum)}`;
    }
    case 'close_gaps': {
      const trackId = asText(input['trackId']);
      return trackId ? `Closed gaps on ${trackLabel(trackId)}` : 'Closed the gaps';
    }
    case 'set_clip_properties': {
      const updates = asArray(input['updates']);
      return updates ? `Updated ${plural(updates.length, 'clip')}` : 'Updated clip properties';
    }
    case 'caption_clip_from_transcript': {
      const preset = asText(input['preset']);
      if (preset) return `Captioned from transcript · ${presetTitle(preset)}`;
      const perChunk = asNumber(input['wordsPerChunk']);
      return perChunk === undefined
        ? 'Captioned a clip from the transcript'
        : `Captioned from transcript (${perChunk} words per chunk)`;
    }
    case 'trim_clip': {
      const from = asNumber(input['in']);
      const to = asNumber(input['out']);
      if (from !== undefined && to !== undefined) return `Trimmed clip to ${seconds(from)}–${seconds(to)}`;
      if (from !== undefined) return `Trimmed clip in to ${seconds(from)}`;
      if (to !== undefined) return `Trimmed clip out to ${seconds(to)}`;
      return `Trimmed ${clipRef(input)}`;
    }
    case 'move_clip': {
      const start = asNumber(input['start']);
      return start === undefined ? `Moved ${clipRef(input)}` : `Moved clip to ${seconds(start)}`;
    }
    case 'reorder_clips': {
      const ids = input['clipIds'];
      return Array.isArray(ids) ? `Reordered ${ids.length} clips` : 'Reordered the clips';
    }
    case 'set_volume': {
      const volume = asNumber(input['volume']);
      return volume === undefined ? 'Set clip volume' : `Set volume to ${Math.round(volume * 100)}%`;
    }
    case 'set_speed': {
      const speed = asNumber(input['speed']);
      return speed === undefined ? 'Set clip speed' : `Set speed to ${speed}×`;
    }
    case 'set_transform':
      return 'Reframed the clip';
    case 'add_caption': {
      const text = asText(asRecord(input['clip'])['text']);
      return text ? `Added caption “${truncate(text, 32)}”` : 'Added a caption';
    }
    case 'update_caption': {
      const text = asText(input['text']);
      return text ? `Updated caption to “${truncate(text, 32)}”` : 'Updated a caption';
    }
    case 'remove_caption':
      return 'Removed a caption';
    case 'set_format': {
      const format = asText(input['format']);
      return format ? `Set format to ${format}` : 'Set the project format';
    }
    case 'undo':
      return 'Undid the last edit';
    default:
      return humanizeToolName(step.tool);
  }
}

/** One line of an agent reply's receipt — aggregated from the ops it applied. */
export interface ReceiptItem {
  glyph: string;
  label: string;
  /** Timeline second the first such edit landed at, when the op carries one. */
  at?: number;
}

const RECEIPT_NOUNS: Record<string, [string, string]> = {
  add_clip: ['clip added', 'clips added'],
  remove_clip: ['clip removed', 'clips removed'],
  split_clip: ['cut', 'cuts'],
  trim_clip: ['trim', 'trims'],
  move_clip: ['move', 'moves'],
  reorder_clips: ['reorder', 'reorders'],
  set_volume: ['volume change', 'volume changes'],
  set_speed: ['speed change', 'speed changes'],
  set_transform: ['punch-in', 'punch-ins'],
  set_overlay: ['sticker tweak', 'sticker tweaks'],
  set_transition: ['transition', 'transitions'],
  add_caption: ['caption', 'captions'],
  update_caption: ['caption edit', 'caption edits'],
  remove_caption: ['caption removed', 'captions removed'],
  ripple_delete_ranges: ['section removed', 'sections removed'],
  set_clip_properties: ['clip update', 'clip updates'],
  set_format: ['format change', 'format changes'],
  undo: ['undo', 'undos'],
  revert_run: ['revert', 'reverts'],
};

function opTimelineSecond(params: Record<string, unknown>): number | undefined {
  return asNumber(params['at']) ?? asNumber(params['start'])
    ?? asNumber(asRecord(params['clip'])['start'])
    ?? asNumber(asRecord(asArray(params['ranges'])?.[0])['start']);
}

/** Edits an op stands for — batch ops carry several, everything else exactly one. */
function opEditCount(op: { type: string; params?: unknown }): number {
  const params = asRecord(op.params);
  if (op.type === 'ripple_delete_ranges') return asArray(params['ranges'])?.length ?? 1;
  if (op.type === 'set_clip_properties') return asArray(params['updates'])?.length ?? 1;
  return 1;
}

/**
 * Aggregate the raw applied operations of one agent turn into receipt lines:
 * "/ 6 trims", "T 8 captions". Batch ops count their inner items so the
 * receipt reflects edits, not tool calls.
 */
export function receiptItems(ops: Array<{ type: string; params?: unknown }>): ReceiptItem[] {
  const groups = new Map<string, { count: number; glyph: string; at?: number }>();
  for (const op of ops) {
    const params = asRecord(op.params);
    const entry = groups.get(op.type) ?? { count: 0, glyph: KIND_GLYPH[TOOL_KIND[op.type] ?? 'other'] };
    entry.count += opEditCount(op);
    const at = opTimelineSecond(params);
    if (entry.at === undefined && at !== undefined) entry.at = at;
    groups.set(op.type, entry);
  }
  return [...groups.entries()].map(([type, entry]) => {
    const nouns = RECEIPT_NOUNS[type] ?? [humanizeToolName(type).toLowerCase(), humanizeToolName(type).toLowerCase()];
    return {
      glyph: entry.glyph,
      label: `${entry.count} ${entry.count === 1 ? nouns[0] : nouns[1]}`,
      ...(entry.at !== undefined ? { at: entry.at } : {}),
    };
  });
}

/**
 * Plain-language digest categories, in the order the summary reads them out.
 * `undo` and `revert_run` are absent on purpose: they cancel edits rather than
 * making any, and what they cancelled is already gone from the standing ops.
 * ponytail: one sentence per category, no per-clip detail — the message trace
 * is still there for anyone who wants the blow-by-blow.
 */
const SUMMARY_GROUPS: ReadonlyArray<{ types: string[]; sentence: (count: number) => string }> = [
  { types: ['split_clip', 'trim_clip'], sentence: (n) => `Made ${plural(n, 'cut')} to tighten pacing` },
  { types: ['remove_clip', 'ripple_delete_ranges'], sentence: (n) => `Removed ${plural(n, 'section')}` },
  { types: ['add_clip'], sentence: (n) => `Added ${plural(n, 'clip')}` },
  { types: ['move_clip', 'reorder_clips'], sentence: (n) => `Rearranged ${plural(n, 'clip')}` },
  { types: ['add_caption', 'update_caption'], sentence: (n) => `Added captions (${n})` },
  { types: ['remove_caption'], sentence: (n) => `Removed ${plural(n, 'caption')}` },
  { types: ['set_transform'], sentence: (n) => `Added ${plural(n, 'zoom-in')} on the action` },
  { types: ['set_transition'], sentence: (n) => `Added ${plural(n, 'transition')}` },
  { types: ['set_overlay'], sentence: (n) => `Added ${plural(n, 'sticker')}` },
  { types: ['set_speed'], sentence: (n) => `Changed the speed of ${plural(n, 'clip')}` },
  { types: ['set_volume'], sentence: (n) => `Balanced the audio on ${plural(n, 'clip')}` },
  { types: ['set_clip_properties'], sentence: (n) => `Tweaked ${plural(n, 'clip')}` },
  { types: ['set_format'], sentence: () => 'Changed the video format' },
];

/** The shape `editSummary` reads off a chat message — a subset of `ChatMessage`. */
export interface SummarizableMessage {
  role: 'user' | 'assistant';
  ops?: Array<{ type: string; params?: unknown }>;
  reverted?: boolean;
}

/**
 * Project-level digest of everything the agent did that is still standing:
 * ["Made 6 cuts to tighten pacing", "Added captions (12)"]. Reverted turns and
 * categories with no edits drop out, so an untouched project summarises to [].
 */
export function editSummary(messages: ReadonlyArray<SummarizableMessage>): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.reverted) continue;
    for (const op of message.ops ?? []) counts.set(op.type, (counts.get(op.type) ?? 0) + opEditCount(op));
  }
  return SUMMARY_GROUPS.flatMap((group) => {
    const total = group.types.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
    return total > 0 ? [group.sentence(total)] : [];
  });
}

/** Bytes → "12.4 MB", the size unit the import list shows. */
export function formatMegabytes(bytes: number): string {
  const mb = Math.max(0, bytes) / (1024 * 1024);
  if (mb < 0.1) return '<0.1 MB';
  return `${mb.toFixed(1)} MB`;
}
