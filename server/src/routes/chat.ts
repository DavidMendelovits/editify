import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { MAX_CHAT_MESSAGE_CHARS, chatRequestSchema, improveRequestSchema, type AgentTraceStep } from '@editify/shared';
import { improvePrompt } from '../agent/improve.js';
import type { AgentService } from '../agent/service.js';
import type { ToolContext } from '../agent/tools.js';
import type { AssetStore } from '../db/asset-store.js';
import type { ChatStore } from '../db/chat-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { StyleService } from '../services/style-service.js';
import type { RenderStore } from '../db/render-store.js';
import type { DissectService } from '../services/dissect-service.js';
import type { SyncService } from '../services/sync-service.js';
import type { FaceService } from '../services/face-service.js';
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
  /** Optional only so tests that predate sync can build the routes without one; app.ts always passes it. */
  syncs?: SyncService,
  extras: { faces?: FaceService; renders?: RenderStore } = {},
): void {
  app.post<{ Params: { id: string } }>('/projects/:id/chat', async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    // A pasted transcript that blows the cap is a real, actionable situation —
    // say so instead of letting zod turn it into a generic validation failure.
    const raw = (request.body as { message?: unknown } | undefined)?.message;
    if (typeof raw === 'string' && raw.length > MAX_CHAT_MESSAGE_CHARS) {
      return await reply.code(413).send({
        error: `Message is ${raw.length} characters; the limit is ${MAX_CHAT_MESSAGE_CHARS}. Send the transcript as an asset transcript (get_transcript) or paste only the segments you want trimmed to.`,
        code: 'message-too-large',
        limit: MAX_CHAT_MESSAGE_CHARS,
        actual: raw.length,
      });
    }
    const { message } = chatRequestSchema.parse(request.body);
    // One turn, one checkpoint: everything this run applies carries this id.
    const runId = randomUUID();
    chats.add(project.id, 'user', message);
    const run = { startedAt: new Date().toISOString(), steps: [] as AgentTraceStep[] };
    activeRuns.set(project.id, run);
    // The loop mutates this ctx as it works, so the catch below can still see
    // which operations landed before a crash.
    const ctx: ToolContext = {
      projectId: project.id,
      ...(request.userId ? { userId: request.userId } : {}),
      projects,
      assets,
      styleDoc: styles.selected(request.userId)?.styleDoc ?? null,
      currentVersion: project.version,
      transcripts,
      insights,
      dissections,
      ...(syncs ? { syncs } : {}),
      ...(extras.faces ? { faces: extras.faces } : {}),
      ...(extras.renders ? { renders: extras.renders } : {}),
      runId,
    };
    let response;
    try {
      response = await agent.edit(ctx, message, (step) => run.steps.push(step));
    } catch (error) {
      // The loop may have applied ops before dying; a chat record has to carry
      // them — with the runId — or the timeline changes with no explanation in
      // the history and no Revert button for the partial edits.
      const reason = error instanceof Error ? error.message : String(error);
      chats.add(project.id, 'assistant', `The agent hit an error mid-turn: ${reason}`, ctx.appliedOperations ?? [], run.steps, runId);
      throw error;
    } finally {
      activeRuns.delete(project.id);
    }
    chats.add(project.id, 'assistant', response.reply, response.opsApplied, response.trace, runId);
    return { ...response, runId };
  });

  /**
   * Rewrites a casual message into an explicit instruction before it is sent.
   * Deterministic and local — no model call — so the answer is instant and can
   * only ever name operations, transitions and sounds the platform has.
   * `{ improved: null }` means "nothing to add"; the client sends as typed.
   */
  app.post<{ Params: { id: string } }>('/projects/:id/chat/improve', async (request, reply) => {
    if (!projects.get(request.params.id, request.userId)) return await reply.code(404).send({ error: 'Project not found' });
    const { message, previous } = improveRequestSchema.parse(request.body);
    const improvement = improvePrompt(message, previous);
    return improvement ?? { improved: null };
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
