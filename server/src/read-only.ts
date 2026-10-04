import type { FastifyInstance } from 'fastify';

/**
 * READ_ONLY=1 freezes this server for the 1.1 cutover (plan C7/C20): the
 * importer has copied its data, so nothing may change underneath the copy.
 * "Read-only" means no writers of any kind:
 *
 * - SQLite opens with the read-only flag (`createDatabase`), so a writer this
 *   list missed throws SQLITE_READONLY instead of writing.
 * - Render recovery is skipped at boot, and every request that would write
 *   (any method but GET/HEAD/OPTIONS) gets a 503 with Retry-After.
 * - Cache-on-read paths (waveforms, dissections, insights, the sound library,
 *   thumbnails, filmstrips) serve what they compute without storing it.
 * - /health and /client-config keep answering.
 *
 * Drain the job queue before flipping it (`src/drain.ts`): a restart into
 * read-only mode cannot finish or fail a render that was mid-encode.
 */
export function readOnlyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.READ_ONLY === '1';
}

export const READ_ONLY_RETRY_AFTER_SECONDS = 300;
export const READ_ONLY_MESSAGE = 'Editify is updating. Your projects are safe, and you can still view and download them.';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The 503 body and headers every refused write gets. */
export function readOnlyReply<T extends { code: (status: number) => T; header: (name: string, value: string) => T }>(reply: T): T {
  return reply.code(503).header('Retry-After', String(READ_ONLY_RETRY_AFTER_SECONDS));
}

/**
 * Registered before auth, so a write is refused the same way whoever sends
 * it: there is nothing it could do even with valid credentials.
 */
export function registerReadOnlyGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (READ_METHODS.has(request.method)) return;
    return await readOnlyReply(reply).send({ error: READ_ONLY_MESSAGE, readOnly: true });
  });
}
