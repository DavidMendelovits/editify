import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EDITING_PRESETS, type EditingPreset, type Project } from '@editify/shared';
import type { ToolDef } from './tools.js';
import { generateMockInsights } from '../services/insight-service.js';

export interface ToolCallRequest { id: string; name: string; input: unknown }
export interface LoopTurn { text?: string; toolCalls: ToolCallRequest[] }

export type LoopMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolProvider {
  readonly name: 'anthropic' | 'openai' | 'mock';
  runTurn(system: string, messages: LoopMessage[], toolDefs: ToolDef[]): Promise<LoopTurn>;
  completeText(system: string, user: string): Promise<string>;
}

function loadServerEnv(): void {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
  if (!existsSync(path)) return;
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

loadServerEnv();

function jsonSchema(tool: ToolDef): Record<string, unknown> {
  return zodToJsonSchema(tool.schema, { $refStrategy: 'none', target: 'openApi3' }) as Record<string, unknown>;
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
        max_tokens: 4096,
        system,
        messages: anthropicMessages(messages),
        ...(toolDefs.length ? {
          tools: toolDefs.map((tool) => ({
            name: tool.name, description: tool.description, input_schema: jsonSchema(tool),
          })),
        } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Anthropic request failed (${response.status}): ${await response.text()}`);
    const json = await response.json() as { content?: AnthropicBlock[] };
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
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
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

    const prompt = messages.find((message): message is Extract<LoopMessage, { role: 'user' }> => message.role === 'user')
      ?.content.toLowerCase() ?? '';
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
      'list_assets', 'get_project', 'get_style_profile', 'get_insights', 'get_transcript', 'get_preset', 'list_presets',
    ].includes(call.name));
    const reply = applied.length
      ? `I built the cut through ${applied.length} live editor operations, including ${[...new Set(applied.map((call) => call.name.replaceAll('_', ' ')))].join(', ')}.`
      : 'I inspected the project and assets, but there was no safe edit to apply for that request.';
    return { text: reply, toolCalls: [] };
  }
}

export function createProvider(): ToolProvider {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicToolProvider(process.env.ANTHROPIC_API_KEY);
  if (process.env.OPENAI_API_KEY) return new OpenAIToolProvider(process.env.OPENAI_API_KEY);
  return new MockToolProvider();
}
