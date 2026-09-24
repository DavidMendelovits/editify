import type { FastifyInstance } from 'fastify';
import {
  LEGAL_PAGES,
  UNPUBLISHED_PAGE_HTML,
  renderLegalPage,
  type LegalPageOptions,
} from '../services/legal-pages.js';

/**
 * The privacy policy, the terms of use and the support page. App Store Connect
 * demands all three as URLs, and Apple fetches them with no credentials of any
 * kind, so they are exempt from auth in `app.ts` via `isLegalRoute`.
 *
 * A document that still carries a fill token or an internal `VERIFY:` note is
 * withheld with a 503 rather than served. 503 over the alternatives: a 404
 * would tell Apple the URL does not exist, which is a different and worse
 * claim; refusing to boot would take the whole API down over a documentation
 * problem; and serving the page is the one outcome that actually causes harm,
 * because half-finished legal text published to users is not retractable. A
 * 503 is honest, temporary by definition, retried by every checker, and
 * confined to these three routes.
 */
export function registerLegalRoutes(app: FastifyInstance, options: LegalPageOptions = {}): void {
  for (const page of LEGAL_PAGES) {
    app.get(page.path, async (request, reply) => {
      const rendered = await renderLegalPage(page, options);
      if (!rendered.published) {
        request.log.warn(
          { page: page.path, markers: rendered.markers },
          'legal page withheld: the document still carries unresolved internal text',
        );
        return await reply
          .code(503)
          // Nothing may cache a page that is about to change.
          .header('cache-control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(UNPUBLISHED_PAGE_HTML);
      }
      return await reply.type('text/html; charset=utf-8').send(rendered.html);
    });
  }
}

/** True for the three public pages, and nothing else. */
export function isLegalRoute(url: string | undefined): boolean {
  return LEGAL_PAGES.some((page) => page.path === url);
}
