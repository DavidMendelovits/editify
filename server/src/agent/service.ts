import type { ChatResponse, Project } from '@editify/shared';
import { runAgentLoop } from './loop.js';
import type { ToolProvider } from './providers.js';
import type { ToolContext } from './tools.js';

export class AgentService {
  constructor(readonly provider: ToolProvider) {}

  async edit(ctx: ToolContext, message: string): Promise<ChatResponse> {
    return await runAgentLoop(this.provider, ctx, message);
  }

  async distillStyle(project: Project, metrics: unknown): Promise<string> {
    const system = 'Distill these ffmpeg-only video metrics into one short editing style profile. Do not claim to have watched video.';
    const turn = await this.provider.runTurn(system, [{ role: 'user', content: JSON.stringify({ project, metrics }) }], []);
    return turn.text?.trim() ?? '';
  }
}
