import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EDITING_PRESETS, type EditingPreset, type Project } from '@editify/shared';
import type { ToolDef } from './tools.js';
import { parseTranscriptInput } from './transcript-input.js';
import { generateMockInsights } from '../services/insight-service.js';

export interface ToolCallRequest { id: string; name: string; input: unknown }
export interface LoopTurn { text?: string; toolCalls: ToolCallRequest[] }

export type LoopMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolProvider {
  readonly name: 'anthropic' | 'openai' | 'claude-cli' | 'codex-cli' | 'mock';
  runTurn(system: string, messages: LoopMessage[], toolDefs: ToolDef[]): Promise<LoopTurn>;
  completeText(system: string, user: string): Promise<string>;
}

/**
 * Env files, nearest first and `.env.local` before `.env`. Already-set variables
 * always win, so an earlier file (and the real environment) beats a later one —
 * the repo-root `.env.local` is where a shared ANTHROPIC_API_KEY lives.
 */
function loadServerEnv(): void {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  for (const candidate of ['.env.local', '.env', '../.env.local', '../.env']) {
    const path = resolve(serverRoot, candidate);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match?.[1] || process.env[match[1]] !== undefined) continue;
      let value = match[2] ?? '';
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '');
      }
      process.env[match[1]] = value;
    }
  }
}

loadServerEnv();

/**
 * zod-to-json-schema tops out at draft-7, but the Anthropic API validates
 * against draft 2020-12: tuples must be `prefixItems`, and the old openApi3
 * target's boolean `exclusiveMinimum` is likewise rejected. Draft-7 output
 * needs only the tuple rewrite.
 */
function toDraft2020(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toDraft2020);
  if (typeof node !== 'object' || node === null) return node;
  const source = { ...node } as Record<string, unknown>;
  if (Array.isArray(source.items)) {
    source.prefixItems = source.items;
    source.items = source.additionalItems ?? false;
    delete source.additionalItems;
  }
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, toDraft2020(value)]));
}

function jsonSchema(tool: ToolDef): Record<string, unknown> {
  const { $schema: _$schema, ...schema } = zodToJsonSchema(tool.schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  return toDraft2020(schema) as Record<string, unknown>;
}

/**
 * The chat route surfaces provider errors straight to the user's error banner, so
 * a raw upstream body would leak JSON (and an `authentication_error` blob) into the
 * UI. Turn the response into a short operator-readable line instead.
 */
export async function providerFailureMessage(
  vendor: 'Anthropic' | 'OpenAI',
  envVar: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY',
  response: { status: number; text(): Promise<string> },
): Promise<string> {
  const { status } = response;
  if (status === 401 || status === 403) {
    return `${vendor} rejected the API key (${status}). Check ${envVar} on the server, or pick a different provider in settings.`;
  }
  if (status === 429) return `${vendor} is rate limiting this server (429). Wait a moment and try again.`;
  if (status >= 500) return `${vendor} is unavailable right now (${status}). Try again in a moment.`;
  const body = (await response.text().catch(() => '')).trim().replace(/\s+/g, ' ');
  const trimmed = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  return `${vendor} request failed (${status})${trimmed ? `: ${trimmed}` : ''}`;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

function anthropicMessages(messages: LoopMessage[]): Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> = [];
  for (const message of messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const content: AnthropicBlock[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      content.push(...message.toolCalls.map((call) => ({
        type: 'tool_use' as const, id: call.id, name: call.name, input: call.input,
      })));
      result.push({ role: 'assistant', content });
    } else {
      const previous = result.at(-1);
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      if (previous?.role === 'user' && Array.isArray(previous.content)
        && previous.content.every((item) => item.type === 'tool_result')) {
        previous.content.push(block);
      } else {
        result.push({ role: 'user', content: [block] });
      }
    }
  }
  return result;
}

export class AnthropicToolProvider implements ToolProvider {
  readonly name = 'anthropic' as const;
  constructor(private readonly apiKey: string) {}

  async runTurn(system: string, messages: LoopMessage[], toolDefs: ToolDef[]): Promise<LoopTurn> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 8192,
        system,
        messages: anthropicMessages(messages),
        ...(toolDefs.length ? {
          tools: toolDefs.map((tool) => ({
            name: tool.name, description: tool.description, input_schema: jsonSchema(tool),
          })),
        } : {}),
      }),
    });
    if (!response.ok) throw new Error(await providerFailureMessage('Anthropic', 'ANTHROPIC_API_KEY', response));
    const json = await response.json() as { content?: AnthropicBlock[]; stop_reason?: string };
    // A truncated response can carry a half-written tool call or silently drop all of
    // them, turning into a false "I'm done" — fail loudly instead.
    if (json.stop_reason === 'max_tokens') throw new Error('Anthropic response was truncated at max_tokens; the turn cannot be trusted');
    const content = json.content ?? [];
    const text = content.filter((block): block is Extract<AnthropicBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text).join('\n').trim();
    const toolCalls = content.filter((block): block is Extract<AnthropicBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, input: block.input }));
    return { ...(text ? { text } : {}), toolCalls };
  }

  async completeText(system: string, user: string): Promise<string> {
    return (await this.runTurn(system, [{ role: 'user', content: user }], [])).text?.trim() ?? '';
  }
}

