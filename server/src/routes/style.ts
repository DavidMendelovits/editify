import type { FastifyInstance } from 'fastify';
import { styleAnalyzeSchema, styleRenameSchema } from '@editify/shared';
import type { StyleService } from '../services/style-service.js';

export function registerStyleRoutes(app: FastifyInstance, styles: StyleService): void {
  app.post('/style-profile/analyze', async (request, reply) => {
    const { assetIds, name } = styleAnalyzeSchema.parse(request.body);
    const missing = styles.missingAsset(assetIds);
    if (missing) return await reply.code(404).send({ error: `Asset ${missing} was not found` });
    // Per-asset ffmpeg scans plus an LLM call take minutes; the client polls
    // GET /style-profile for the run state instead of holding the request open.
    return await reply.code(202).send(styles.start(assetIds, name));
  });

  /** The selected profile — what every edit conversation is briefed with. */
  app.get('/style-profile', async (_request, reply) => {
    const state = styles.state();
    const profile = styles.selected();
    if (!profile) return await reply.code(404).send({ error: state.error ?? 'No style profile yet', status: state.status });
    return { ...profile, status: state.status, ...(state.error ? { error: state.error } : {}) };
  });

  app.get('/style-profiles', async () => ({ profiles: styles.list(), selectedId: styles.selectedId() ?? null }));

  app.post('/style-profiles/:id/select', async (request, reply) => {
    const profile = styles.select((request.params as { id: string }).id);
    return profile ?? await reply.code(404).send({ error: 'Style profile was not found' });
  });

  app.patch('/style-profiles/:id', async (request, reply) => {
    const { name } = styleRenameSchema.parse(request.body);
    const profile = styles.rename((request.params as { id: string }).id, name);
    return profile ?? await reply.code(404).send({ error: 'Style profile was not found' });
  });

  app.post('/style-profiles/:id/duplicate', async (request, reply) => {
    const profile = styles.duplicate((request.params as { id: string }).id);
    return profile ? await reply.code(201).send(profile) : await reply.code(404).send({ error: 'Style profile was not found' });
  });

  app.delete('/style-profiles/:id', async (request, reply) => {
    if (!styles.remove((request.params as { id: string }).id)) return await reply.code(404).send({ error: 'Style profile was not found' });
    return { ok: true, selectedId: styles.selectedId() ?? null };
  });
}
