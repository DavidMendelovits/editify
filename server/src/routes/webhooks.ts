import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EditifyDatabase } from '../db/database.js';
import {
  missingKeyMessage,
  purgeUserData,
  serviceRoleKey,
  supabaseUserExists,
} from '../services/account-service.js';
import type { StyleService } from '../services/style-service.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook } from '../services/webhook-signature.js';

export const USER_DELETED_PATH = '/webhooks/supabase/user-deleted';

const UserDeleted = z.object({
  type: z.literal('user.deleted'),
  event_id: z.string().min(1).max(128),
  user_id: z.string().uuid(),
});

/**
 * Both servers (1.0 and 1.1) share one Supabase auth project, so deleting an
 * account on either has to clear it from both. A trigger on `auth.users`
 * (supabase/migrations) posts here after every delete; each server then purges
 * its own rows and media with the same code DELETE /account uses.
 *
 * Trust comes from the request itself, not a login: an HMAC over the raw body
 * with SUPABASE_WEBHOOK_SECRET, a timestamp no older than five minutes, and then
 * the admin API confirming the user really is gone. Without the secret the
 * route answers 503 and never runs unsigned.
 */
export async function registerWebhookRoutes(app: FastifyInstance, database: EditifyDatabase, styles?: StyleService): Promise<void> {
  await app.register(async (scope) => {
    // The MAC is over the exact bytes sent, so this scope keeps the body raw.
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => { done(null, body); });

    scope.post(USER_DELETED_PATH, { config: { selfAuthenticated: true }, bodyLimit: 64 * 1024 }, async (request, reply) => {
      if (process.env.READ_ONLY === '1') return await reply.code(503).send({ error: 'Server is read-only' });
      const secret = process.env.SUPABASE_WEBHOOK_SECRET;
      if (!secret) return await reply.code(503).send({ error: 'Webhook is not configured on this server' });

      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const verdict = verifyWebhook({
        secret,
        timestamp: header(request.headers[TIMESTAMP_HEADER]),
        signature: header(request.headers[SIGNATURE_HEADER]),
        rawBody,
      });
      if (!verdict.ok) {
        request.log.warn({ webhook: 'user-deleted', reason: verdict.reason }, 'webhook rejected');
        return await reply.code(401).send({ error: 'Invalid signature', reason: verdict.reason });
      }

      const parsed = UserDeleted.safeParse(parseJson(rawBody));
      if (!parsed.success) return await reply.code(400).send({ error: 'Not a user.deleted event' });
      const { event_id: eventId, user_id: userId } = parsed.data;

      ensureEventTable(database);
      if (database.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get(eventId)) {
        request.log.info({ audit: 'user-deleted', eventId, userId, duplicate: true }, 'user-deleted event already processed');
        return await reply.code(200).send({ status: 'duplicate', eventId });
      }

      if (!serviceRoleKey()) return await reply.code(503).send({ error: missingKeyMessage() });
      let exists: boolean;
      try {
        exists = await supabaseUserExists(userId);
      } catch (error) {
        request.log.error({ webhook: 'user-deleted', eventId, userId, error: (error as Error).message }, 'could not confirm the delete');
        return await reply.code(503).send({ error: 'Could not confirm the user is gone' });
      }
      if (exists) {
        request.log.warn({ audit: 'user-deleted', eventId, userId, refused: 'user-exists' }, 'user-deleted event refused: the user still exists');
        return await reply.code(409).send({ error: 'User still exists' });
      }

      const purged = await purgeUserData(database, userId, styles);
      database.prepare(
        'INSERT OR IGNORE INTO webhook_events (event_id, kind, user_id, processed_at, result_json) VALUES (?, ?, ?, ?, ?)',
      ).run(eventId, 'user.deleted', userId, new Date().toISOString(), JSON.stringify(purged));
      request.log.info({ audit: 'user-deleted', eventId, userId, rows: purged.rows, files: purged.files }, 'purged user data');
      return await reply.code(200).send({ status: 'purged', eventId, purged });
    });
  });
}

/**
 * Created on first use rather than at boot: a read-only server opens SQLite
 * read-only, and it never reaches this line (it answers 503 above).
 */
function ensureEventTable(database: EditifyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      user_id TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      result_json TEXT NOT NULL
    )
  `);
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseJson(raw: Buffer): unknown {
  try { return JSON.parse(raw.toString('utf8')); } catch { return undefined; }
}