function openAIMessages(messages: LoopMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    return {
      role: 'assistant',
      content: message.content ?? null,
      ...(message.toolCalls.length ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      } : {}),
    };
  });
}

export class OpenAIToolProvider implements ToolProvider {
  readonly name = 'openai' as const;
  constructor(private readonly apiKey: string) {}

  async runTurn(system: string, messages: LoopMessage[], toolDefs: ToolDef[]): Promise<LoopTurn> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? 'gpt-4.1',
        messages: [{ role: 'system', content: system }, ...openAIMessages(messages)],
        ...(toolDefs.length ? {
          tools: toolDefs.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: jsonSchema(tool) },
          })),
        } : {}),
      }),
    });
    if (!response.ok) throw new Error(await providerFailureMessage('OpenAI', 'OPENAI_API_KEY', response));
    const json = await response.json() as {
      choices?: Array<{ message?: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      } }>;
    };
    const message = json.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).map((call) => {
      let input: unknown;
      try { input = JSON.parse(call.function.arguments); } catch { input = call.function.arguments; }
      return { id: call.id, name: call.function.name, input };
    });
    const text = message?.content?.trim();
    return { ...(text ? { text } : {}), toolCalls };
  }

  async completeText(system: string, user: string): Promise<string> {
    return (await this.runTurn(system, [{ role: 'user', content: user }], [])).text?.trim() ?? '';
  }
}

function toolCalls(messages: LoopMessage[]): ToolCallRequest[] {
  return messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls : []);
}

function latestToolResult<T>(messages: LoopMessage[], name: string): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool' || message.name !== name) continue;
    try { return JSON.parse(message.content) as T; } catch { return undefined; }
  }
  return undefined;
}

function toolResults<T>(messages: LoopMessage[], name: string): Array<{ input: unknown; result: T }> {
  const callsById = new Map<string, ToolCallRequest>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) callsById.set(call.id, call);
    }
  }
  const results: Array<{ input: unknown; result: T }> = [];
  for (const message of messages) {
    if (message.role !== 'tool' || message.name !== name) continue;
    const call = callsById.get(message.toolCallId);
    if (!call) continue;
    try { results.push({ input: call.input, result: JSON.parse(message.content) as T }); } catch { /* ignore malformed tool output */ }
  }
  return results;
}

function callIndex(messages: LoopMessage[], names: readonly string[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.toolCalls.some((call) => names.includes(call.name))) return index;
  }
  return -1;
}

function calls(prefix: string, requests: Array<{ name: string; input: unknown }>): LoopTurn {
  return {
    toolCalls: requests.map((request, index) => ({ id: `${prefix}-${index + 1}`, ...request })),
  };
}

export class MockToolProvider implements ToolProvider {
  readonly name = 'mock' as const;

  async completeText(system: string, user: string): Promise<string> {
    if (system.startsWith('Distill these ffmpeg-only video metrics')) {
      return 'Fast-punch pacing with short shots, strong loudness, clean framing, and bold creator captions.';
    }
    if (system.startsWith('Analyze this timed transcript')) {
      const payload = JSON.parse(user.split('\nPrevious response was invalid:')[0] ?? '{}') as {
        assetId?: string;
        words?: Array<{ w: string; s: number; e: number }>;
        segments?: Array<{ text: string; s: number; e: number }>;
        generatedAt?: string;
      };
      return JSON.stringify(generateMockInsights(payload.assetId ?? '', {
        words: payload.words ?? [],
        segments: payload.segments ?? [],
      }, payload.generatedAt));
    }
    return '';
  }

