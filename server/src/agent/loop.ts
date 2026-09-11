import {
  chatResponseSchema,
  type AgentTraceStep,
  type ChatResponse,
  type Operation,
  type Project,
} from '@editify/shared';
import type { LoopMessage, ToolProvider } from './providers.js';
import { createMutationDelta, createToolRegistry, describeProject, formatZodError, type ToolContext, type ToolDef } from './tools.js';
import { NO_DASHES_RULE } from './prose-style.js';

const MAX_ITERATIONS = 24;

/** Past-tense edit verbs — a final reply matching this while zero ops were applied is a false success claim. */
const EDIT_CLAIM = /\b(trimmed|cut|removed|deleted|added|applied|edited|split|moved|reordered|styled|captioned|adjusted|tightened|shortened|zoomed|sped|slowed)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Did the project document actually change, ignoring the version counter? */
function docChanged(before: Project, after: Project): boolean {
  return JSON.stringify({ ...before, version: 0 }) !== JSON.stringify({ ...after, version: 0 });
}

function resultSucceeded(result: unknown): boolean {
  return !(isRecord(result) && result.ok === false);
}

function summarizeResult(tool: string, result: unknown, ok: boolean): string {
  if (!ok) {
    return isRecord(result) && typeof result.error === 'string' ? result.error : 'Tool call failed';
  }
  if (tool === 'get_project' && isRecord(result)) {
    const tracks = Array.isArray(result.tracks) ? result.tracks.length : 0;
    return `Loaded project version ${String(result.version)} with ${tracks} tracks.`;
  }
  if (tool === 'list_assets' && Array.isArray(result)) return `Found ${result.length} available assets.`;
  if (tool === 'get_style_profile') return result === null ? 'No style profile is available.' : 'Loaded the current style profile.';
  if (tool === 'get_transcript' && isRecord(result)) return `Loaded ${String(result.wordCount)} timed words.`;
  if (tool === 'parse_transcript_text' && isRecord(result)) return `Parsed ${String(result.segmentCount)} ${String(result.format)} transcript segments.`;
  if (tool === 'get_insights' && isRecord(result)) return 'Loaded transcript hook and highlight insights.';
  if (tool === 'get_timeline_transcript' && isRecord(result)) return `Loaded ${Array.isArray(result.words) ? result.words.length : 0} timeline words.`;
  if (tool === 'list_presets' && Array.isArray(result)) return `Found ${result.length} editing presets.`;
  if (tool === 'get_preset' && isRecord(result)) return `Loaded the ${String(result.name)} preset.`;
  if (tool === 'caption_clip_from_transcript' && isRecord(result) && result.changed !== false) {
    return `Added ${String(result.captionsAdded)} transcript captions; project is now version ${String(result.version)}.`;
  }
  if (isRecord(result) && result.ok === true) {
    if (result.changed === false) return `No change from ${tool}: the project already matched this request.`;
    const changed = Array.isArray(result.changedClips) ? result.changedClips.length : 0;
    const removed = Array.isArray(result.removedClipIds) ? result.removedClipIds.length : 0;
    return `Applied ${tool}; project is now version ${String(result.version)} (${changed} changed, ${removed} removed).`;
  }
  return 'Tool completed successfully.';
}

function projectSummary(project: Project): string {
  return JSON.stringify({
    id: project.id,
    title: project.title,
    format: project.format,
    fps: project.fps,
    duration: project.duration,
    version: project.version,
    tracks: project.tracks.map((track) => ({ id: track.id, kind: track.kind, clipCount: track.clips.length })),
  });
}

/** Past this, the timeline is summarized and the agent reads it with get_project. */
const MAX_EMBEDDED_CLIPS = 120;
const MAX_EMBEDDED_ASSETS = 60;

