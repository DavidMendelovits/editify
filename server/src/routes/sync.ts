import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OperationError, syncCreateRequestSchema, syncPushRequestSchema } from '@editify/shared';
import {
  SyncConflictError,
  SyncMismatchError,
  SyncNotFoundError,
  SyncProjectTakenError,
  type PgSyncStore,
} from '../db/pg-sync-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/**
 * Device-authoritative project sync (D3, 4A), backed by Postgres. Without
 * DATABASE_URL every route answers 503 and nothing else changes: the SQLite
 * /projects routes are separate and keep working.
 *
 *   POST   /sync/projects                 { project }  register the phone's project (idempotent by id)
 *   GET    /sync/projects                 this user's synced projects
 *   GET    /sync/projects/:id             { project, revision, seq }
 *   GET    /sync/projects/:id/log?since=  log rows after seq `since`, oldest first
 *   POST   /sync/projects/:id/changes     { changeId, baseRevision, ops, runId?, expectedHash? } ─▶ { receipt }
 *   DELETE /sync/projects/:id
 *
 * A push answers 409 { code: 'stale', revision } when the project moved on,
 * and 422 { code: 'mismatch' } when the server's result differs from the
 * phone's. A repeated changeId gets its original receipt.
 */
export function registerSyncRoutes(app: FastifyInstance, store: PgSyncStore | undefined): void {
  /** Sync rows belong to a Supabase user; shared-token and unauthenticated callers have none. */
  const userOf = async (request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
    if (!store) {
      await reply.code(503).send({ error: 'sync not configured' });
      return undefined;
    }
    if (!request.userId || !UUID.test(request.userId)) {
      await reply.code(401).send({ error: 'Sign in to sync projects.' });
      return undefined;
    }
    return request.userId;
  };

  const fail = async (reply: FastifyReply, error: unknown): Promise<FastifyReply> => {
    if (error instanceof z.ZodError) return await reply.code(400).send({ error: 'Validation failed', issues: error.issues });
    if (error instanceof SyncNotFoundError) return await reply.code(404).send({ error: 'Project not found' });
    if (error instanceof SyncConflictError) {
      return await reply.code(409).send({ error: error.message, code: 'stale', expected: error.expected, revision: error.actual });
    }
    if (error instanceof SyncProjectTakenError) return await reply.code(409).send({ error: error.message, code: 'taken' });
    if (error instanceof SyncMismatchError) {
      return await reply.code(422).send({ error: error.message, code: 'mismatch', hash: error.actualHash });
    }
    if (error instanceof OperationError) return await reply.code(400).send({ error: error.message });
    throw error;
  };

  app.post('/sync/projects', async (request, reply) => {
    const user = await userOf(request, reply);
    if (!user || !store) return reply;
    try {
      const { project } = syncCreateRequestSchema.parse(request.body);
      const result = await store.create(user, project);
      return await reply.code(result.created ? 201 : 200)
        .send({ project: result.project, revision: result.revision, seq: result.seq });
    } catch (error) {
      return await fail(reply, error);
    }
  });

  app.get('/sync/projects', async (request, reply) => {
    const user = await userOf(request, reply);
    if (!user || !store) return reply;
    return await store.list(user);
  });

  app.get<{ Params: { id: string } }>('/sync/projects/:id', async (request, reply) => {
    const user = await userOf(request, reply);
    if (!user || !store) return reply;
    const synced = await store.get(user, request.params.id);
    return synced ?? await reply.code(404).send({ error: 'Project not found' });
  });

  app.get<{ Params: { id: string } }>('/sync/projects/:id/log', async (request, reply) => {
    const user = await userOf(request, reply);
    if (!user || !store) return reply;
    try {
      const { since, limit } = logQuerySchema.parse(request.query);
      const entries = await store.log(user, request.params.id, since, limit);
      return entries ? { entries } : await reply.code(404).send({ error: 'Project not found' });
    } catch (error) {
      return await fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/sync/projects/:id/changes', async (request, reply) => {
    const user = await userOf(request, reply);
    if (!user || !store) return reply;
    try {
      const push = syncPushRequestSchema.parse(request.body);
      const { receipt, duplicate } = await store.push(user, request.params.id, push);
      if (duplicate) void reply.header('editify-sync-replay', 'true');
      return { receipt };
    } catch (error) {
      return await fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/sync/projects/:id', async (request, reply) => {
    const user = await userOf(request, reply);
    if (!user || !store) return reply;
    return await store.delete(user, request.params.id)
      ? await reply.code(204).send()
      : await reply.code(404).send({ error: 'Project not found' });
  });
}
