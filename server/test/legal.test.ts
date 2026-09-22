import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAuth } from '../src/auth.js';
import { isLegalRoute, registerLegalRoutes } from '../src/routes/legal.js';
import { DOCS_ROOT, LEGAL_PAGES } from '../src/services/legal-pages.js';

// Auth is registered exactly as `buildApp` registers it: the point of these
// tests is that the pages survive it, so a server without auth would prove
// nothing.
function serve(docsRoot = resolvedDocs) {
  const app = Fastify();
  registerAuth(app, {
    sharedToken: 's3cret',
    isPublic: (request) =>
      (request.method === 'GET' || request.method === 'HEAD') && isLegalRoute(request.routeOptions.url),
  });
  registerLegalRoutes(app, { docsRoot });
  app.get('/projects', async () => []);
  return app;
}

/**
 * A copy of `docs/` with the fill tokens replaced, which is what the documents
 * will look like the day they are published. The tests below that assert the
 * real wording run against this, because the shipped documents still carry
 * tokens and are therefore withheld on purpose; see the refusal tests.
 */
let resolvedDocs = '';

beforeAll(async () => {
  resolvedDocs = await mkdtemp(join(tmpdir(), 'editify-legal-resolved-'));
  for (const page of LEGAL_PAGES) {
    const markdown = await readFile(join(DOCS_ROOT, page.source), 'utf8');
    await writeFile(
      join(resolvedDocs, page.source),
      // Whatever the token is called, the sample reads like the fact it stands
      // in for, so a new token needs no change here.
      markdown.replace(/\{\{FILL_([A-Z0-9_]*)\}\}/g, (_match, name: string) =>
        `sample ${name.toLowerCase().replace(/_/g, ' ')}`),
      'utf8',
    );
  }
});

/** A directory where every one of the three documents is the given markdown. */
async function docsContaining(markdown: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'editify-legal-fixture-'));
  for (const page of LEGAL_PAGES) await writeFile(join(directory, page.source), markdown, 'utf8');
  return directory;
}

const CLEAN = '# Sample Policy\n\n**Last updated:** 1 January 2026\n\nWe collect nothing at all.\n';

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

describe('unfinished documents are withheld', () => {
  it.each(PAGES.map(([path]) => path))('%s is refused while a fill token is still in it', async (path) => {
    const docs = await docsContaining('# Contact\n\nWrite to {{FILL_CONTACT_EMAIL}} and we will answer.\n');

    const response = await serve(docs).inject({ url: path });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('FILL_');
    expect(response.body).toContain('Not published yet');
    // A refusal that gets cached outlives the fix.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(PAGES.map(([path]) => path))('%s is refused while a VERIFY note is still in it', async (path) => {
    const docs = await docsContaining(
      '# Governing law\n\nThe laws of Spain apply.\n\nVERIFY: confirm Spain is the right forum.\n');

    const response = await serve(docs).inject({ url: path });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('VERIFY');
    expect(response.body).toContain('Not published yet');
  });

  it.each(PAGES.map(([path]) => path))('%s is served once the document is clean', async (path) => {
    const response = await serve(await docsContaining(CLEAN)).inject({ url: path });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('We collect nothing at all.');
  });

  it('withholds a token inside a table cell, which is where one hides best', async () => {
    const docs = await docsContaining(
      '# Processors\n\n| Processor | Why |\n|---|---|\n| PostHog ({{FILL_POSTHOG_ENTITY}}) | Analytics |\n');

    expect((await serve(docs).inject({ url: '/privacy' })).statusCode).toBe(503);
  });

  it('refuses only the document that is unfinished, and no other route', async () => {
    const docs = await docsContaining(CLEAN);
    await writeFile(join(docs, 'privacy-policy.md'), `${CLEAN}\nVERIFY: ask a lawyer.\n`, 'utf8');
    const app = serve(docs);

    expect((await app.inject({ url: '/privacy' })).statusCode).toBe(503);
    expect((await app.inject({ url: '/terms' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/support' })).statusCode).toBe(200);
    // The guard lives in the legal handler, so auth elsewhere is untouched.
    expect((await app.inject({ url: '/projects' })).statusCode).toBe(401);
    expect((await app.inject({
      url: '/projects',
      headers: { authorization: 'Bearer s3cret' },
    })).statusCode).toBe(200);
  });
});