export interface AssetSummary {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image' | 'other';
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export function summarizeAssets(ctx: ToolContext): AssetSummary[] {
  return ctx.assets.listForProject(ctx.projectId).map((asset) => ({
    id: asset.id,
    name: asset.label ?? asset.originalName,
    kind: asset.mimeType.startsWith('video/') ? 'video'
      : asset.mimeType.startsWith('audio/') ? 'audio'
        : asset.mimeType.startsWith('image/') ? 'image' : 'other',
    duration: asset.duration,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
  }));
}

/**
 * The agent's whole situation in one place: the units every number is in, the
 * tracks that exist, the timeline as it stands, and the media it may cut with.
 * Sending the state up front saves the two read calls every turn used to open
 * with, which on the CLI providers is two whole process spawns.
 */
export function buildSystem(project: Project, assets: AssetSummary[], styleDoc: string | null): string {
  const clipCount = project.tracks.reduce((total, track) => total + track.clips.length, 0);
  const embedProject = clipCount <= MAX_EMBEDDED_CLIPS;
  const embedAssets = assets.length <= MAX_EMBEDDED_ASSETS;
  return [
    'You are Editify, a precise video-editing agent operating a live project through tools.',
    'Units: clip.start is an absolute timeline second and clip.in/clip.out are seconds inside the source asset, so a clip ends at start + (out - in) / speed. split_clip.at, move_clip.start, ripple ranges, and caption starts are timeline seconds. Transcript, insight, and dissection timestamps are source seconds until a tool says otherwise. Tracks: video-main is the cut, audio-main holds music, voiceover, and SFX, overlays holds stickers, callouts, and b-roll, captions holds captions.',
    embedProject && embedAssets
      ? 'The current timeline and the assets you may cut with are at the end of this message. Plan from them directly; call get_project or list_assets only after an error or when you need a field they omit.'
      : 'This project is large, so only a summary is included below. Call get_project and list_assets before editing.',
    'Use operation tools for every mutation; never invent that an edit succeeded.',
    'Every edit returns the clips it changed with their new start and end, the project duration, and any gaps or overlaps on the video track. When a tool reports an error, it names what exists; correct the input from that and try again.',
    'Use readable unique clip IDs. Keep edits faithful to the user request and finish with a concise, honest description.',
    'When the user pastes a transcript into the chat message, call parse_transcript_text on that pasted text and trim with the segment timecodes it returns rather than guessing times.',
    'Asset transcripts and transcript insights may be available. Strong edits trim to highlight spans, lead with the hook, and use caption_clip_from_transcript for speech captions.',
    'Prefer batch tools add_clips, split_clips, ripple_delete_ranges, and set_clip_properties for coherent edits; keep singular tools for cheap one-off changes. Trimming several clips is one set_clip_properties call with in/out per update, never repeated trim_clip calls; captioning several clips is one caption_clip_from_transcript call with clipIds.',
    'Whenever a reply contains tool calls, open it with one or two plain sentences saying what you are about to do and why. That text is shown to the user as your thinking.',
    'Never use emoji in anything you write; the interface is a professional editing tool.',
    'set_speed and trim_clip change a clip duration but never move its neighbors, so after duration-changing edits, call close_gaps (or place clips deliberately). Gaps render as black frames and must always be intentional.',
    'When the user names a style or content type, fetch the matching preset and follow its parameters. Presets are guidance, not law.',
    NO_DASHES_RULE,
    styleDoc ? `Editing style profile: ${styleDoc}` : 'No editing style profile is available.',
    embedProject ? `Current project: ${JSON.stringify(describeProject(project))}` : `Project summary: ${projectSummary(project)}`,
    embedAssets
      ? `Assets (duration in source seconds): ${JSON.stringify(assets)}`
      : `Assets: ${assets.length} linked to this project; call list_assets for their ids and durations.`,
  ].join('\n');
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return JSON.stringify({ ok: false, error: 'Tool result was not serializable' }); }
}

async function executeCall(
  toolDefs: Map<string, ToolDef>,
  ctx: ToolContext,
  call: { name: string; input: unknown },
): Promise<{ result: unknown; parsedInput: unknown; ok: boolean }> {
  const tool = toolDefs.get(call.name);
  if (!tool) {
    return { result: { ok: false, error: `Unknown tool: ${call.name}` }, parsedInput: call.input, ok: false };
  }
  const validated = tool.schema.safeParse(call.input);
  if (!validated.success) {
    return {
      result: { ok: false, error: formatZodError(validated.error) },
      parsedInput: call.input,
      ok: false,
    };
  }
  try {
    const before = ctx.projects.get(ctx.projectId);
    const appliedBefore = ctx.appliedOperations?.length ?? 0;
    const result = await tool.execute(ctx, validated.data);
    const appliedAfter = ctx.appliedOperations?.length ?? 0;
    const after = appliedAfter > appliedBefore ? ctx.projects.get(ctx.projectId) : undefined;
    const structuralResult = before && after && !(isRecord(result) && Array.isArray(result.changedClips))
      ? { ...createMutationDelta(before, after), ...(isRecord(result) ? result : {}) }
      : result;
    return { result: structuralResult, parsedInput: validated.data, ok: resultSucceeded(structuralResult) };
  } catch (error) {
    return {
      result: { ok: false, error: errorMessage(error) },
      parsedInput: validated.data,
      ok: false,
    };
  }
}

