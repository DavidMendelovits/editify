import type { FastifyInstance } from 'fastify';
import type { EditifyDatabase } from '../db/database.js';
import type { StyleService } from '../services/style-service.js';
import {
  deleteSupabaseUser,
  deleteUserData,
  missingKeyMessage,
  serviceRoleKey,
} from '../services/account-service.js';

/**
 * App Store guideline 5.1.1(v): an account created in the app has to be
 * deletable from it. The key is read per request, never at boot, so a server
 * without one still starts and simply answers 503 here.
 */
export function registerAccountRoutes(app: FastifyInstance, database: EditifyDatabase, styles?: StyleService): void {
  app.delete('/account', async (request, reply) => {
    const userId = request.userId;
    // Shared-token and EDITIFY_NO_AUTH requests are nobody in particular, so
    // there is no account to delete and nothing safe to guess at.
    if (!userId) return await reply.code(400).send({ error: 'Account deletion requires a signed-in user' });
    if (!serviceRoleKey()) return await reply.code(503).send({ error: missingKeyMessage() });

    // Data first: if the login went first, a failure here would strand rows
    // whose owner can no longer sign in to try again.
    await deleteUserData(database, userId, styles);
    await deleteSupabaseUser(userId);
    return await reply.code(204).send();
  });
}
