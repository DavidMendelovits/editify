import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type GenerateKeyPairResult,
  type JWTVerifyGetKey,
} from 'jose';
import { registerAuth, type AuthOptions } from './auth.js';

const testSupabaseUrl = 'https://example.supabase.co';

let privateKey: GenerateKeyPairResult['privateKey'];
let jwks: JWTVerifyGetKey;

beforeEach(async () => {
  const keyPair = await generateKeyPair('ES256');
  privateKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: 'ES256', kid: 'test-key', use: 'sig' }],
  });
  delete process.env.EDITIFY_TOKEN;
  delete process.env.SUPABASE_URL;
});

afterEach(() => {
  delete process.env.EDITIFY_TOKEN;
  delete process.env.SUPABASE_URL;
});

function serve(options: AuthOptions = {}): FastifyInstance {
  const app = Fastify();
  registerAuth(app, options);
  app.get('/health', async () => ({ ok: true }));
  app.get('/projects', async (request) => ({ userId: request.userId }));
  return app;
}

async function accessToken(subject = 'user-123', expiresAt = Math.floor(Date.now() / 1000) + 300): Promise<string> {
  return await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(`${testSupabaseUrl}/auth/v1`)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}

describe('Supabase auth', () => {
  it('accepts a valid JWT as bearer, basic, or query key and exposes its subject', async () => {
    const app = serve({ supabaseUrl: testSupabaseUrl, jwks });
    const token = await accessToken();
    const basic = Buffer.from(`editify:${token}`).toString('base64');

    for (const request of [
      { url: '/projects', headers: { authorization: `Bearer ${token}` } },
      { url: '/projects', headers: { authorization: `Basic ${basic}` } },
      { url: `/projects?k=${token}` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ userId: 'user-123' });
    }
  });

  it('rejects expired and garbage JWTs', async () => {
    const app = serve({ sharedToken: 's3cret', supabaseUrl: testSupabaseUrl, jwks });
    const expired = await accessToken('expired-user', Math.floor(Date.now() / 1000) - 60);

    expect((await app.inject({
      url: '/projects',
      headers: { authorization: `Bearer ${expired}` },
    })).statusCode).toBe(401);
    expect((await app.inject({
      url: '/projects',
      headers: { authorization: 'Bearer garbage.jwt.token' },
    })).statusCode).toBe(401);
  });

  it('still accepts the shared token when Supabase auth is configured', async () => {
    const app = serve({ sharedToken: 's3cret', supabaseUrl: testSupabaseUrl, jwks });
    const response = await app.inject({
      url: '/projects',
      headers: { authorization: 'Bearer s3cret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('falls through from failed JWT verification to the shared-token check', async () => {
    const app = serve({ sharedToken: 'shared.token.value', supabaseUrl: testSupabaseUrl, jwks });
    expect((await app.inject({
      url: '/projects',
      headers: { authorization: 'Bearer shared.token.value' },
    })).statusCode).toBe(200);
  });

  it('leaves the server open when neither auth method is configured', async () => {
    const app = serve();
    expect((await app.inject({ url: '/projects' })).statusCode).toBe(200);
  });

  it('always leaves /health open', async () => {
    const app = serve({ sharedToken: 's3cret', supabaseUrl: testSupabaseUrl, jwks });
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });
});
