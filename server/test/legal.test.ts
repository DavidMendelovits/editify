import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAuth } from '../src/auth.js';
import { isLegalRoute, registerLegalRoutes } from '../src/routes/legal.js';

// Auth is registered exactly as `buildApp` registers it: the point of these
// tests is that the pages survive it, so a server without auth would prove
// nothing.
function serve() {
  const app = Fastify();
  registerAuth(app, {
    sharedToken: 's3cret',
    isPublic: (request) =>
      (request.method === 'GET' || request.method === 'HEAD') && isLegalRoute(request.routeOptions.url),
  });
  registerLegalRoutes(app);
  app.get('/projects', async () => []);
  return app;
}

// One phrase per page, taken from the source document, so a page wired to the
// wrong file (or to no file) fails rather than passing on a shared layout.
const PAGES = [
  ['/privacy', 'the media store and the renderer run on a server operated by Maja Ventures'],
  ['/terms', 'Editify is a video editor with an AI assistant'],
  ['/support', 'Editify is published by Maja Ventures SL'],
] as const;

describe('public legal pages', () => {
  it.each(PAGES)('%s is served as HTML to a request with no credentials', async (path, phrase) => {
    const response = await serve().inject({ url: path });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain(phrase);
  });

  it.each(PAGES)('%s carries the date and the links the other pages are reached by', async (path) => {
    const body = (await serve().inject({ url: path })).body;

    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain('Last updated:');
    // Every page links to the other two, so a reviewer lands on all three from any one.
    const links = ['/privacy', '/terms', '/support'].filter((other) => other !== path);
    for (const link of links) expect(body).toContain(`href="${link}"`);
  });

  it('renders the markdown rather than dumping it', async () => {
    const body = (await serve().inject({ url: '/privacy' })).body;

    expect(body).toContain('<h2>1. Who is responsible for your data</h2>');
    // Section 5 is a table; it has to survive as one.
    expect(body).toContain('<th>Processor</th>');
    expect(body).not.toContain('**Last updated:**');
  });

  it('exempts the three pages and nothing else', async () => {
    const app = serve();

    expect((await app.inject({ url: '/projects' })).statusCode).toBe(401);
    expect(isLegalRoute('/privacy-policy')).toBe(false);
    expect(isLegalRoute(undefined)).toBe(false);
  });
});
