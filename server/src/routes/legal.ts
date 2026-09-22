import type { FastifyInstance } from 'fastify';
import { LEGAL_PAGES, renderLegalPage } from '../services/legal-pages.js';

/**
 * The privacy policy, the terms of use and the support page. App Store Connect
 * demands all three as URLs, and Apple fetches them with no credentials of any
 * kind, so they are exempt from auth in `app.ts` via `isLegalRoute`.
 */
export function registerLegalRoutes(app: FastifyInstance): void {
  for (const page of LEGAL_PAGES) {
    app.get(page.path, async (_request, reply) =>
      await reply.type('text/html; charset=utf-8').send(await renderLegalPage(page)));
  }
}

/** True for the three public pages, and nothing else. */
export function isLegalRoute(url: string | undefined): boolean {
  return LEGAL_PAGES.some((page) => page.path === url);
}
