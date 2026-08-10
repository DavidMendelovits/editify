import type { FastifyInstance } from 'fastify';
import { newProjectSchema, operationBatchSchema, renderRequestSchema } from '@editify/shared';
import type { ProjectStore } from '../db/project-store.js';
import type { RenderQueue } from '../services/render-queue.js';

export function registerProjectRoutes(app: FastifyInstance, projects: ProjectStore, renderQueue: RenderQueue): void {
  app.post('/projects', async (request, reply) => {
    const input = newProjectSchema.parse(request.body ?? {});
    return await reply.code(201).send(projects.create(input));
  });

  app.get('/projects', async () => projects.list());

  app.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const project = projects.get(request.params.id);
    return project ?? await reply.code(404).send({ error: 'Project not found' });
  });

  app.post<{ Params: { id: string } }>('/projects/:id/ops', async (request, reply) => {
    const batch = operationBatchSchema.parse(request.body);
    const project = projects.get(request.params.id);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    return projects.applyOperations(project.id, batch.ops, batch.baseVersion);
  });

  app.get<{ Params: { id: string } }>('/projects/:id/oplog', async (request, reply) => {
    if (!projects.get(request.params.id)) return await reply.code(404).send({ error: 'Project not found' });
    return projects.operationLog(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/projects/:id/render', async (request, reply) => {
    const project = projects.get(request.params.id);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const { resolution } = renderRequestSchema.parse(request.body ?? {});
    return await reply.code(202).send(renderQueue.enqueue(project.id, resolution));
  });
}
