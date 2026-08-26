import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { chatRequestSchema, type AgentTraceStep } from '@editify/shared';
import type { AgentService } from '../agent/service.js';
import type { AssetStore } from '../db/asset-store.js';
import type { ChatStore } from '../db/chat-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { StyleService } from '../services/style-service.js';
import type { DissectService } from '../services/dissect-service.js';
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
  dissections: DissectService,
): void {
  app.post<{ Params: { id: string } }>('/projects/:id/chat', async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const { message } = chatRequestSchema.parse(request.body);
    // One turn, one checkpoint: everything this run applies carries this id.
    const runId = randomUUID();
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
        dissections,
        runId,
      }, message, (step) => run.steps.push(step));
    } catch (error) {
      // The loop may have applied ops before dying; a chat record has to say
      // so, or the timeline changes with no explanation in the history.
      const reason = error instanceof Error ? error.message : String(error);
      chats.add(project.id, 'assistant', `The agent hit an error mid-turn: ${reason}`, [], run.steps, runId);
      throw error;
    } finally {
      activeRuns.delete(project.id);
    }
    chats.add(project.id, 'assistant', response.reply, response.opsApplied, response.trace, runId);
    return { ...response, runId };
  });

  /** Poll target while a turn is in flight; `{ running: false, steps: [] }` when idle. */
  app.get<{ Params: { id: string } }>('/projects/:id/chat/live', async (request, reply) => {
    if (!projects.get(request.params.id, request.userId)) return await reply.code(404).send({ error: 'Project not found' });
    const run = activeRuns.get(request.params.id);
    return { running: Boolean(run), steps: run?.steps ?? [] };
  });

  app.get<{ Params: { id: string } }>('/projects/:id/chat', async (request, reply) => {
    if (!projects.get(request.params.id, request.userId)) return await reply.code(404).send({ error: 'Project not found' });
    const messages = chats.list(request.params.id);
    // Reverted state is derived from the log, never stored: a plain undo of the
    // revert puts the run's operations back and the flag has to follow.
    const live = projects.liveRuns(request.params.id, [...new Set(messages.flatMap((message) => message.runId ?? []))]);
    return messages.map((message) => (message.runId ? { ...message, reverted: !live.has(message.runId) } : message));
  });
}
