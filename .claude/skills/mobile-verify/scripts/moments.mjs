#!/usr/bin/env node
// Key-moment log for a recording, kept alongside `agent-device record`.
//
//   node moments.mjs start <moments.json> [--title "..."]   right after `agent-device record start`
//   node moments.mjs mark  <moments.json> "label" [--kind step|check|issue] [--note "..."]
//   node moments.mjs show  <moments.json>
//
// Each mark stores seconds since `start`, so it lines up with the video's own
// clock. Recording start latency (~0.3-1s) is corrected at build time with
// build-review.mjs --offset.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [command, file, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};
const read = () => JSON.parse(readFileSync(file, 'utf8'));
const KINDS = new Set(['step', 'check', 'issue']);

if (!command || !file) {
  console.error('usage: moments.mjs start|mark|show <moments.json> ...');
  process.exit(2);
}
if (command === 'start') {
  writeFileSync(file, JSON.stringify({ title: flag('title') ?? null, startedAt: Date.now(), moments: [] }, null, 2));
  console.log(`moments started: ${file}`);
} else if (command === 'mark') {
  if (!existsSync(file)) { console.error(`run "start" first: ${file} missing`); process.exit(1); }
  const label = rest.find((arg, index) => !arg.startsWith('--') && !rest[index - 1]?.startsWith('--'));
  if (!label) { console.error('mark needs a label'); process.exit(2); }
  const kind = flag('kind') ?? 'step';
  if (!KINDS.has(kind)) { console.error(`--kind must be one of ${[...KINDS].join(', ')}`); process.exit(2); }
  const data = read();
  const t = Math.round((Date.now() - data.startedAt) / 100) / 10;
  data.moments.push({ t, label, kind, ...(flag('note') ? { note: flag('note') } : {}) });
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`${t.toFixed(1)}s  ${kind}  ${label}`);
} else if (command === 'show') {
  for (const m of read().moments) console.log(`${m.t.toFixed(1)}s  ${m.kind}  ${m.label}${m.note ? `  (${m.note})` : ''}`);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