  async runTurn(system: string, messages: LoopMessage[], _toolDefs: ToolDef[]): Promise<LoopTurn> {
    if (system.startsWith('Distill these ffmpeg-only video metrics')) {
      return { text: 'Fast-punch pacing with short shots, strong loudness, clean framing, and bold creator captions.', toolCalls: [] };
    }

    const rawPrompt = messages.find((message): message is Extract<LoopMessage, { role: 'user' }> => message.role === 'user')
      ?.content ?? '';
    const prompt = rawPrompt.toLowerCase();
    const previousCalls = toolCalls(messages);
    const called = (name: string): boolean => previousCalls.some((call) => call.name === name);
    if (!called('list_assets')) {
      return calls('inspect', [
        { name: 'list_assets', input: {} },
        { name: 'get_project', input: {} },
        { name: 'get_style_profile', input: {} },
      ]);
    }

    const normalizedPrompt = prompt.replaceAll('-', '_').replaceAll(' ', '_');
    const matchingPreset = EDITING_PRESETS.find((preset) => normalizedPrompt.includes(preset.name)
      || preset.targetContent.some((target) => {
        const phrase = target.replaceAll('_', ' ');
        return prompt.includes(phrase) || normalizedPrompt.includes(target);
      })) ?? (/\bpunchy\b/.test(prompt) ? EDITING_PRESETS[0] : undefined);
    if (matchingPreset && !called('get_preset')) {
      return calls('preset', [{ name: 'get_preset', input: { name: matchingPreset.name } }]);
    }

    const assets = latestToolResult<Array<{ id: string; originalName: string; duration: number }>>(messages, 'list_assets') ?? [];
    const project = latestToolResult<Project>(messages, 'get_project');
    const styleDoc = latestToolResult<string | null>(messages, 'get_style_profile');
    const preset = latestToolResult<EditingPreset>(messages, 'get_preset');
    const videoTrack = project?.tracks.find((track) => track.kind === 'video');
    const videoClips = videoTrack?.clips ?? [];
    // A transcript pasted straight into chat: parse it, then trim the first
    // video clip to the span its timecodes describe.
    const pastedTranscript = parseTranscriptInput(rawPrompt);
    if (pastedTranscript.ok || (/transcript/.test(prompt) && /trim/.test(prompt))) {
      if (!pastedTranscript.ok) {
        return { text: `I could not use that pasted transcript: ${pastedTranscript.error}`, toolCalls: [] };
      }
      const clip = videoClips[0];
      if (clip && !called('parse_transcript_text')) {
        return calls('transcript', [{ name: 'parse_transcript_text', input: { text: rawPrompt } }]);
      }
      if (clip && !called('trim_clip')) {
        const first = pastedTranscript.segments[0];
        const last = pastedTranscript.segments[pastedTranscript.segments.length - 1];
        const assetDuration = assets.find((asset) => asset.id === clip.assetId)?.duration ?? Number.POSITIVE_INFINITY;
        const trimIn = Math.max(0, Math.min(first?.start ?? 0, Math.max(0, assetDuration - 0.1)));
        const rawOut = last?.end ?? (last?.start ?? 0) + 2;
        const trimOut = Math.min(assetDuration, Math.max(rawOut, trimIn + 0.1));
        return calls('trim', [{ name: 'trim_clip', input: { clipId: clip.id, in: trimIn, out: trimOut } }]);
      }
    }

    const wantsBuild = /\b(build|style)\b/.test(prompt)
      || /\bmake\b.*\b(cut|video|edit)\b/.test(prompt) || Boolean(matchingPreset);
    const wantsPunch = /punch|chopp|fast/.test(prompt);
    const wantsCaptions = /caption|subtitle|bold/.test(prompt) || /caption/i.test(styleDoc ?? '') || Boolean(preset);
    const wantsVertical = /vertical|9\s*:\s*16/.test(prompt);

    type InsightResult = {
      assetId?: string;
      hook?: { start: number; end: number } | null;
      highlights?: Array<{ start: number; end: number; score: number }>;
      ok?: boolean;
    };
    const insightResults = toolResults<InsightResult>(messages, 'get_insights');
    const inspectedAssetIds = new Set(insightResults.map(({ input }) => (
      typeof input === 'object' && input !== null && 'assetId' in input ? String(input.assetId) : ''
    )));

    if (wantsBuild && videoClips.length === 0 && assets.some((asset) => !inspectedAssetIds.has(asset.id))) {
      return calls('insights', assets.filter((asset) => !inspectedAssetIds.has(asset.id)).map((asset) => ({
        name: 'get_insights', input: { assetId: asset.id },
      })));
    }

    if (wantsBuild && videoClips.length === 0 && !called('add_clips')) {
      const insightsByAsset = new Map(insightResults.map(({ input, result }) => {
        const assetId = typeof input === 'object' && input !== null && 'assetId' in input ? String(input.assetId) : '';
        return [assetId, result] as const;
      }));
      const transcriptCount = assets.filter((asset) => insightsByAsset.get(asset.id)?.assetId === asset.id).length;
      const candidates = (transcriptCount >= 3
        ? assets.filter((asset) => !asset.originalName.startsWith('seed-') && insightsByAsset.get(asset.id)?.assetId === asset.id)
        : assets).filter((asset) => asset.duration > 0);
      let start = 0;
      const clips = candidates.map((asset, index) => {
        const insight = insightsByAsset.get(asset.id);
        const span = insight?.hook ?? [...(insight?.highlights ?? [])].sort((a, b) => b.score - a.score)[0];
        const sourceIn = span ? Math.min(Math.max(0, span.start - 0.3), Math.max(0, asset.duration - 0.1)) : 0;
        const sourceOut = span
          ? Math.min(asset.duration, span.end + 0.3, sourceIn + 6)
          : Math.min(asset.duration, 4);
        const safeOut = Math.min(asset.duration, Math.max(sourceIn + 0.1, sourceOut));
        const duration = safeOut - sourceIn;
        const clip = {
              id: `clip-${index + 1}`,
              assetId: asset.id,
              start,
              in: sourceIn,
              out: safeOut,
              volume: 1,
              speed: 1,
        };
        start += duration;
        return clip;
      });
      if (clips.length) return calls('build', [{ name: 'add_clips', input: { trackId: videoTrack?.id ?? 'video-main', clips } }]);
    }

    const mutationNames = ['add_clips', 'split_clips', 'set_clip_properties', 'remove_silence', 'close_gaps', 'caption_clip_from_transcript'] as const;
    const latestMutation = callIndex(messages, mutationNames);
    const latestProjectRead = callIndex(messages, ['get_project']);
    if (latestMutation > latestProjectRead && (wantsPunch || wantsCaptions)) {
      return calls('refresh', [{ name: 'get_project', input: {} }]);
    }

    if (preset?.silenceTrim.enabled && videoClips.length && !called('remove_silence')) {
      return calls('silence', [{ name: 'remove_silence', input: {
        minSilenceSeconds: preset.silenceTrim.minSilenceSeconds,
        padSeconds: preset.silenceTrim.padSeconds,
        protectLoudGaps: preset.silenceTrim.protectLoudGaps,
      } }]);
    }

    const shotCap = Math.min(preset?.maxShotSeconds ?? Number.POSITIVE_INFINITY, wantsPunch ? 2.5 : Number.POSITIVE_INFINITY);
    if (Number.isFinite(shotCap) && videoClips.some((clip) => (clip.out - clip.in) / (clip.speed ?? 1) > shotCap)
      && !called('split_clips')) {
      const cuts: Array<{ clipId: string; at: number; newClipId: string }> = [];
      for (const clip of videoClips) {
        const duration = (clip.out - clip.in) / (clip.speed ?? 1);
        let remaining = duration;
        let currentId = clip.id;
        let cursor = clip.start;
        let part = 2;
        while (remaining > shotCap) {
          const nextId = `${clip.id}-cut-${part}`;
          cursor += shotCap;
          cuts.push({ clipId: currentId, at: cursor, newClipId: nextId });
          currentId = nextId;
          remaining -= shotCap;
          part += 1;
        }
      }
      if (cuts.length) return calls('split', [{ name: 'split_clips', input: { cuts } }]);
    }

    if ((wantsPunch || preset?.punchIn.enabled) && videoClips.length && !called('set_clip_properties')) {
      const updates = videoClips.map((clip, index) => ({
        clipId: clip.id,
        ...(wantsPunch ? { speed: 1.25 } : {}),
        ...(preset?.punchIn.enabled && preset.punchIn.alternateScalePct
          && index % (preset.punchIn.everyNCuts ?? 2) === (preset.punchIn.everyNCuts ?? 2) - 1
          ? { transform: { scale: preset.punchIn.alternateScalePct / 100, x: 0, y: -0.04 } } : {}),
      })).filter((update) => Object.keys(update).length > 1);
      if (updates.length) return calls('pace', [{ name: 'set_clip_properties', input: { updates } }]);
    }

    if (wantsPunch && videoClips.length && called('set_clip_properties') && !called('close_gaps')) {
      return calls('gaps', [{ name: 'close_gaps', input: { trackId: videoTrack?.id ?? 'video-main' } }]);
    }

    if (wantsCaptions && videoClips.length && !called('caption_clip_from_transcript')) {
      return calls('caption', videoClips.map((clip) => ({
        name: 'caption_clip_from_transcript',
        input: { clipId: clip.id, ...(preset ? { preset: preset.name } : { wordsPerChunk: 3 }) },
      })));
    }

    if (wantsVertical && !called('set_format')) {
      return calls('format', [{ name: 'set_format', input: { format: '9:16' } }]);
    }

    const applied = previousCalls.filter((call) => ![
      'list_assets', 'get_project', 'get_style_profile', 'get_insights', 'get_transcript', 'get_preset', 'list_presets', 'parse_transcript_text',
    ].includes(call.name));
    const reply = applied.length
      ? `I built the cut through ${applied.length} live editor operations, including ${[...new Set(applied.map((call) => call.name.replaceAll('_', ' ')))].join(', ')}.`
      : 'I inspected the project and assets, but there was no safe edit to apply for that request.';
    return { text: reply, toolCalls: [] };
  }
}

