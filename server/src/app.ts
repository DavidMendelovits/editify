import { hostname } from 'node:os';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { registerAuth, type AuthOptions } from './auth.js';
import { buildInfo, databaseUrl as configuredDatabaseUrl, supabaseUrl } from './config.js';
import { EDITING_PRESETS } from '@editify/shared';
import { ZodError } from 'zod';
import { createProvider, type ToolProvider } from './agent/providers.js';
import { AgentService } from './agent/service.js';
import { AssetStore } from './db/asset-store.js';
import { ChatStore } from './db/chat-store.js';
import { createDatabase, type EditifyDatabase } from './db/database.js';
import { InsightStore } from './db/insight-store.js';
import { PgSyncStore } from './db/pg-sync-store.js';
import { createPgPools } from './db/postgres.js';
import { PgTurnLock } from './db/pg-turn-lock.js';
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
import { isClientConfigRoute, registerClientConfigRoutes } from './routes/client-config.js';
import { isLegalRoute, registerLegalRoutes } from './routes/legal.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRenderRoutes } from './routes/renders.js';
import { registerStyleRoutes } from './routes/style.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { ensureSoundLibrary } from './media/sound-library.js';
import { RenderQueue } from './services/render-queue.js';
import { UnsupportedMediaError } from './media/process.js';
import { DissectService } from './services/dissect-service.js';
import { SyncService } from './services/sync-service.js';
import { FaceService } from './services/face-service.js';
import { InsightService } from './services/insight-service.js';
import { StyleService } from './services/style-service.js';
import { StyleAnalyzerRegistry } from './style/registry.js';
import { ReproService } from './services/repro-service.js';
import { TelemetryService } from './services/telemetry-service.js';
import { clearMediaJobLogger, setMediaJobLogger } from './services/media-jobs.js';
import { TranscriptService } from './services/transcript-service.js';
import { mediaSlots } from './services/media-slots.js';
import { readOnlyFromEnv, registerReadOnlyGate } from './read-only.js';
import { checkpointAndClose } from './shutdown.js';

export interface AppOptions {
  database?: EditifyDatabase;
  logger?: boolean;
  /** Tests sign their own JWTs: a Supabase URL for the issuer and a local key set. */
  auth?: Pick<AuthOptions, 'supabaseUrl' | 'jwks'>;
  /** Postgres for project sync; defaults to DATABASE_URL, and null turns it off. */
  databaseUrl?: string | null;
  /** The cutover freeze (see `read-only.ts`). Default: READ_ONLY=1. */
  readOnly?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  // Every log line names the line (1.0 / 1.1) and the commit that wrote it (C12), next to
  // pino's usual pid and hostname: both lines' logs can be read side by side.
  const logger = options.logger ? { base: { pid: process.pid, hostname: hostname(), ...buildInfo() } } : false;
  const app = Fastify({ logger, bodyLimit: 20 * 1024 * 1024 });
  // Background jobs (renders, Whisper, encodes) run without a request: they log through this.
  setMediaJobLogger(app.log);
  app.addHook('onClose', async () => clearMediaJobLogger(app.log));
  // The client sends `Content-Type: application/json` on every request, body or
  // not, and fastify's default parser 500s on an empty one. Bodyless POST/DELETE
  // (select, duplicate, delete) are ordinary calls — read them as `{}`.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body: string, done) => {
    try { done(null, body ? JSON.parse(body) : {}); } catch (error) { done(error as Error, undefined); }
  });
  const readOnly = options.readOnly ?? readOnlyFromEnv();
  const database = options.database ?? createDatabase(undefined, { readonly: readOnly });
  if (readOnly && !database.readonly) throw new Error('READ_ONLY=1 needs the database opened read-only');
  const databaseUrl = options.databaseUrl === undefined ? configuredDatabaseUrl : options.databaseUrl ?? undefined;
  // Throws on an unsafe configuration (remote host without TLS settled), so a bad deploy fails at boot.
  const pg = databaseUrl ? createPgPools(databaseUrl) : undefined;
  if (pg) app.log.info({ schema: pg.schema }, 'project sync on Postgres');
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
  // Read-only: no recovery. Re-queueing a stranded render is itself a write,
  // and the queue it would feed can never run. Drain before flipping instead.
  if (!readOnly) renderQueue.recover();
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
  if (readOnly) {
    app.log.warn('READ_ONLY=1: SQLite is read-only and every write request answers 503');
    registerReadOnlyGate(app);
  }
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
        // The update gate has to reach signed-out phones too.
        isClientConfigRoute(request.routeOptions.url) ||
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

  // line + commit: which server line (1.0 on editify-dm, 1.1 on editify-v11) and build answered.
  app.get('/health', async () => ({
    ok: true,
    ...buildInfo(),
    provider: (await resolveProvider()).name,
    readOnly,
    // What `src/drain.ts` waits on before the operator sets READ_ONLY=1.
    jobs: pendingJobs(renders, database),
    // Whether this machine has Postgres project sync (DATABASE_URL), so the deploy smoke knows to check /sync.
    sync: Boolean(pg),
  }));
  app.get('/presets', async () => EDITING_PRESETS.map(({ name, description, targetContent }) => ({ name, description, targetContent })));
  // Built-in SFX/music, synthesized on first request and registered as assets.
  app.get('/sounds', async () => await ensureSoundLibrary(assets, readOnly));
  registerLegalRoutes(app);
  registerClientConfigRoutes(app);
  registerAccountRoutes(app, database, styles);
  await registerWebhookRoutes(app, database, styles);
  registerProjectRoutes(app, projects, renderQueue, assets, transcripts, syncs);
  registerAssetRoutes(app, assets, projects, transcripts, insights, dissections, database, faces);
  registerRenderRoutes(app, renders);
  registerStyleRoutes(app, styles);
  registerChatRoutes(app, projects, assets, chats, agent, styles, transcripts, insights, dissections, syncs, { faces, renders });
  registerAgentTurnRoutes(app, agent, pg?.lock ? { lock: new PgTurnLock(pg.lock, pg.schema) } : {});
  registerSyncRoutes(app, pg ? new PgSyncStore(pg.sync, pg.schema) : undefined);
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
    if (error instanceof UnsupportedMediaError) {
      return await reply.code(415).send({ error: error.message });
    }
    // Fastify's own refusals (413 body too large, 415, malformed JSON) keep their status.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return await reply.code(status).send({ error: error instanceof Error ? error.message : 'Bad request' });
    }
    app.log.error(error);
    return await reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
  });

  // Every request has finished by now: fold the WAL into editify.db before closing.
  app.addHook('onClose', async () => {
    checkpointAndClose(database, (line) => app.log.warn(line));
    await pg?.end();
  });
  return app;
}

export interface PendingJobs {
  /** Renders queued or encoding (rows, so a crashed process's strays count too). */
  renders: number;
  /** Imports whose proxy and thumbnail are still being made. */
  imports: number;
  /** Media jobs holding or waiting for a slot: encodes, renders, whisper runs. */
  media: number;
}

export function pendingJobs(renders: RenderStore, database: EditifyDatabase): PendingJobs {
  const imports = database.prepare("SELECT COUNT(*) AS count FROM assets WHERE status = 'processing'").get() as { count: number };
  return {
    renders: renders.unfinished().length,
    imports: imports.count,
    media: mediaSlots.active().length + mediaSlots.queued().length,
  };
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
