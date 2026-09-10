// Fails the build when an em dash (or a non-numeric en dash) shows up in user-facing
// copy. Only string/template/JSX-text nodes are inspected, so code comments are exempt.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// git pathspec globs: a single `*` already spans directory separators here.
const PATTERNS = ['apps/*/src', 'apps/*/app', 'server/src', 'server/test', 'packages/*/src']
  .flatMap((dir) => [`${dir}/*.ts`, `${dir}/*.tsx`]);
const MARKDOWN = ['README.md'];

const EM = '—';
const EN = '–';

// A number can also arrive as a `${...}` substitution, so a template boundary counts.
const numericLeft = (t, i) => /\d/.test(t[i - 1] ?? '') || (i === 1 && t[0] === '}');
const numericRight = (t, i) => /\d/.test(t[i + 1] ?? '') || t.slice(i + 1, i + 3) === '${';

/** Offending indices in `text`: every em dash, plus en dashes outside numeric ranges. */
function hits(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === EM) found.push(i);
    else if (text[i] === EN && !(numericLeft(text, i) && numericRight(text, i))) found.push(i);
  }
  return found;
}

function excerpt(text, index) {
  return text.slice(Math.max(0, index - 40), index + 40).replace(/\s+/g, ' ').trim();
}

const files = execFileSync('git', ['ls-files', '-z', ...PATTERNS, ...MARKDOWN], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const problems = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  if (file.endsWith('.md')) {
    for (const index of hits(source)) {
      const line = source.slice(0, index).split('\n').length;
      problems.push(`${file}:${line}: ${excerpt(source, index)}`);
    }
    continue;
  }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const copyKinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
  ]);
  const walk = (node) => {
    if (copyKinds.has(node.kind)) {
      const raw = node.getText(sf);
      const start = node.getStart(sf);
      for (const index of hits(raw)) {
        const { line } = sf.getLineAndCharacterOfPosition(start + index);
        problems.push(`${file}:${line + 1}: ${excerpt(raw, index)}`);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error(`\n${problems.length} em/en dash(es) in user-facing copy. Rewrite with a colon, comma, parentheses, semicolon, or two sentences.`);
  process.exit(1);
}
console.log(`lint:copy OK - no em dashes in user-facing copy (${files.length} files scanned).`);
