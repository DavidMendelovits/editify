import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { registerAuth, type AuthOptions } from './auth.js';
import { supabaseUrl } from './config.js';
import { EDITING_PRESETS } from '@editify/shared';
import { ZodError } from 'zod';
import { createProvider, type ToolProvider } from './agent/providers.js';
import { AgentService } from './agent/service.js';
import { AssetStore } from './db/asset-store.js';
import { ChatStore } from './db/chat-store.js';
import { createDatabase, type EditifyDatabase } from './db/database.js';
import { InsightStore } from './db/insight-store.js';
import { AssetAccessError, ProjectStore, VersionConflictError } from './db/project-store.js';
import { RenderStore } from './db/render-store.js';
import { ReportStore } from './db/report-store.js';
import { SettingsStore } from './db/settings-store.js';
import { TranscriptStore } from './db/transcript-store.js';
import { OperationError } from './operations/apply.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAgentTurnRoutes } from './routes/agent-turn.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerChatRoutes } from './routes/chat.js';
import { isLegalRoute, registerLegalRoutes } from './routes/legal.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRenderRoutes } from './routes/renders.js';
import { registerStyleRoutes } from './routes/style.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { ensureSoundLibrary } from './media/sound-library.js';
import { RenderQueue } from './services/render-queue.js';
import { DissectService } from './services/dissect-service.js';
import { SyncService } from './services/sync-service.js';
import { FaceService } from './services/face-service.js';
import { InsightService } from './services/insight-service.js';
import { StyleService } from './services/style-service.js';
import { StyleAnalyzerRegistry } from './style/registry.js';
import { ReproService } from './services/repro-service.js';
import { TelemetryService } from './services/telemetry-service.js';
import { setMediaJobLogger } from './services/media-jobs.js';
import { TranscriptService } from './services/transcript-service.js';

export interface AppOptions {
  database?: EditifyDatabase;
  logger?: boolean;
  /** Tests sign their own JWTs: a Supabase URL for the issuer and a local key set. */
  auth?: Pick<AuthOptions, 'supabaseUrl' | 'jwks'>;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  // Background jobs (renders, Whisper, encodes) run without a request: they log through this.
  setMediaJobLogger(app.log);
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
  const resolveProvider = async (): Promise<ToolProvider> => createProvider();
  const agent = new AgentService(resolveProvider);
  const transcripts = new TranscriptService(new TranscriptStore(database));
  const insights = new InsightService(new InsightStore(database), transcripts, resolveProvider);
  const styles = new StyleService(database, assets, agent, new StyleAnalyzerRegistry(settings));
  const renderQueue = new RenderQueue(renders, projects, assets);
  renderQueue.recover();
  const dissections = new DissectService(database);
  const syncs = new SyncService(assets);
  const faces = new FaceService(database);
  const telemetry = new TelemetryService(
    new ReportStore(database),
    resolveProvider,
    undefined,
    new ReproService(projects, assets, chats),
  );

  // EDITIFY_NO_AUTH=1 disables auth for local agent testing; every request
  // is unscoped (no userId) and sees every row. Ignored on Fly/production.
  const noAuth = process.env.EDITIFY_NO_AUTH === '1'
    && process.env.NODE_ENV !== 'production' && !process.env.FLY_APP_NAME;
  if (noAuth) app.log.warn('EDITIFY_NO_AUTH=1: serving all requests unauthenticated');
  else registerAuth(app, {
    sharedToken: process.env.EDITIFY_TOKEN,
    supabaseUrl,
    ...options.auth,
    // The exported web client is public — the sign-in screen IS the gate, so the
    // static wildcard route (and the index.html 404 fallback for deep links)
    // skip auth. Every other API route still demands credentials.
    // The legal pages are in the same boat for a different reason: App Store
    // Review fetches /privacy, /terms and /support with no credentials at all,
    // and a 401 there is a rejection.
    isPublic: (request) =>
      (request.method === 'GET' || request.method === 'HEAD') &&
      (request.routeOptions.url === '/*' ||
        isLegalRoute(request.routeOptions.url) ||
        (request.routeOptions.url === undefined && (request.headers.accept ?? '').includes('text/html'))),
    // POST /telemetry takes credentials when there are any and proceeds without
    // them when there are not: a crash on the sign-in screen has none to send,
    // and a report that only works once you are logged in cannot report a
    // broken login. Signed in, the token still resolves the user, which is what
    // scopes the project state the server attaches to the report.
    isOptional: (request) => request.method === 'POST' && request.routeOptions.url === '/telemetry',
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { files: 1, fileSize: 2 * 1024 * 1024 * 1024 } });
  await registerWebClient(app);

  app.get('/health', async () => ({ ok: true, provider: (await resolveProvider()).name }));
  app.get('/presets', async () => EDITING_PRESETS.map(({ name, description, targetContent }) => ({ name, description, targetContent })));
  // Built-in SFX/music, synthesized on first request and registered as assets.
  app.get('/sounds', async () => await ensureSoundLibrary(assets));
  registerLegalRoutes(app);
  registerAccountRoutes(app, database, styles);
  registerProjectRoutes(app, projects, renderQueue, assets, transcripts, syncs);
  registerAssetRoutes(app, assets, projects, transcripts, insights, dissections, database, faces);
  registerRenderRoutes(app, renders);
  registerStyleRoutes(app, styles);
  registerChatRoutes(app, projects, assets, chats, agent, styles, transcripts, insights, dissections, syncs, { faces, renders });
  registerAgentTurnRoutes(app, agent);
  registerTelemetryRoutes(app, telemetry);

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof VersionConflictError) {
      return await reply.code(409).send({ error: error.message, expected: error.expected, actual: error.actual });
    }
    if (error instanceof ZodError) {
      return await reply.code(400).send({ error: 'Validation failed', issues: error.issues });
    }
    if (error instanceof AssetAccessError) {
      return await reply.code(403).send({ error: error.message });
    }
    if (error instanceof OperationError) {
      return await reply.code(400).send({ error: error.message });
    }
    // Fastify's own refusals (413 body too large, 415, malformed JSON) keep their status.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return await reply.code(status).send({ error: error instanceof Error ? error.message : 'Bad request' });
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
