import type { FastifyInstance } from 'fastify';
import { chatRequestSchema, type AgentTraceStep } from '@editify/shared';
import type { AgentService } from '../agent/service.js';
import type { AssetStore } from '../db/asset-store.js';
import type { ChatStore } from '../db/chat-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { StyleService } from '../services/style-service.js';
import type { InsightService } from '../services/insight-service.js';
import type { TranscriptService } from '../services/transcript-service.js';

/**
 * Steps of the turn currently running for a project, so the client can watch it
 * unfold while the POST is still open. One entry per project at a time.
 */
const activeRuns = new Map<string, { startedAt: string; steps: AgentTraceStep[] }>();

export function registerChatRoutes(
  app: FastifyInstance,
  projects: ProjectStore,
  assets: AssetStore,
  chats: ChatStore,
  agent: AgentService,
  styles: StyleService,
  transcripts: TranscriptService,
  insights: InsightService,
): void {
  app.post<{ Params: { id: string } }>('/projects/:id/chat', async (request, reply) => {
    const project = projects.get(request.params.id);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const { message } = chatRequestSchema.parse(request.body);
    chats.add(project.id, 'user', message);
    const run = { startedAt: new Date().toISOString(), steps: [] as AgentTraceStep[] };
    activeRuns.set(project.id, run);
    let response;
    try {
      response = await agent.edit({
        projectId: project.id,
        projects,
        assets,
        styleDoc: styles.latest()?.styleDoc ?? null,
        currentVersion: project.version,
        transcripts,
        insights,
      }, message, (step) => run.steps.push(step));
    } finally {
      activeRuns.delete(project.id);
    }
    chats.add(project.id, 'assistant', response.reply, response.opsApplied, response.trace);
    return response;
  });

  /** Poll target while a turn is in flight; `{ running: false, steps: [] }` when idle. */
  app.get<{ Params: { id: string } }>('/projects/:id/chat/live', async (request) => {
    const run = activeRuns.get(request.params.id);
    return { running: Boolean(run), steps: run?.steps ?? [] };
  });

  app.get<{ Params: { id: string } }>('/projects/:id/chat', async (request, reply) => {
    if (!projects.get(request.params.id)) return await reply.code(404).send({ error: 'Project not found' });
    return chats.list(request.params.id);
  });
}
