import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { EDITING_PRESETS } from '@editify/shared';
import { ZodError } from 'zod';
import type { ToolProvider } from './agent/providers.js';
import { ProviderRegistry } from './agent/registry.js';
import { AgentService } from './agent/service.js';
import { AssetStore } from './db/asset-store.js';
import { ChatStore } from './db/chat-store.js';
import { createDatabase, type EditifyDatabase } from './db/database.js';
import { InsightStore } from './db/insight-store.js';
import { ProjectStore, VersionConflictError } from './db/project-store.js';
import { RenderStore } from './db/render-store.js';
import { SettingsStore } from './db/settings-store.js';
import { TranscriptStore } from './db/transcript-store.js';
import { OperationError } from './operations/apply.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRenderRoutes } from './routes/renders.js';
import { registerStyleRoutes } from './routes/style.js';
import { RenderQueue } from './services/render-queue.js';
import { InsightService } from './services/insight-service.js';
import { StyleService } from './services/style-service.js';
import { TranscriptService } from './services/transcript-service.js';

export interface AppOptions { database?: EditifyDatabase; logger?: boolean }

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  const database = options.database ?? createDatabase();
  const projects = new ProjectStore(database);
  const assets = new AssetStore(database);
  const renders = new RenderStore(database);
  const chats = new ChatStore(database);
  const registry = new ProviderRegistry(new SettingsStore(database));
  const resolveProvider = (): ToolProvider => registry.resolve();
  const agent = new AgentService(resolveProvider);
  const transcripts = new TranscriptService(new TranscriptStore(database));
  const insights = new InsightService(new InsightStore(database), transcripts, resolveProvider);
  const styles = new StyleService(database, assets, agent);
  const renderQueue = new RenderQueue(renders, projects, assets);

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { files: 1, fileSize: 2 * 1024 * 1024 * 1024 } });

  app.get('/health', async () => ({ ok: true, provider: resolveProvider().name }));
  app.get('/presets', async () => EDITING_PRESETS.map(({ name, description, targetContent }) => ({ name, description, targetContent })));
  registerAgentRoutes(app, registry);
  registerProjectRoutes(app, projects, renderQueue);
  registerAssetRoutes(app, assets, projects, transcripts, insights);
  registerRenderRoutes(app, renders);
  registerStyleRoutes(app, styles);
  registerChatRoutes(app, projects, assets, chats, agent, styles, transcripts, insights);

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof VersionConflictError) {
      return await reply.code(409).send({ error: error.message, expected: error.expected, actual: error.actual });
    }
    if (error instanceof ZodError) {
      return await reply.code(400).send({ error: 'Validation failed', issues: error.issues });
    }
    if (error instanceof OperationError) {
      return await reply.code(400).send({ error: error.message });
    }
    app.log.error(error);
    return await reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
  });

  app.addHook('onClose', async () => { database.close(); });
  return app;
}
