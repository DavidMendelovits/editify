import {
  chatResponseSchema,
  operationSchema,
  type AgentTraceStep,
  type ChatResponse,
  type Operation,
  type Project,
} from '@editify/shared';
import type { LoopMessage, ToolProvider } from './providers.js';
import { createToolRegistry, isOperationTool, type ToolContext, type ToolDef } from './tools.js';

const MAX_ITERATIONS = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (isRecord(result) && result.ok === true) {
    return `Applied ${tool}; project is now version ${String(result.version)}.`;
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

function buildSystem(project: Project, styleDoc: string | null): string {
  return [
    'You are Editify, a precise video-editing agent operating a live project through tools.',
    'Inspect the project and assets before editing. Use operation tools for every mutation; never invent that an edit succeeded.',
    'When a tool reports an error, inspect fresh state as needed, correct the input, and try again.',
    'Use readable unique clip IDs. Keep edits faithful to the user request and finish with a concise, honest description.',
    styleDoc ? `Editing style profile: ${styleDoc}` : 'No editing style profile is available.',
    `Initial project summary: ${projectSummary(project)}`,
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
      result: { ok: false, error: validated.error.message },
      parsedInput: call.input,
      ok: false,
    };
  }
  try {
    const result = await tool.execute(ctx, validated.data);
    return { result, parsedInput: validated.data, ok: resultSucceeded(result) };
  } catch (error) {
    return {
      result: { ok: false, error: errorMessage(error) },
      parsedInput: validated.data,
      ok: false,
    };
  }
}

export async function runAgentLoop(
  provider: ToolProvider,
  ctx: ToolContext,
  userMessage: string,
  toolRegistry: ToolDef[] = createToolRegistry(),
): Promise<ChatResponse> {
  const initialProject = ctx.projects.get(ctx.projectId);
  if (!initialProject) throw new Error(`Project ${ctx.projectId} was not found`);
  ctx.currentVersion = initialProject.version;
  const system = buildSystem(initialProject, ctx.styleDoc);
  const messages: LoopMessage[] = [{ role: 'user', content: userMessage }];
  const toolsByName = new Map(toolRegistry.map((tool) => [tool.name, tool]));
  const trace: AgentTraceStep[] = [];
  const opsApplied: Operation[] = [];

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
      return chatResponseSchema.parse({
        reply: turn.text?.trim() || 'I finished the requested edit.',
        trace,
        opsApplied,
        doc,
      });
    }

    for (const call of turn.toolCalls) {
      const executed = await executeCall(toolsByName, ctx, call);
      trace.push({
        tool: call.name,
        input: executed.parsedInput,
        ok: executed.ok,
        summary: summarizeResult(call.name, executed.result, executed.ok),
      });
      if (executed.ok && isOperationTool(call.name)) {
        const operation = operationSchema.safeParse({ type: call.name, params: executed.parsedInput });
        if (operation.success) opsApplied.push(operation.data);
      }
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
