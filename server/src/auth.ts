import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * One shared password, checked before anything else runs. `EDITIFY_TOKEN`
 * unset leaves the server open, which is what local development wants; set it
 * and every route except `/health` (host healthchecks) needs it.
 *
 * ponytail: no user table, no sessions. Three clients ask three different
 * ways, so all three are accepted — `Authorization: Bearer` from the app's own
 * fetches, HTTP Basic so a browser prompts once and then carries the header
 * itself on `<video>`/`<img>` loads, and `?k=` for the native media players
 * that cannot set headers at all. Per-user auth if this ever leaves one team.
 */
export function registerAuth(app: FastifyInstance): void {
  const secret = process.env.EDITIFY_TOKEN;
  if (!secret) return;
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const query = request.query as { k?: string } | undefined;
    if (matches(offered(request.headers.authorization, query?.k), secret)) return;
    return await reply.code(401)
      .header('WWW-Authenticate', 'Basic realm="Editify"')
      .send({ error: 'Unauthorized' });
  });
}

function offered(header: string | undefined, key: string | undefined): string | undefined {
  if (typeof key === 'string') return key;
  const [scheme = '', value] = (header ?? '').split(' ');
  if (!value) return undefined;
  if (scheme.toLowerCase() === 'bearer') return value;
  // Basic is `user:password`; the username is ignored, the password is the token.
  if (scheme.toLowerCase() === 'basic') return Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
  return undefined;
}

function matches(candidate: string | undefined, secret: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
