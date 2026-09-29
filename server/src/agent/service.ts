import type { AgentTraceStep, ChatResponse, Project } from '@editify/shared';
import { runAgentLoop } from './loop.js';
import type { ToolProvider } from './providers.js';
import type { ToolContext } from './tools.js';
import { NO_DASHES_RULE } from './prose-style.js';

export class AgentService {
  /** Resolved per call (and per user) so the UI's provider picker applies without a restart. */
  constructor(private readonly resolveProvider: (userId?: string) => Promise<ToolProvider>) {}

  async edit(ctx: ToolContext, message: string, onStep?: (step: AgentTraceStep) => void): Promise<ChatResponse> {
    return await runAgentLoop(await this.resolveProvider(ctx.userId), ctx, message, onStep ? { onStep } : {});
  }

  /**
   * "Gemini watches, Claude thinks": the watching analyzer already produced the
   * structured template, this turns it into the one-paragraph brief every edit
   * conversation is given. `watched` decides whether the prompt may speak of
   * what the footage looks like or only of what ffmpeg measured.
   */
  async distillStyle(project: Project, template: unknown, observations: unknown, watched = false, userId?: string): Promise<string> {
    const source = watched
      ? 'The template and per-video observations below come from an analyzer that watched the videos; the ffmpeg numbers in them are measured.'
      : 'These are ffmpeg-only video metrics. Do not claim to have watched video.';
    const system = `Distill this into one short editing style profile a video editor could follow: pacing, hook, captions, transitions, audio, look. ${source} ${NO_DASHES_RULE}`;
    const provider = await this.resolveProvider(userId);
    return (await provider.completeText(system, JSON.stringify({ project, template, observations }))).trim();
  }
}
