import type { FastifyInstance } from 'fastify';
import { styleAnalyzeSchema, styleAnalyzerSelectSchema, styleRenameSchema } from '@editify/shared';
import type { StyleService } from '../services/style-service.js';

export function registerStyleRoutes(app: FastifyInstance, styles: StyleService): void {
  app.post('/style-profile/analyze', async (request, reply) => {
    const { assetIds, name, analyzer, refresh } = styleAnalyzeSchema.parse(request.body);
    const missing = styles.missingAsset(assetIds);
    if (missing) return await reply.code(404).send({ error: `Asset ${missing} was not found` });
    if (analyzer && !styles.analyzers.get(analyzer)) return await reply.code(404).send({ error: `Analyzer ${analyzer} was not found` });
    // Per-asset ffmpeg scans, a model watching each video, and an LLM call take
    // minutes; the client polls GET /style-profile for the run state instead of
    // holding the request open.
    return await reply.code(202).send(styles.start(assetIds, { ...(name ? { name } : {}), ...(analyzer ? { analyzer } : {}), ...(refresh ? { refresh } : {}) }));
  });

  /** Which video analyzer watches the clips: Gemini, an external service, a local chain, or ffmpeg only. */
  app.get('/style/analyzer', async () => await styles.analyzers.status());

  app.put('/style/analyzer', async (request, reply) => {
    const { analyzer } = styleAnalyzerSelectSchema.parse(request.body);
    try {
      return await styles.analyzers.select(analyzer);
    } catch (error) {
      return await reply.code(409).send({ error: error instanceof Error ? error.message : 'Analyzer is unavailable' });
    }
  });

  /** The selected profile — what every edit conversation is briefed with. */
  app.get('/style-profile', async (_request, reply) => {
    const state = styles.state();
    const profile = styles.selected();
    if (!profile) return await reply.code(404).send({ error: state.error ?? 'No style profile yet', ...state });
    return { ...profile, ...state };
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