export type AgentCli = 'claude' | 'codex';

const CLI_TIMEOUT_MS = Number(process.env.EDITIFY_AGENT_CLI_TIMEOUT_MS ?? 240_000);

/** Everything after the first balanced `{`, so a chatty preamble or a code fence cannot break the turn. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

/** A CLI reply that is not the agreed JSON is treated as a final answer, which ends the loop cleanly. */
export function parseCliTurn(raw: string): LoopTurn {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) return raw.trim() ? { text: raw.trim(), toolCalls: [] } : { toolCalls: [] };
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  const rawCalls = parsed.toolCalls ?? parsed.tool_calls; // models drift to snake_case
  const toolCalls = (Array.isArray(rawCalls) ? rawCalls : [])
    .filter(isRecord)
    .filter((call): call is { name: string; input?: unknown } => typeof call.name === 'string')
    .map((call, index) => ({ id: `cli-${index}`, name: call.name, input: call.input ?? {} }));
  return { ...(text ? { text } : {}), toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The loop's message list flattened into one prompt — the CLIs are stateless between turns. */
function cliPrompt(messages: LoopMessage[], toolDefs: ToolDef[]): string {
  const transcript = messages.map((message) => {
    if (message.role === 'user') return `USER:\n${message.content}`;
    if (message.role === 'tool') return `TOOL RESULT (${message.name}):\n${message.content}`;
    const calls = message.toolCalls.length
      ? `\nTOOL CALLS: ${JSON.stringify(message.toolCalls.map(({ name, input }) => ({ name, input })))}`
      : '';
    return `ASSISTANT:\n${message.content ?? ''}${calls}`;
  }).join('\n\n');

  return [
    toolDefs.length ? `# Available tools\n${JSON.stringify(
      toolDefs.map((tool) => ({ name: tool.name, description: tool.description, input_schema: jsonSchema(tool) })),
    )}` : '',
    `# Conversation so far\n${transcript}`,
    '# Your reply',
    'Respond with a single JSON object and nothing else. No prose, no code fence:',
    '{"text": "<message to the user>", "toolCalls": [{"name": "<tool>", "input": {}}]}',
    'Put the tools you want run next in toolCalls; their results come back on the next turn.',
    'When the work is done, return an empty toolCalls array and your final message in text.',
  ].filter(Boolean).join('\n\n');
}

/**
 * Uses the locally installed Claude Code or Codex CLI as the model, so the app
 * runs on a developer's existing subscription with no API key.
 *
 * Neither CLI exposes a tool-call protocol we can plug into, so each loop turn
 * is flattened into one prompt and the JSON reply is parsed back into tool
 * calls. Both are launched isolated — no MCP servers, no user settings, no
 * tools of their own, in a throwaway working directory — so they answer instead
 * of wandering off and editing files.
 *
 * ponytail: every turn replays the whole conversation to a fresh process, which
 * is simple but pays for the same input tokens each time. `claude --resume
 * <session_id>` would send only the new tool results; do that if turn cost bites.
 */
export class CliToolProvider implements ToolProvider {
  readonly name: 'claude-cli' | 'codex-cli';

  constructor(private readonly cli: AgentCli) {
    this.name = cli === 'claude' ? 'claude-cli' : 'codex-cli';
  }

  async runTurn(system: string, messages: LoopMessage[], toolDefs: ToolDef[]): Promise<LoopTurn> {
    const prompt = cliPrompt(messages, toolDefs);
    const raw = await this.invoke(system, prompt);
    if (!raw.trim() || extractJsonObject(raw) !== undefined) return parseCliTurn(raw);
    // Prose instead of the envelope would silently end the loop with edits claimed
    // but never made — give the model one corrective retry before accepting it.
    const retried = await this.invoke(system, [
      prompt,
      'Your previous reply was not the required JSON envelope. It began:',
      raw.slice(0, 400),
      'Reply again with ONLY the JSON object described above. No prose, no code fence.',
    ].join('\n\n'));
    return parseCliTurn(retried.trim() ? retried : raw);
  }

  async completeText(system: string, user: string): Promise<string> {
    return (await this.invoke(system, user)).trim();
  }

  private async invoke(system: string, prompt: string): Promise<string> {
    const workDir = await mkdtemp(join(tmpdir(), 'editify-agent-'));
    const model = process.env.EDITIFY_AGENT_CLI_MODEL;
    try {
      if (this.cli === 'codex') {
        // Codex has no system-prompt flag, so it rides along at the top of the prompt.
        const outputPath = join(workDir, 'reply.txt');
        await run('codex', [
          'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
          ...(model ? ['-m', model] : []), '-o', outputPath,
        ], `${system}\n\n${prompt}`, workDir);
        return await readFile(outputPath, 'utf8');
      }
      const stdout = await run('claude', [
        '-p', '--output-format', 'json',
        '--model', model ?? 'claude-sonnet-5',
        // Isolate: no MCP servers, no user/project settings, no built-in tools.
        '--strict-mcp-config', '--setting-sources', '', '--allowed-tools', '',
        '--system-prompt', system,
      ], prompt, workDir);
      const envelope = extractJsonObject(stdout);
      if (!isRecord(envelope)) throw new Error(`Claude CLI returned no JSON envelope: ${stdout.slice(0, 400)}`);
      if (envelope.is_error) throw new Error(`Claude CLI reported an error: ${String(envelope.result ?? '')}`);
      return typeof envelope.result === 'string' ? envelope.result : '';
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

function run(command: string, args: string[], stdin: string, cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`${command} timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} exited with ${String(code)}: ${(stderr || stdout).slice(0, 400)}`));
    });
    child.stdin.end(stdin);
  });
}

