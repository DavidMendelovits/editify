import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth.js';
import { supabaseUrl } from './config.js';
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
import { ReportStore } from './db/report-store.js';
import { SettingsStore } from './db/settings-store.js';
import { TranscriptStore } from './db/transcript-store.js';
import { OperationError } from './operations/apply.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRenderRoutes } from './routes/renders.js';
import { registerStyleRoutes } from './routes/style.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { ensureSoundLibrary } from './media/sound-library.js';
import { RenderQueue } from './services/render-queue.js';
import { DissectService } from './services/dissect-service.js';
import { InsightService } from './services/insight-service.js';
import { StyleService } from './services/style-service.js';
import { ReproService } from './services/repro-service.js';
import { TelemetryService } from './services/telemetry-service.js';
import { TranscriptService } from './services/transcript-service.js';

export interface AppOptions { database?: EditifyDatabase; logger?: boolean }

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  // The client sends `Content-Type: application/json` on every request, body or
  // not, and fastify's default parser 500s on an empty one. Bodyless POST/DELETE
  // (select, duplicate, delete) are ordinary calls — read them as `{}`.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body: string, done) => {
    try { done(null, body ? JSON.parse(body) : {}); } catch (error) { done(error as Error, undefined); }
  });
  const database = options.database ?? createDatabase();
  const projects = new ProjectStore(database);
  const assets = new AssetStore(database);
  const renders = new RenderStore(database);
  const chats = new ChatStore(database);
  const settings = new SettingsStore(database);
  const registry = new ProviderRegistry(settings);
  const resolveProvider = async (): Promise<ToolProvider> => await registry.resolve();
  const agent = new AgentService(resolveProvider);
  const transcripts = new TranscriptService(new TranscriptStore(database));
  const insights = new InsightService(new InsightStore(database), transcripts, resolveProvider);
  const styles = new StyleService(database, assets, agent);
  const renderQueue = new RenderQueue(renders, projects, assets);
  renderQueue.recover();
  const dissections = new DissectService(database);
  const telemetry = new TelemetryService(
    new ReportStore(database),
    resolveProvider,
    undefined,
    new ReproService(projects, assets, chats, settings),
  );

  // EDITIFY_NO_AUTH=1 disables auth for local agent testing; every request
  // lands in the shared (NULL userId) scope. Ignored on Fly/production.
  const noAuth = process.env.EDITIFY_NO_AUTH === '1'
    && process.env.NODE_ENV !== 'production' && !process.env.FLY_APP_NAME;
  if (noAuth) app.log.warn('EDITIFY_NO_AUTH=1: serving all requests unauthenticated');
  else registerAuth(app, {
    sharedToken: process.env.EDITIFY_TOKEN,
    supabaseUrl,
    // The exported web client is public — the sign-in screen IS the gate, so the
    // static wildcard route (and the index.html 404 fallback for deep links)
    // skip auth. POST /telemetry joins them because a crash on the sign-in
    // screen has no credentials to send, and a report that only works once you
    // are logged in cannot report a broken login. Every other API route still
    // demands credentials.
    isPublic: (request) =>
      (request.method === 'POST' && request.routeOptions.url === '/telemetry') ||
      ((request.method === 'GET' || request.method === 'HEAD') &&
        (request.routeOptions.url === '/*' ||
          (request.routeOptions.url === undefined && (request.headers.accept ?? '').includes('text/html')))),
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { files: 1, fileSize: 2 * 1024 * 1024 * 1024 } });
  await registerWebClient(app);

  app.get('/health', async () => ({ ok: true, provider: (await resolveProvider()).name }));
  app.get('/presets', async () => EDITING_PRESETS.map(({ name, description, targetContent }) => ({ name, description, targetContent })));
  // Built-in SFX/music, synthesized on first request and registered as assets.
  app.get('/sounds', async () => await ensureSoundLibrary(assets));
  registerAgentRoutes(app, registry);
  registerProjectRoutes(app, projects, renderQueue, assets, transcripts);
  registerAssetRoutes(app, assets, projects, transcripts, insights, dissections, database);
  registerRenderRoutes(app, renders);
  registerStyleRoutes(app, styles);
  registerChatRoutes(app, projects, assets, chats, agent, styles, transcripts, insights, dissections);
  registerTelemetryRoutes(app, telemetry);

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

/**
 * `EDITIFY_WEB_DIR` points at an `expo export --platform web` build and serves
 * it from the API's own origin, so the browser client needs no CORS and no
 * baked-in token — same-origin requests inherit whatever credentials the Basic
 * prompt collected. Unset in development, where Metro serves the client.
 */
async function registerWebClient(app: FastifyInstance): Promise<void> {
  const webDir = process.env.EDITIFY_WEB_DIR;
  if (!webDir) return;
  await app.register(fastifyStatic, { root: resolve(webDir) });
  // `output: "single"` means one index.html and client-side routing; deep links
  // land here. Only HTML requests fall back, so a mistyped API path still 404s.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')) {
      return await reply.sendFile('index.html');
    }
    return await reply.code(404).send({ error: 'Not found' });
  });
}