export interface AgentLoopOptions {
  toolRegistry?: ToolDef[];
  /** Called as each trace step is recorded, so a run can be followed live. */
  onStep?: (step: AgentTraceStep) => void;
}

export async function runAgentLoop(
  provider: ToolProvider,
  ctx: ToolContext,
  userMessage: string,
  options: AgentLoopOptions = {},
): Promise<ChatResponse> {
  const toolRegistry = options.toolRegistry ?? createToolRegistry();
  const initialProject = ctx.projects.get(ctx.projectId);
  if (!initialProject) throw new Error(`Project ${ctx.projectId} was not found`);
  ctx.currentVersion = initialProject.version;
  const system = buildSystem(initialProject, summarizeAssets(ctx), ctx.styleDoc);
  const messages: LoopMessage[] = [{ role: 'user', content: userMessage }];
  const toolsByName = new Map(toolRegistry.map((tool) => [tool.name, tool]));
  const trace: AgentTraceStep[] = [];
  const record = (step: AgentTraceStep): void => {
    trace.push(step);
    options.onStep?.(step);
  };
  const opsApplied: Operation[] = [];
  const noOpCalls: Array<{ tool: string; input: unknown }> = [];
  ctx.appliedOperations = [];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const turn = await provider.runTurn(system, messages, toolRegistry);
    messages.push({
      role: 'assistant',
      ...(turn.text ? { content: turn.text } : {}),
      toolCalls: turn.toolCalls,
    });
    if (turn.toolCalls.length === 0) {
      const doc = ctx.projects.get(ctx.projectId);
      if (!doc) throw new Error(`Project ${ctx.projectId} disappeared during the agent loop`);
      // The reply must never overstate what happened: an empty reply is filled from
      // the applied-ops record, and a reply that claims edits with zero applied ops
      // gets corrected rather than trusted.
      let reply = turn.text?.trim()
        || (opsApplied.length
          ? `Done: ${opsApplied.length} edit${opsApplied.length === 1 ? '' : 's'} applied. The trace lists each one.`
          : 'I didn’t make any changes to the project.');
      // Honesty is judged on the document, not on the op count: an operation that
      // changed nothing must not count as an edit.
      const anythingChanged = docChanged(initialProject, doc);
      if (!anythingChanged && EDIT_CLAIM.test(reply)) {
        reply += '\n\n(Note: no edits were actually applied to the project in this run.)';
      } else if (anythingChanged && noOpCalls.length) {
        const names = [...new Set(noOpCalls.map((entry) => entry.tool))];
        const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
        reply += `\n\n(Partial: ${list} made no change: the project already matched those requests.)`;
      }
      return chatResponseSchema.parse({ reply, trace, opsApplied, doc });
    }

    // Text alongside tool calls is the model's plan for them — show it first.
    const thought = turn.text?.trim();
    if (thought) record({ kind: 'thought', tool: 'thinking', input: undefined, ok: true, summary: thought });

    for (const call of turn.toolCalls) {
      const appliedBefore = ctx.appliedOperations.length;
      const executed = await executeCall(toolsByName, ctx, call);
      record({
        tool: call.name,
        input: executed.parsedInput,
        ok: executed.ok,
        summary: summarizeResult(call.name, executed.result, executed.ok),
      });
      // A mutating tool that reports success while changing nothing is the silent
      // no-op this run must not claim as an edit — log it and remember it.
      if (executed.ok && isRecord(executed.result) && executed.result.changed === false) {
        noOpCalls.push({ tool: call.name, input: executed.parsedInput });
        console.warn('[agent] no-op tool call', {
          projectId: ctx.projectId, runId: ctx.runId, tool: call.name, input: executed.parsedInput,
        });
      }
      opsApplied.push(...ctx.appliedOperations.slice(appliedBefore));
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: safeJson(executed.result),
      });
    }
  }

  const doc = ctx.projects.get(ctx.projectId);
  if (!doc) throw new Error(`Project ${ctx.projectId} disappeared during the agent loop`);
  return chatResponseSchema.parse({
    reply: 'I stopped early after reaching the 24-turn safety limit. The trace shows every edit that was applied.',
    trace,
    opsApplied,
    doc,
  });
}
