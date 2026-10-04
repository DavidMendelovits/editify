// Usage: npx tsx apps/mobile/scripts/lab-evaluate.ts results.jsonl [more.jsonl ...]
// Prints the per-device go/no-go tables for research/mobile-capabilities.md.
import { readFileSync } from 'node:fs';
import { evaluate, parseRows, toMarkdown } from '../src/lab/evaluate';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: lab-evaluate <results.jsonl>...');
  process.exit(1);
}
console.log(toMarkdown(evaluate(files.flatMap((file) => parseRows(readFileSync(file, 'utf8'))))));
