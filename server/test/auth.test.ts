import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../src/auth.js';

async function serve(token?: string) {
  if (token === undefined) delete process.env.EDITIFY_TOKEN;
  else process.env.EDITIFY_TOKEN = token;
  const app = Fastify();
  registerAuth(app, {
    sharedToken: token,
    isPublic: (request) => request.method === 'POST' && request.routeOptions.url === '/telemetry',
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/projects', async () => ([]));
  app.post('/telemetry', async () => ({ ok: true }));
  return app;
}

afterEach(() => { delete process.env.EDITIFY_TOKEN; });

describe('shared-token auth', () => {
  it('leaves the server open when no token is configured', async () => {
    const app = await serve(undefined);
    expect((await app.inject({ url: '/projects' })).statusCode).toBe(200);
  });

  it('rejects unauthenticated requests without inviting a browser password prompt', async () => {
    const app = await serve('s3cret');
    const response = await app.inject({ url: '/projects' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  it('accepts the token as bearer, basic, or query key', async () => {
    const app = await serve('s3cret');
    const basic = Buffer.from('editify:s3cret').toString('base64');
    expect((await app.inject({ url: '/projects', headers: { authorization: 'Bearer s3cret' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/projects', headers: { authorization: `Basic ${basic}` } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/projects?k=s3cret' })).statusCode).toBe(200);
  });

  it('lets a crash report through unauthenticated — the sign-in screen has no token to send', async () => {
    const app = await serve('s3cret');
    const report = await app.inject({ method: 'POST', url: '/telemetry', payload: { kind: 'error' } });
    expect(report.statusCode).toBe(200);
    // Everything else stays shut.
    expect((await app.inject({ url: '/projects' })).statusCode).toBe(401);
  });

  it('rejects a wrong token in every form', async () => {
    const app = await serve('s3cret');
    const basic = Buffer.from('editify:nope').toString('base64');
    expect((await app.inject({ url: '/projects', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/projects', headers: { authorization: `Basic ${basic}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/projects?k=nope' })).statusCode).toBe(401);
  });

  it('leaves /health open so the host can check it', async () => {
    const app = await serve('s3cret');
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });
});
