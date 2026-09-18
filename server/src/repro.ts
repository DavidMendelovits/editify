/**
 * Rebuilds the project a report was sent from, so a fix can start from the
 * timeline that produced it instead of a guess at one.
 *
 *   npm run repro -- --report <report id>
 *   npm run repro -- --issue <issue number>
 *   npm run repro -- --file path/to/repro.json
 *
 * Media is never part of a bundle (probe data only), so clips are remapped onto
 * whatever footage this machine already has, matched on duration and aspect.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { projectSchema, type Project } from '@editify/shared';
import { AssetStore, type StoredAsset } from './db/asset-store.js';
import { createDatabase } from './db/database.js';
import { ProjectStore } from './db/project-store.js';
import { ReportStore } from './db/report-store.js';
import { chooseSubstitute, type ReproBundle } from './services/repro-service.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const database = createDatabase();
const reports = new ReportStore(database);
const projects = new ProjectStore(database);
const assets = new AssetStore(database);

function loadBundle(): ReproBundle {
  const file = argument('file');
  if (file) return JSON.parse(readFileSync(file, 'utf8')) as ReproBundle;

  const issue = argument('issue');
  const reportId = argument('report') ?? (issue ? reports.findByIssue(Number(issue)) : undefined);
  if (!reportId) {
    fail(issue
      ? `No report on this server was filed as issue #${issue}. Pass --file with the repro.json from the issue body instead.`
      : 'Pass one of --report <id>, --issue <number>, or --file <path>.');
  }
  const stored = reports.getRepro(reportId) as ReproBundle | undefined;
  if (!stored) fail(`Report ${reportId} carries no repro bundle. It was probably filed from outside a project.`);
  return stored;
}

const bundle = loadBundle();
const pool = assets.list();
if (!pool.length) fail('This server has no assets. Run `npm run seed` first so there is footage to map the timeline onto.');

const mapping = new Map<string, StoredAsset>();
for (const wanted of bundle.assets) {
  const chosen = chooseSubstitute(wanted, pool);
  if (chosen) mapping.set(wanted.id, chosen);
}

const id = randomUUID();
const rebuilt: Project = projectSchema.parse({
  ...bundle.project,
  id,
  title: `REPRO ${bundle.project.title}`.slice(0, 120),
  tracks: bundle.project.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (!clip.assetId) return clip;
      const chosen = mapping.get(clip.assetId);
      if (!chosen) return clip;
      // A stand-in shorter than the original would make an invalid clip, so the
      // in/out window is clamped into what the substitute actually has.
      const out = Math.min(clip.out, chosen.duration);
      const start = Math.min(clip.in, Math.max(0, out - 0.1));
      return { ...clip, assetId: chosen.id, in: start, out };
    }),
  })),
});

projects.insert(rebuilt);
for (const asset of new Set(mapping.values())) assets.link(id, asset.id);

const swapped = [...mapping.entries()].filter(([from, to]) => from !== to.id);
console.log(`Seeded ${rebuilt.title}`);
console.log(`  project    ${id}`);
const clipCount = rebuilt.tracks.flatMap((track) => track.clips).length;
console.log(`  timeline   ${rebuilt.format} at ${rebuilt.fps}fps, ${clipCount} ${clipCount === 1 ? 'clip' : 'clips'} over ${rebuilt.duration.toFixed(1)}s`);
console.log(`  captured   ${bundle.capturedAt}${bundle.server.commit ? ` at ${bundle.server.commit}` : ''}`);
if (swapped.length) {
  console.log(`  media      ${swapped.length} of ${bundle.assets.length} assets substituted:`);
  for (const [from, to] of swapped) {
    const wanted = bundle.assets.find((asset) => asset.id === from);
    console.log(`             ${wanted?.originalName ?? from} (${wanted?.duration.toFixed(1)}s) → ${to.originalName} (${to.duration.toFixed(1)}s)`);
  }
}
if (bundle.recentOps.length) {
  console.log(`  last edits ${bundle.recentOps.slice(-8).map((entry) => entry.operation.type).join(', ')}`);
}
console.log(`\nOpen /project/${id} to see what the reporter saw.`);
