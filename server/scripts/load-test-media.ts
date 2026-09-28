/**
 * Worst-case memory check for the single 4 GB production machine: one render,
 * one 4K import and one transcription started at the same moment, all through
 * the shared media slot pool. Samples the RSS of this process plus every child
 * (ffmpeg, python) and fails if the peak crosses the budget.
 *
 *   npx tsx server/scripts/load-test-media.ts
 *
 * Not part of CI: it needs ffmpeg, takes a minute or two, and uses local
 * faster-whisper when it is installed (the transcription leg is skipped if not).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUDGET_BYTES = 3.2 * 1024 ** 3;
const SAMPLE_MS = 200;
const CLIP_SECONDS = 15;

const workDir = mkdtempSync(join(tmpdir(), 'editify-load-'));
const importDir = join(workDir, 'import');
process.env.EDITIFY_DATA_DIR = join(workDir, 'data');
process.env.MEDIA_IMPORT_DIR = importDir;

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function makeClip(name: string, width: number, height: number, seconds: number): void {
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    join(importDir, name),
  ]);
}

/** Real speech when macOS `say` exists, so whisper has words to find; a tone otherwise. */
function makeSpeechClip(name: string): void {
  const speech = join(workDir, 'speech.aiff');
  const said = spawnSync('say', ['-o', speech, 'Editify load test. '.repeat(12)], { stdio: 'ignore' });
  const audio = said.status === 0 ? ['-i', speech] : ['-f', 'lavfi', '-i', `sine=frequency=300:duration=${CLIP_SECONDS}`];
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=gray:size=1280x720:rate=30:duration=${CLIP_SECONDS}`, ...audio,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    join(importDir, name),
  ]);
}

function whisperAvailable(): boolean {
  const python = process.env.PYTHON_BIN ?? 'python3';
  return spawnSync(python, ['-c', 'import faster_whisper'], { stdio: 'ignore' }).status === 0;
}

/** RSS of `root` and all its descendants, from one `ps` snapshot. */
function treeRssBytes(root: number): number {
  const output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  const rows = output.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number) as [number, number, number]);
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const [pid, ppid, kb] of rows) {
    rss.set(pid, kb * 1024);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop() as number;
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

async function main(): Promise<void> {
  mkdirSync(importDir, { recursive: true });
  const whisper = whisperAvailable();
  console.log(`Work dir: ${workDir}`);
  console.log(`faster-whisper: ${whisper ? 'available' : 'missing, transcription leg skipped'}`);
  console.log('Generating synthetic clips...');
  makeClip('render-source-4k.mp4', 3840, 2160, CLIP_SECONDS);
  makeClip('import-4k.mp4', 3840, 2160, CLIP_SECONDS);
  if (whisper) makeSpeechClip('speech.mp4');

  // Imported after the env is set, so config.ts picks up the temp directories.
  const { buildApp } = await import('../src/app.js');
  const { createDatabase } = await import('../src/db/database.js');
  const { pendingAssetWork } = await import('../src/routes/assets.js');
  const { mediaSlots } = await import('../src/services/media-slots.js');
  const app = await buildApp({ database: createDatabase(':memory:') });

  const post = async (url: string, payload: object) => {
    const response = await app.inject({ method: 'POST', url, payload });
    if (response.statusCode >= 400) throw new Error(`${url} -> ${response.statusCode}: ${response.body}`);
    return response.json();
  };
  const settleImports = () => Promise.all([...pendingAssetWork.values()]);

  // Setup, unmeasured: the render source and the speech clip must already be
  // in the library (their own import encode and transcript are not the test).
  console.log('Setup: importing the render source and speech clip...');
  const project = await post('/projects', { title: 'Load test', format: '16:9', fps: 30 });
  const source = await post('/assets/import', { name: 'render-source-4k.mp4', projectId: project.id });
  const speech = whisper ? await post('/assets/import', { name: 'speech.mp4', projectId: project.id }) : undefined;
  await settleImports();
  const half = CLIP_SECONDS / 2;
  await post(`/projects/${project.id}/ops`, {
    baseVersion: project.version,
    ops: [
      { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'c1', assetId: source.id, start: 0, in: 0, out: half } } },
      { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'c2', assetId: source.id, start: half, in: half, out: CLIP_SECONDS } } },
    ],
  });

  let peak = 0;
  let peakSlots = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, treeRssBytes(process.pid));
    peakSlots = Math.max(peakSlots, mediaSlots.active().length);
  }, SAMPLE_MS);
  const baseline = treeRssBytes(process.pid);

  console.log('Load: render (4k request), 4K import and transcription at once...');
  const started = Date.now();
  const timings: Record<string, number> = {};
  const timed = async (label: string, work: Promise<unknown>) => {
    await work;
    timings[label] = (Date.now() - started) / 1000;
  };
  const render = await post(`/projects/${project.id}/render`, { resolution: '4k' });
  const renderDone = (async () => {
    for (;;) {
      const polled = (await app.inject({ url: `/renders/${render.id}` })).json();
      if (polled.status === 'done') return;
      if (polled.status === 'error') throw new Error(`Render failed: ${polled.error}`);
      await new Promise((done) => setTimeout(done, 250));
    }
  })();
  const importDone = post('/assets/import', { name: 'import-4k.mp4', projectId: project.id }).then(settleImports);
  const transcribeDone = speech ? post(`/assets/${speech.id}/transcribe`, { force: true }) : Promise.resolve();
  try {
    await Promise.all([
      timed('render', renderDone),
      timed('import', importDone),
      ...(speech ? [timed('transcribe', transcribeDone)] : []),
    ]);
  } finally {
    clearInterval(sampler);
    await app.close();
  }
  peak = Math.max(peak, treeRssBytes(process.pid));

  console.log(`Render exported at: ${render.resolution}`);
  for (const [label, seconds] of Object.entries(timings)) console.log(`  ${label} finished at ${seconds.toFixed(1)}s`);
  console.log(`Peak concurrent media slots: ${peakSlots} of ${mediaSlots.capacity}`);
  console.log(`Baseline RSS: ${gb(baseline)}`);
  console.log(`Peak RSS (node + children): ${gb(peak)} against a ${gb(BUDGET_BYTES)} budget`);
  const pass = peak <= BUDGET_BYTES;
  console.log(pass ? 'PASS' : 'FAIL');
  rmSync(workDir, { recursive: true, force: true });
  process.exitCode = pass ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  rmSync(workDir, { recursive: true, force: true });
  process.exitCode = 1;
});
