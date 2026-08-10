/**
 * Local mirror of the agent-loop contract (SPEC-AGENT.md §A2/§B).
 *
 * These types intentionally live in `apps/mobile` rather than `@editify/shared`
 * so the UI stays decoupled from the server package while the agent loop lands.
 * Everything the agent hands back is treated as untrusted shape: `input` is
 * `unknown` and every read goes through a narrowing helper.
 */

export interface AgentTraceStep {
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
}

/** Visual family for a step — drives the glyph and tint in the step feed. */
export type TraceKind =
  | 'read' | 'add' | 'remove' | 'cut' | 'move'
  | 'audio' | 'speed' | 'frame' | 'caption' | 'format' | 'undo' | 'other';

const TOOL_KIND: Record<string, TraceKind> = {
  get_project: 'read',
  list_assets: 'read',
  get_style_profile: 'read',
  add_clip: 'add',
  remove_clip: 'remove',
  split_clip: 'cut',
  trim_clip: 'cut',
  move_clip: 'move',
  reorder_clips: 'move',
  set_volume: 'audio',
  set_speed: 'speed',
  set_transform: 'frame',
  add_caption: 'caption',
  update_caption: 'caption',
  remove_caption: 'caption',
  set_format: 'format',
  undo: 'undo',
};

const KIND_GLYPH: Record<TraceKind, string> = {
  read: '◎',
  add: '+',
  remove: '×',
  cut: '✂',
  move: '⇄',
  audio: '♪',
  speed: '◔',
  frame: '⤢',
  caption: 'T',
  format: '▣',
  undo: '↺',
  other: '•',
};

/** Warning glyph used for any step that came back `ok: false`. */
export const ERROR_GLYPH = '!';

export function traceKind(step: AgentTraceStep): TraceKind {
  return TOOL_KIND[step.tool] ?? 'other';
}

export function traceGlyph(step: AgentTraceStep): string {
  if (!step.ok) return ERROR_GLYPH;
  return KIND_GLYPH[traceKind(step)];
}

/** Read tools observe the project; everything else mutates it. */
export function isReadStep(step: AgentTraceStep): boolean {
  return traceKind(step) === 'read';
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

function seconds(value: number): string {
  return `${value.toFixed(1)}s`;
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
  const input = toolInput(step);
  switch (step.tool) {
    case 'get_project':
      return 'Read the project timeline';
    case 'list_assets':
      return 'Listed the media library';
    case 'get_style_profile':
      return 'Read the style profile';
    case 'add_clip': {
      const start = asNumber(asRecord(input['clip'])['start']);
      return start === undefined ? 'Added a clip' : `Added clip at ${seconds(start)}`;
    }
    case 'remove_clip':
      return `Removed ${clipRef(input)}`;
    case 'split_clip': {
      const at = asNumber(input['at']);
      return at === undefined ? `Split ${clipRef(input)}` : `Split clip at ${seconds(at)}`;
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

/** Bytes → "12.4 MB", the size unit the import list shows. */
export function formatMegabytes(bytes: number): string {
  const mb = Math.max(0, bytes) / (1024 * 1024);
  if (mb < 0.1) return '<0.1 MB';
  return `${mb.toFixed(1)} MB`;
}
