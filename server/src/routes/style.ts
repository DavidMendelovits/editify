import type { FastifyInstance } from 'fastify';
import { styleAnalyzeSchema } from '@editify/shared';
import type { StyleService } from '../services/style-service.js';

export function registerStyleRoutes(app: FastifyInstance, styles: StyleService): void {
  app.post('/style-profile/analyze', async (request, reply) => {
    const { assetIds } = styleAnalyzeSchema.parse(request.body);
    const missing = styles.missingAsset(assetIds);
    if (missing) return await reply.code(404).send({ error: `Asset ${missing} was not found` });
    // Per-asset ffmpeg scans plus an LLM call take minutes; the client polls
    // GET /style-profile for the run state instead of holding the request open.
    return await reply.code(202).send(styles.start(assetIds));
  });

  app.get('/style-profile', async (_request, reply) => {
    const state = styles.state();
    const profile = styles.latest();
    if (!profile) return await reply.code(404).send({ error: state.error ?? 'No style profile yet', status: state.status });
    return { ...profile, status: state.status, ...(state.error ? { error: state.error } : {}) };
  });
}
