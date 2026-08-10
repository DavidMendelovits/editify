import type { FastifyInstance } from 'fastify';
import { styleAnalyzeSchema } from '@editify/shared';
import type { StyleService } from '../services/style-service.js';

export function registerStyleRoutes(app: FastifyInstance, styles: StyleService): void {
  app.post('/style-profile/analyze', async (request, reply) => {
    const { assetIds } = styleAnalyzeSchema.parse(request.body);
    return await reply.code(201).send(await styles.analyze(assetIds));
  });

  app.get('/style-profile', async (_request, reply) => {
    const profile = styles.latest();
    return profile ?? await reply.code(404).send({ error: 'No style profile yet' });
  });
}
