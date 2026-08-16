import type { AgentTraceStep, ChatResponse, Project } from '@editify/shared';
import { runAgentLoop } from './loop.js';
import type { ToolProvider } from './providers.js';
import type { ToolContext } from './tools.js';

export class AgentService {
  /** Resolved per call so the UI's provider picker applies without a restart. */
  constructor(private readonly resolveProvider: () => ToolProvider) {}

  get provider(): ToolProvider {
    return this.resolveProvider();
  }

  async edit(ctx: ToolContext, message: string, onStep?: (step: AgentTraceStep) => void): Promise<ChatResponse> {
    return await runAgentLoop(this.provider, ctx, message, onStep ? { onStep } : {});
  }

  async distillStyle(project: Project, metrics: unknown): Promise<string> {
    const system = 'Distill these ffmpeg-only video metrics into one short editing style profile. Do not claim to have watched video.';
    return (await this.provider.completeText(system, JSON.stringify({ project, metrics }))).trim();
  }
}
