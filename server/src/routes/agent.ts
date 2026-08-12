import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProviderRegistry } from '../agent/registry.js';

const selectSchema = z.object({
  provider: z.enum(['claude-cli', 'codex-cli', 'anthropic', 'openai', 'mock']),
}).strict();

export function registerAgentRoutes(app: FastifyInstance, registry: ProviderRegistry): void {
  app.get('/agent/provider', async () => await registry.status());

  app.put('/agent/provider', async (request, reply) => {
    const { provider } = selectSchema.parse(request.body);
    try {
      return await registry.select(provider);
    } catch (error) {
      return await reply.code(409).send({ error: error instanceof Error ? error.message : 'Provider is unavailable' });
    }
  });
}
