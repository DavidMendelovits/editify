import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RenderStore } from '../db/render-store.js';
import { sendMediaFile } from '../media/send-file.js';

export function registerRenderRoutes(app: FastifyInstance, renders: RenderStore): void {
  app.get<{ Params: { id: string } }>('/renders/:id', async (request, reply) => {
    const render = renders.get(request.params.id, request.userId);
    return render ?? await reply.code(404).send({ error: 'Render not found' });
  });

  app.get<{ Params: { id: string } }>('/renders/:id/file.mp4', async (request, reply) => {
    const render = renders.get(request.params.id, request.userId);
    const outputPath = renders.outputPath(request.params.id);
    if (!render || render.status !== 'done' || !outputPath) return await reply.code(404).send({ error: 'Render output not found' });
    reply.header('Content-Disposition', `attachment; filename="editify-${render.id}.mp4"`);
    return await sendMediaFile(reply, outputPath, 'video/mp4', request.headers.range);
  });

  app.get<{ Params: { id: string } }>('/renders/:id/contact.jpg', async (request, reply) => {
    const render = renders.get(request.params.id, request.userId);
    const outputPath = renders.outputPath(request.params.id);
    const sheet = outputPath ? join(dirname(outputPath), 'contact.jpg') : undefined;
    if (!render || !sheet || !existsSync(sheet)) return await reply.code(404).send({ error: 'Contact sheet not found' });
    return await sendMediaFile(reply, sheet, 'image/jpeg', request.headers.range);
  });
}
