import type { FastifyInstance } from 'fastify';
import type { RenderStore } from '../db/render-store.js';
import { sendMediaFile } from '../media/send-file.js';

export function registerRenderRoutes(app: FastifyInstance, renders: RenderStore): void {
  app.get<{ Params: { id: string } }>('/renders/:id', async (request, reply) => {
    const render = renders.get(request.params.id);
    return render ?? await reply.code(404).send({ error: 'Render not found' });
  });

  app.get<{ Params: { id: string } }>('/renders/:id/file.mp4', async (request, reply) => {
    const render = renders.get(request.params.id);
    const outputPath = renders.outputPath(request.params.id);
    if (!render || render.status !== 'done' || !outputPath) return await reply.code(404).send({ error: 'Render output not found' });
    reply.header('Content-Disposition', `attachment; filename="editify-${render.id}.mp4"`);
    return await sendMediaFile(reply, outputPath, 'video/mp4', request.headers.range);
  });
}
