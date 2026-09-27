/**
 * Render memory benchmark: peak RSS of the ffmpeg process tree while
 * renderProject exports a worst-case-shaped project.
 *
 * The shape is the one that took production down: a 4K 9:16 phone source cut
 * into many short pieces, taken out of order, rendered at 1080p on a 4 GB box.
 * Here that is one synthetic 60 s 2160x3840 30 fps source (testsrc2 plus a
 * sine track) cut into 30 clips in shuffled source order, two of them speed
 * changed and one crossfading into its neighbour. The target is a peak under
 * 2 GB.
 *
 *   npx tsx scripts/bench-render.ts            # current render.ts
 *   npx tsx scripts/bench-render.ts legacy     # the frozen pre-fix graph
 *   npx tsx scripts/bench-render.ts all        # both, one after the other
 *
 * Sources and renders live under server/data/bench (gitignored). The source is
 * generated once and reused; delete the directory to rebuild it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clip, Project } from '@editify/shared';
import type { AssetStore } from '../src/db/asset-store.js';

const serverRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const benchRoot = join(serverRoot, 'data', 'bench');
// config.ts reads this at import time, so it is set before render.ts loads.
process.env.EDITIFY_DATA_DIR = benchRoot;

const SOURCE_SECONDS = 60;
const CUTS = 30;
const FPS = 30;
const SAMPLE_MS = 250;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', fail);
    child.once('close', (code) => (code === 0 ? done() : fail(new Error(`${command} exited ${code}: ${stderr}`))));
  });
}

async function makeSource(path: string): Promise<void> {
  if (existsSync(path)) return;
  console.log(`generating ${SOURCE_SECONDS}s 2160x3840 source (one-off)...`);
  await run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc2=s=2160x3840:r=${FPS}:d=${SOURCE_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:d=${SOURCE_SECONDS}`,
    // A 2 s GOP is in the range phones write, so seeks cost what they would in production.
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', path,
  ]);
}

/** Deterministic shuffle, so every run cuts the same project. */
function shuffled(count: number): number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  let seed = 7;
  for (let index = count - 1; index > 0; index -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const pick = seed % (index + 1);
    [order[index], order[pick]] = [order[pick] as number, order[index] as number];
  }
  return order;
}

function buildProject(): Project {
  const slot = SOURCE_SECONDS / CUTS;
  const clips: Clip[] = [];
  let start = 0;
  shuffled(CUTS).forEach((sourceSlot, index) => {
    const clip: Clip = { id: `c${String(index).padStart(2, '0')}`, assetId: 'src', start, in: sourceSlot * slot, out: (sourceSlot + 1) * slot };
    if (index === 5) clip.speed = 1.5;
    if (index === 12) clip.speed = 0.75;
    if (index === 8) clip.transition = { type: 'crossfade', duration: 0.3 };
    clips.push(clip);
    start = Number((start + (clip.out - clip.in) / (clip.speed ?? 1)).toFixed(3));
  });
  return {
    id: 'bench', title: 'bench', format: '9:16', fps: FPS, duration: start, version: 1,
    tracks: [{ id: 'video', kind: 'video', clips }],
  };
}

/** Sum of RSS (bytes) over every ffmpeg in this process's subtree, via one `ps`. */
async function ffmpegTreeRss(): Promise<number> {
  const listing = await new Promise<string>((done) => {
    const child = spawn('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm=']);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.once('close', () => done(out));
    child.once('error', () => done(''));
  });
  const rows = listing.split('\n').map((line) => line.trim().split(/\s+/)).filter((row) => row.length >= 4);
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of rows) {
    const list = children.get(Number(ppid)) ?? [];
    list.push(Number(pid));
    children.set(Number(ppid), list);
  }
  const inTree = new Set<number>();
  const stack = [process.pid];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    for (const child of children.get(pid) ?? []) {
      inTree.add(child);
      stack.push(child);
    }
  }
  let total = 0;
  for (const [pid, , rss, ...command] of rows) {
    if (inTree.has(Number(pid)) && command.join(' ').includes('ffmpeg')) total += Number(rss) * 1024;
  }
  return total;
}

async function measure(label: string, render: () => Promise<string>): Promise<void> {
  let peak = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, await ffmpegTreeRss());
      await new Promise((done) => setTimeout(done, SAMPLE_MS));
    }
  })();
  const started = performance.now();
  try {
    const output = await render();
    const seconds = (performance.now() - started) / 1000;
    sampling = false;
    await sampler;
    console.log(`${label.padEnd(8)} peak ffmpeg RSS ${(peak / 2 ** 30).toFixed(2)} GB, wall ${seconds.toFixed(1)} s -> ${output}`);
  } finally {
    sampling = false;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'current';
  await mkdir(benchRoot, { recursive: true });
  const sourcePath = join(benchRoot, 'source-2160x3840.mp4');
  await makeSource(sourcePath);
  const project = buildProject();
  const asset = {
    id: 'src', originalName: 'source.mp4', mimeType: 'video/mp4', duration: SOURCE_SECONDS,
    width: 2160, height: 3840, fps: FPS, hasAudio: true, originalPath: sourcePath,
    proxyPath: sourcePath, thumbnailPath: sourcePath, createdAt: new Date(0).toISOString(), status: 'ready',
  };
  // Only get() is used by the renderer; a real store would need a database.
  const assets = { get: (id: string) => (id === asset.id ? asset : undefined) } as unknown as AssetStore;
  console.log(`project: ${CUTS} cuts, ${project.duration.toFixed(2)} s timeline, 1080p out, ffmpeg threads auto on this host`);
  if (mode === 'legacy' || mode === 'all') {
    const { renderProjectLegacy } = await import('../test/fixtures/legacy-render.js');
    await measure('legacy', () => renderProjectLegacy(project, '1080p', 'bench-legacy', assets));
  }
  if (mode === 'current' || mode === 'all') {
    const { renderProject } = await import('../src/media/render.js');
    await measure('current', () => renderProject(project, '1080p', 'bench-current', assets));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
