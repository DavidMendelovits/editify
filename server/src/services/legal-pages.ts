import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serverRoot } from '../config.js';

/**
 * Apple needs a privacy policy, a terms of use (EULA) and a support page at
 * public URLs. The wording lives in `docs/` — the same files the submission
 * pack cites — and this module is the only thing that turns them into HTML, so
 * there is never a second copy of the text to keep in step.
 *
 * A markdown dependency would be the obvious move, but the server has none and
 * these three documents use six constructs between them (headings, paragraphs,
 * bullets, tables, bold and inline code, plus the links in the support page).
 * `renderMarkdown` below covers exactly those. It is not a general markdown
 * implementation and should not grow into one: if a document needs more, add
 * the construct here deliberately or reach for a library then.
 */
export interface LegalPage {
  /** Route path, which is also how the pages link to each other. */
  readonly path: string;
  /** Source document, relative to `docs/`. */
  readonly source: string;
  /** Label used in the footer of the other two pages. */
  readonly label: string;
}

export const LEGAL_PAGES: readonly LegalPage[] = [
  { path: '/privacy', source: 'privacy-policy.md', label: 'Privacy Policy' },
  { path: '/terms', source: 'terms-of-service.md', label: 'Terms of Use' },
  { path: '/support', source: 'support.md', label: 'Support' },
];

// `serverRoot` is `server/` from both `src/` and the compiled `dist/`, so this
// is the repo's `docs/` in development and `/app/docs` in the container, which
// the Dockerfile copies in for exactly this reason.
const docsRoot = resolve(serverRoot, '..', 'docs');

export async function renderLegalPage(page: LegalPage): Promise<string> {
  return layout(parseDocument(await readFile(join(docsRoot, page.source), 'utf8')), page);
}

interface ParsedDocument {
  title: string;
  /** Empty when the source carries no `**Last updated:**` line. */
  lastUpdated: string;
  bodyHtml: string;
}

/** Lifts the title and the last-updated date out of the body so the page can style them. */
function parseDocument(markdown: string): ParsedDocument {
  let title = '';
  let lastUpdated = '';
  const body: string[] = [];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^#\s+(.+)$/.exec(line);
    if (heading && !title) { title = (heading[1] ?? '').trim(); continue; }
    const updated = /^\*\*Last updated:\*\*\s*(.+)$/.exec(line);
    if (updated && !lastUpdated) { lastUpdated = (updated[1] ?? '').trim(); continue; }
    body.push(line);
  }
  return { title: title || 'Editify', lastUpdated, bodyHtml: renderMarkdown(body.join('\n')) };
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      index += 1;
      continue;
    }

    if (isRule(line)) { html.push('<hr>'); index += 1; continue; }

    if (isTableRow(line) && isTableRule(lines[index + 1] ?? '')) {
      const header = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        rows.push(cells(lines[index] ?? ''));
        index += 1;
      }
      html.push(table(header, rows));
      continue;
    }

    if (isBullet(line)) {
      const items: string[] = [];
      while (index < lines.length && isBullet(lines[index] ?? '')) {
        items.push(`<li>${inline((lines[index] ?? '').replace(/^\s*[-*]\s+/, ''))}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // A paragraph runs until a blank line or the start of any other block.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (!next.trim() || /^#{1,6}\s/.test(next) || isBullet(next) || isTableRow(next) || isRule(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }

  return html.join('\n');
}

const isBullet = (line: string): boolean => /^\s*[-*]\s+/.test(line);
const isRule = (line: string): boolean => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isTableRule = (line: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(line);

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function table(header: string[], rows: string[][]): string {
  const head = header.map((cell) => `<th>${inline(cell)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
    .join('');
  // The wrapper scrolls instead of the page: a three-column table cannot be
  // squeezed into a phone without becoming one word per line.
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Escaping happens first, so the tags produced here are the only markup in the output. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) =>
      // Only our own pages and plain https, so a stray link in a document
      // cannot turn into `javascript:` markup on a page we serve unauthenticated.
      /^(https:\/\/|\/)/.test(href) ? `<a href="${href}">${label}</a>` : match);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * No external stylesheet, font or script: these pages have to render for a
 * reviewer on a phone with a bad connection, and in both colour schemes.
 */
const STYLES = `
:root { color-scheme: light dark; --bg:#ffffff; --fg:#17171a; --muted:#5b5b66; --line:#e2e2e8; --panel:#f6f6f9; --link:#1f5fd0; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0e0e10; --fg:#ececee; --muted:#9a9aa3; --line:#2e2e33; --panel:#161618; --link:#7fb0ff; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width:44rem; margin:0 auto; padding:2rem 1.15rem 4rem; }
h1 { font-size:1.7rem; line-height:1.25; margin:0 0 .4rem; letter-spacing:-.01em; }
h2 { font-size:1.2rem; margin:2.2rem 0 .6rem; }
h3 { font-size:1.02rem; margin:1.6rem 0 .4rem; }
p, li { overflow-wrap:break-word; }
.updated { color:var(--muted); font-size:.9rem; margin:0 0 2rem; }
a { color:var(--link); }
ul { padding-left:1.2rem; margin:.8rem 0; }
li { margin:.35rem 0; }
code { background:var(--panel); border:1px solid var(--line); border-radius:3px; padding:0 .25em; font-size:.88em; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; }
.table { overflow-x:auto; margin:1.1rem 0; border:1px solid var(--line); border-radius:6px; }
table { border-collapse:collapse; width:100%; min-width:32rem; font-size:.92rem; }
th, td { text-align:left; vertical-align:top; padding:.6rem .7rem; border-bottom:1px solid var(--line); }
th { background:var(--panel); font-weight:600; }
tbody tr:last-child td { border-bottom:0; }
hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
footer { margin-top:3rem; padding-top:1.2rem; border-top:1px solid var(--line); display:flex; flex-wrap:wrap; gap:1.2rem; font-size:.92rem; color:var(--muted); }
`.trim();

function layout(parsed: ParsedDocument, page: LegalPage): string {
  const nav = LEGAL_PAGES
    .filter((other) => other.path !== page.path)
    .map((other) => `<a href="${other.path}">${other.label}</a>`)
    .join('\n');
  const updated = parsed.lastUpdated
    ? `<p class="updated">Last updated: ${escapeHtml(parsed.lastUpdated)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(parsed.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>${escapeHtml(parsed.title)}</h1>
${updated}
${parsed.bodyHtml}
<footer>
${nav}
</footer>
</main>
</body>
</html>
`;
}
