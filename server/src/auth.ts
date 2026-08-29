import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { supabaseUrl } from './config.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

export interface AuthOptions {
  sharedToken?: string | undefined;
  supabaseUrl?: string | undefined;
  jwks?: JWTVerifyGetKey;
  /** Requests this returns true for skip auth entirely (e.g. the static web client). */
  isPublic?: (request: FastifyRequest) => boolean;
}

/**
 * Three clients offer credentials three different ways: Bearer from fetches,
 * Basic for browser media loads, and `?k=` for native media players.
 */
export function registerAuth(app: FastifyInstance, options?: AuthOptions): void {
  const { sharedToken, supabaseUrl: authUrl, jwks, isPublic } = options ?? {
    sharedToken: process.env.EDITIFY_TOKEN,
    supabaseUrl,
  };
  const keySet = authUrl
    ? jwks ?? createRemoteJWKSet(new URL(`${authUrl}/auth/v1/.well-known/jwks.json`))
    : undefined;
  if (!sharedToken && !keySet) return;

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    if (isPublic?.(request)) return;
    const query = request.query as { k?: string } | undefined;
    const candidate = offered(request.headers.authorization, query?.k);

    if (candidate && keySet && candidate.split('.').length === 3) {
      try {
        const { payload } = await jwtVerify(candidate, keySet, {
          issuer: `${authUrl}/auth/v1`,
          // ponytail: this project's signing keys are ES256 only.
          algorithms: ['ES256'],
        });
        if (typeof payload.sub !== 'string') throw new Error('JWT subject is missing');
        request.userId = payload.sub;
        return;
      } catch {
        // A JWT-shaped shared token still gets its timing-safe comparison.
      }
    }

    if (sharedToken && matches(candidate, sharedToken)) return;
    // No WWW-Authenticate header: it makes browsers pop a native password
    // dialog on any 401'd fetch or media load. Clients attach tokens themselves.
    return await reply.code(401).send({ error: 'Unauthorized' });
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
