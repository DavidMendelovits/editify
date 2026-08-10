import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Project } from '@editify/shared';
import type { ToolDef } from './tools.js';

export interface ToolCallRequest { id: string; name: string; input: unknown }
export interface LoopTurn { text?: string; toolCalls: ToolCallRequest[] }

export type LoopMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolProvider {
  readonly name: 'anthropic' | 'openai' | 'mock';
  runTurn(system: string, messages: LoopMessage[], toolDefs: ToolDef[]): Promise<LoopTurn>;
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

    const assets = latestToolResult<Array<{ id: string; originalName: string; duration: number }>>(messages, 'list_assets') ?? [];
    const project = latestToolResult<Project>(messages, 'get_project');
    const styleDoc = latestToolResult<string | null>(messages, 'get_style_profile');
    const videoTrack = project?.tracks.find((track) => track.kind === 'video');
    const videoClips = videoTrack?.clips ?? [];
    const wantsBuild = /\b(build|style)\b/.test(prompt)
      || /\bmake\b.*\b(cut|video|edit)\b/.test(prompt);
    const wantsPunch = /punch|chopp|fast/.test(prompt);
    const wantsCaptions = /caption|subtitle|bold/.test(prompt) || /caption/i.test(styleDoc ?? '');
    const wantsVertical = /vertical|9\s*:\s*16/.test(prompt);

    if (wantsBuild && videoClips.length === 0 && !called('add_clip')) {
      let start = 0;
      const requests = assets.map((asset, index) => {
        const duration = Math.max(0.1, Math.min(asset.duration, 4));
        const request = {
          name: 'add_clip',
          input: {
            trackId: videoTrack?.id ?? 'video-main',
            clip: {
              id: `clip-${index + 1}`,
              assetId: asset.id,
              start,
              in: 0,
              out: duration,
              volume: 1,
              speed: 1,
            },
          },
        };
        start += duration;
        return request;
      });
      if (requests.length) return calls('build', requests);
    }

    const mutationNames = ['add_clip', 'split_clip', 'set_speed', 'add_caption'] as const;
    const latestMutation = callIndex(messages, mutationNames);
    const latestProjectRead = callIndex(messages, ['get_project']);
    if (latestMutation > latestProjectRead && (wantsPunch || wantsCaptions)) {
      return calls('refresh', [{ name: 'get_project', input: {} }]);
    }

    if (wantsPunch && videoClips.length && !called('set_speed')) {
      const requests: Array<{ name: string; input: unknown }> = [];
      for (const clip of videoClips) {
        const duration = (clip.out - clip.in) / (clip.speed ?? 1);
        if (duration > 2.5) {
          const newClipId = `${clip.id}-cut-2`;
          requests.push({ name: 'split_clip', input: { clipId: clip.id, at: clip.start + duration / 2, newClipId } });
          requests.push({ name: 'set_speed', input: { clipId: clip.id, speed: 1.25 } });
          requests.push({ name: 'set_speed', input: { clipId: newClipId, speed: 1.25 } });
        } else {
          requests.push({ name: 'set_speed', input: { clipId: clip.id, speed: 1.25 } });
        }
      }
      return calls('pace', requests);
    }

    if (wantsCaptions && videoClips.length && !called('add_caption')) {
      return calls('caption', videoClips.map((clip, index) => ({
        name: 'add_caption',
        input: {
          trackId: 'captions',
          clip: {
            id: `caption-${clip.id}`,
            start: clip.start,
            in: 0,
            out: Math.max(0.1, (clip.out - clip.in) / (clip.speed ?? 1)),
            text: `Caption ${index + 1}`,
            style: { font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold' },
          },
        },
      })));
    }

    if (wantsVertical && !called('set_format')) {
      return calls('format', [{ name: 'set_format', input: { format: '9:16' } }]);
    }

    const applied = previousCalls.filter((call) => !['list_assets', 'get_project', 'get_style_profile'].includes(call.name));
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