export type AgentProviderId = ToolProvider['name'];

/** What runs when nothing has been picked in the UI: the env var, then keys, then mock. */
export function defaultProviderId(): AgentProviderId {
  if (process.env.EDITIFY_AGENT_CLI === 'claude') return 'claude-cli';
  if (process.env.EDITIFY_AGENT_CLI === 'codex') return 'codex-cli';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY ?? process.env.OPENAI_BASE_URL) return 'openai';
  return 'mock';
}

export function createProvider(id: AgentProviderId = defaultProviderId()): ToolProvider {
  switch (id) {
    case 'claude-cli': return new CliToolProvider('claude');
    case 'codex-cli': return new CliToolProvider('codex');
    // A missing key must error, not silently downgrade to the mock — the mock
    // confidently claims edits, which is the worst possible failure mode.
    case 'anthropic': {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('The anthropic provider needs ANTHROPIC_API_KEY; set it or pick another provider');
      return new AnthropicToolProvider(process.env.ANTHROPIC_API_KEY);
    }
    case 'openai': {
      if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) throw new Error('The openai provider needs OPENAI_API_KEY (or OPENAI_BASE_URL); set it or pick another provider');
      return new OpenAIToolProvider(process.env.OPENAI_API_KEY ?? 'local');
    }
    default: return new MockToolProvider();
  }
}
