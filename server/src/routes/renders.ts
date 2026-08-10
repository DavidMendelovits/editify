import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { RenderStore } from '../db/render-store.js';

export function registerRenderRoutes(app: FastifyInstance, renders: RenderStore): void {
  app.get<{ Params: { id: string } }>('/renders/:id', async (request, reply) => {
    const render = renders.get(request.params.id);
    return render ?? await reply.code(404).send({ error: 'Render not found' });
  });

  app.get<{ Params: { id: string } }>('/renders/:id/file.mp4', async (request, reply) => {
    const render = renders.get(request.params.id);
    const outputPath = renders.outputPath(request.params.id);
    if (!render || render.status !== 'done' || !outputPath) return await reply.code(404).send({ error: 'Render output not found' });
    return reply.type('video/mp4').header('Content-Disposition', `attachment; filename="editify-${render.id}.mp4"`).send(createReadStream(outputPath));
  });
}
