// Fails when fly.v11.toml drifts from fly.toml (plan C9). The two server lines'
// Fly configs may differ only in:
//   app                    (top level)
//   PUBLIC_BASE_URL, LINE  ([env])
//   source                 ([[mounts]])
//   DATABASE_SCHEMA        ([env], and only in fly.v11.toml)
// Comments and blank lines don't count. Passes when fly.v11.toml is absent (main
// before the cutover, and after C14 folds it back into fly.toml).
//
// Usage: node scripts/check-fly-drift.mjs [fly.toml] [fly.v11.toml]
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VARIES = '<varies by line>';
// section -> keys whose value may differ between the lines ('' is the top level).
const ALLOWED = { '': ['app'], env: ['PUBLIC_BASE_URL', 'LINE'], mounts: ['source'] };
// section -> keys only the 1.1 line has.
const LINE_ONLY = { env: ['DATABASE_SCHEMA'] };

/**
 * The config as comparable entries: `[section] key = value`, with allowed values
 * masked and (for the 1.1 file) its own keys dropped. Each keeps its line number.
 */
export function entries(text, { isLineFile = false } = {}) {
  const out = [];
  let section = '';
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      section = header[1];
      out.push({ line: i + 1, text: line });
      return;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      if (isLineFile && LINE_ONLY[section]?.includes(key)) return;
      const shown = ALLOWED[section]?.includes(key) ? VARIES : value;
      out.push({ line: i + 1, text: `[${section}] ${key} = ${shown}` });
      return;
    }
    out.push({ line: i + 1, text: `[${section}] ${line}` });
  });
  return out;
}

/** Entries only one side has, as a line diff (LCS), in file order. */
export function drift(baseText, lineText) {
  const a = entries(baseText);
  const b = entries(lineText, { isLineFile: true });
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i].text === b[j].text ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) { i++; j++; }
    else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ side: 'base', ...a[i++] });
    else out.push({ side: 'line', ...b[j++] });
  }
  return out;
}

function main([basePath = 'fly.toml', linePath = 'fly.v11.toml']) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const base = path.resolve(root, basePath);
  const line = path.resolve(root, linePath);
  if (!existsSync(line)) {
    console.log(`${linePath} is absent; nothing to compare.`);
    return 0;
  }
  const found = drift(readFileSync(base, 'utf8'), readFileSync(line, 'utf8'));
  if (found.length === 0) {
    console.log(`${linePath} matches ${basePath} outside the allowed keys.`);
    return 0;
  }
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  console.error(`${linePath} drifts from ${basePath}. Only app, PUBLIC_BASE_URL, LINE, the mount source and DATABASE_SCHEMA (1.1 only) may differ:`);
  for (const d of found) {
    const file = d.side === 'base' ? basePath : linePath;
    const msg = `only in ${file}: ${d.text}`;
    console.error(`  ${file}:${d.line}  ${msg}`);
    if (annotate) console.log(`::error file=${file},line=${d.line}::${msg}`);
  }
  console.error('Make the same change in both files, or extend the allowlist in scripts/check-fly-drift.mjs.');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
