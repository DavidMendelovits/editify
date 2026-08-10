import type { FastifyInstance } from 'fastify';
import { chatRequestSchema } from '@editify/shared';
import type { AgentService } from '../agent/service.js';
import type { AssetStore } from '../db/asset-store.js';
import type { ChatStore } from '../db/chat-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { StyleService } from '../services/style-service.js';
import type { InsightService } from '../services/insight-service.js';
import type { TranscriptService } from '../services/transcript-service.js';

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
    const response = await agent.edit({
      projectId: project.id,
      projects,
      assets,
      styleDoc: styles.latest()?.styleDoc ?? null,
      currentVersion: project.version,
      transcripts,
      insights,
    }, message);
    chats.add(project.id, 'assistant', response.reply, response.opsApplied, response.trace);
    return response;
  });

  app.get<{ Params: { id: string } }>('/projects/:id/chat', async (request, reply) => {
    if (!projects.get(request.params.id)) return await reply.code(404).send({ error: 'Project not found' });
    return chats.list(request.params.id);
  });
}
