/**
 * Stand-up pipeline, timed end to end on this machine: the real app in-process
 * (no network, no upload: the video is imported by path, the memo copied from
 * local disk), then the same tools the agent calls, with no LLM in the loop.
 *
 *   npx tsx scripts/standup-pipeline.ts ["<folder with one video + one audio>"]
 *
 *   import video (probe) ──▶ add clips at once ──▶ sync memo ──▶ wait: transcript, faces
 *        │ background: proxy encode, transcription, face track (media slots)
 *        ▼
 *   remove silence (laughter kept) ──▶ split per sentence + face framing ──▶ karaoke captions ──▶ place ──▶ render
 *
 * Every stage is timed from t0 and reported as a table plus timings.json under
 * server/data/standup-run (gitignored, wiped each run).
 */
import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const serverRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const dataDir = join(serverRoot, 'data', 'standup-run');

/** The founder's keys live in the main checkout's .env.local; walk up to find it. */
function findUp(name: string, from: string): string | undefined {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

const envFile = findUp('.env.local', serverRoot);
if (envFile) process.loadEnvFile(envFile);
const mediaDir = resolve(process.argv[2] ?? join(dirname(findUp('.env.local', serverRoot) ?? serverRoot), 'stand-up audio sync test'));
const files = readdirSync(mediaDir).filter((name) => !name.startsWith('.'));
const videoName = files.find((name) => ['.mov', '.mp4', '.m4v'].includes(extname(name).toLowerCase()));
const memoName = files.find((name) => ['.m4a', '.wav', '.mp3', '.aac'].includes(extname(name).toLowerCase()));
if (!videoName || !memoName) throw new Error(`${mediaDir} needs one video and one audio file`);

rmSync(dataDir, { recursive: true, force: true });
// config.ts reads these at import time, so they are set before any app module loads.
process.env.EDITIFY_DATA_DIR = dataDir;
process.env.MEDIA_IMPORT_DIR = mediaDir;
delete process.env.EDITIFY_TOKEN;

const { buildApp } = await import('../src/app.js');
const { createDatabase } = await import('../src/db/database.js');
const { ProjectStore } = await import('../src/db/project-store.js');
const { AssetStore } = await import('../src/db/asset-store.js');
const { RenderStore } = await import('../src/db/render-store.js');
const { TranscriptStore } = await import('../src/db/transcript-store.js');
const { InsightStore } = await import('../src/db/insight-store.js');
const { TranscriptService } = await import('../src/services/transcript-service.js');
const { InsightService } = await import('../src/services/insight-service.js');
const { SyncService } = await import('../src/services/sync-service.js');
const { FaceService, faceAt } = await import('../src/services/face-service.js');
const { createProvider } = await import('../src/agent/providers.js');
const { createToolRegistry, buildTimelineTranscript } = await import('../src/agent/tools.js');
type ToolContext = import('../src/agent/tools.js').ToolContext;
type Project = import('@editify/shared').Project;

// ── timing ────────────────────────────────────────────────────────────────
const t0 = performance.now();
const since = (): number => (performance.now() - t0) / 1000;
const timings: Array<{ stage: string; start: number; end: number; note?: string }> = [];
async function stage<T>(name: string, run: () => Promise<T>, note?: (value: T) => string): Promise<T> {
  const start = since();
  process.stdout.write(`[${start.toFixed(1)}s] ${name}…\n`);
  const value = await run();
  const end = since();
  timings.push({ stage: name, start, end, note: note?.(value) });
  process.stdout.write(`[${end.toFixed(1)}s] ${name} done in ${(end - start).toFixed(2)}s${note ? ` (${note(value)})` : ''}\n`);
  return value;
}
function milestone(name: string, note?: string): void {
  const at = since();
  timings.push({ stage: name, start: at, end: at, note });
  process.stdout.write(`[${at.toFixed(1)}s] ● ${name}${note ? ` (${note})` : ''}\n`);
}

// ── app + the agent's own services on the same database ───────────────────
const database = createDatabase();
const app = await buildApp({ database });
await app.ready();
const projects = new ProjectStore(database);
const assets = new AssetStore(database);
const transcripts = new TranscriptService(new TranscriptStore(database));
const faces = new FaceService(database);
const tools = new Map(createToolRegistry().map((tool) => [tool.name, tool]));

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await app.inject({ method, url, payload: payload as never, headers });
  if (response.statusCode >= 400) throw new Error(`${method} ${url} → ${response.statusCode}: ${response.body.slice(0, 300)}`);
  return response.json() as T;
}

const project = await call<{ id: string }>('POST', '/projects', { title: 'Stand-up sync test', format: '9:16', fps: 24 });
const ctx = (): ToolContext => ({
  projectId: project.id, projects, assets, transcripts, faces, styleDoc: null,
  currentVersion: projects.get(project.id)!.version,
  insights: new InsightService(new InsightStore(database), transcripts, async () => createProvider()),
  syncs: new SyncService(assets), renders: new RenderStore(database),
});
async function tool(name: string, input: unknown): Promise<Record<string, unknown>> {
  const result = await tools.get(name)!.execute(ctx(), input) as Record<string, unknown>;
  if (result && result.ok === false) throw new Error(`${name}: ${String(result.error)}`);
  return result;
}
const current = (): Project => projects.get(project.id)!;
async function ops(list: unknown[]): Promise<void> {
  if (list.length) await call('POST', `/projects/${project.id}/ops`, { baseVersion: current().version, ops: list });
}

// ── 1. import: probe only, the slow work goes to the background ───────────
const video = await stage('import video by path (probe)', () =>
  call<{ id: string; duration: number; width: number; height: number }>('POST', '/assets/import', { name: videoName, projectId: project.id }),
(v) => `${v.width}x${v.height}, ${v.duration.toFixed(1)}s, ${(statSync(join(mediaDir, videoName)).size / 1e9).toFixed(2)} GB`);
const memo = await stage('import memo from local disk', () =>
  call<{ id: string; duration: number }>('POST', `/assets/raw?projectId=${project.id}&name=${encodeURIComponent(memoName)}`,
    createReadStream(join(mediaDir, memoName)), { 'content-type': 'audio/mp4' }),
(m) => `${m.duration.toFixed(1)}s`);

// Background milestones, watched while the foreground keeps editing.
const background = (async () => {
  const seen = new Set<string>();
  while (seen.size < 4) {
    const v = assets.get(video.id);
    if (!seen.has('proxy') && v?.status !== 'processing') { seen.add('proxy'); milestone('background: video proxy ready', v?.status); }
    if (!seen.has('vt') && transcripts.get(video.id)) { seen.add('vt'); milestone('background: video transcript ready'); }
    if (!seen.has('mt') && transcripts.get(memo.id)) { seen.add('mt'); milestone('background: memo transcript ready', `${transcripts.get(memo.id)!.words.length} words`); }
    if (!seen.has('faces') && faces.get(video.id)) { seen.add('faces'); milestone('background: face track ready', `${faces.get(video.id)!.samples.length} samples`); }
    await new Promise((done) => setTimeout(done, 250));
  }
})();

// ── 2. timeline at once: nothing here waits on the proxy ──────────────────
await stage('add clips to timeline', () => tool('add_clips', { trackId: 'video-main', clips: [{ id: 'v1', assetId: video.id, start: 0, in: 0, out: video.duration }] })
  .then(() => tool('add_clips', { trackId: 'audio-main', clips: [{ id: 'memo', assetId: memo.id, start: 0, in: 0, out: memo.duration }] })));

// ── 3. sync ───────────────────────────────────────────────────────────────
const synced = await stage('sync memo to video', () => tool('sync_audio', { audioClipId: 'memo', videoClipId: 'v1' }),
  (r) => JSON.stringify(r.sync ?? r.notes ?? Object.keys(r)).slice(0, 160));
// The memo is the clean mic: it replaces the camera's room sound.
await ops(current().tracks.find((t) => t.kind === 'video')!.clips.map((clip) => ({ type: 'set_volume', params: { clipId: clip.id, volume: 0 } })));

// ── 4. everything below needs words and faces ─────────────────────────────
await stage('wait for transcripts + face track', async () => {
  while (!transcripts.get(memo.id) || !transcripts.get(video.id) || !faces.get(video.id)) await new Promise((done) => setTimeout(done, 250));
});

const silence = await stage('remove silence (laughter protected)', () => tool('remove_silence', { minSilenceSeconds: 0.6, padSeconds: 0.15, protectLoudGaps: true }),
  (r) => `${String(r.gapsCut ?? '?')} cut, ${String(r.gapsProtected ?? '?')} protected, now ${current().duration.toFixed(1)}s`);

// ── 5. dynamic framing: a new shot per sentence, framed on the face ───────
await stage('split per sentence + face framing', async () => {
  // The full timeline words (the agent tool returns compact rows): memo words where the memo covers.
  const words = buildTimelineTranscript(current(), (assetId) => transcripts.get(assetId)).words;
  const videoTrack = () => current().tracks.find((t) => t.kind === 'video')!;
  const sentenceEnds = words.filter((w) => /[.?!]["')\]]?$/.test(w.text)).map((w) => w.timelineEnd);
  const cuts: Array<{ clipId: string; at: number }> = [];
  for (const at of sentenceEnds) {
    const clip = videoTrack().clips.find((c) => at > c.start + 0.8 && at < c.start + (c.out - c.in) / (c.speed ?? 1) - 0.8);
    if (clip && !cuts.some((cut) => Math.abs(cut.at - at) < 1.5)) cuts.push({ clipId: clip.id, at });
  }
  // Latest first: splitting a clip keeps its id on the left piece, so every earlier cut stays inside it.
  cuts.sort((left, right) => right.at - left.at);
  for (let i = 0; i < cuts.length; i += 100) await tool('split_clips', { cuts: cuts.slice(i, i + 100) });

  // Static crops (animated zooms centre-crop first and can't reach an off-centre face).
  const track = faces.get(video.id)!;
  const [W, H] = [1080, 1920];
  const shots = ['wide', 'tight', 'medium'] as const;
  const scaleOf = { wide: 1, medium: 1.25, tight: 1.6 };
  const framing = videoTrack().clips.map((clip, index) => {
    const face = faceAt(track, (clip.in + clip.out) / 2);
    const scale = scaleOf[shots[index % shots.length]!];
    const cover = Math.max(W / video.width, H / video.height) * scale;
    const [iw, ih] = [video.width * cover, video.height * cover];
    const centre = (lo: number, hi: number) => (lo + hi) / 2;
    // crop left = (iw-W)/2*(1+x) (render.ts); solve for the x that centres the face.
    const fx = face ? centre(face.left, face.right) : 0.5;
    const fy = face ? centre(face.top, face.bottom) - 0.08 : 0.42; // a little headroom above the face
    const solve = (f: number, full: number, out: number) => Math.max(-1, Math.min(1, (f * full - out / 2) / ((full - out) / 2) - 1));
    return { type: 'set_transform', params: { clipId: clip.id, transform: { scale, x: solve(fx, iw, W), y: ih > H ? solve(fy, ih, H) : 0 } } };
  });
  await ops(framing);
  return { shots: videoTrack().clips.length, cuts: cuts.length };
}, (r) => `${r.shots} shots from ${r.cuts} sentence cuts`);

// ── 6. captions ───────────────────────────────────────────────────────────
await stage('karaoke captions from transcript', async () => {
  // Memo-aware: captioning the video clips takes the memo's words wherever it covers them.
  const videoClips = current().tracks.find((t) => t.kind === 'video')!.clips.map((c) => c.id);
  return await tool('caption_clip_from_transcript', { clipIds: videoClips.slice(0, 100), wordsPerChunk: 3, preset: 'standup_clip' });
}, () => `${current().tracks.find((t) => t.kind === 'caption')!.clips.length} caption clips`);
await stage('place captions off the face', () => tool('place_captions', { platform: 'instagram' }));

// ── 7. render ─────────────────────────────────────────────────────────────
const output = await stage('render 1080x1920', async () => {
  const render = await call<{ id: string }>('POST', `/projects/${project.id}/render`, { resolution: '1080p' });
  for (;;) {
    const state = await call<{ status: string; error?: string }>('GET', `/renders/${render.id}`);
    if (state.status === 'done' || state.status === 'ready') break;
    if (state.status === 'error' || state.status === 'failed') throw new Error(`render failed: ${state.error ?? ''}`);
    await new Promise((done) => setTimeout(done, 1000));
  }
  const file = join(dataDir, 'renders', render.id, 'output.mp4');
  const copy = join(dataDir, 'standup-edit.mp4');
  await copyFile(file, copy);
  return copy;
}, (path) => path);

await background;
const final = current();
const report = {
  media: { video: videoName, memo: memoName },
  synced, silence: { gapsCut: silence.gapsCut, gapsProtected: silence.gapsProtected },
  result: { duration: final.duration, shots: final.tracks.find((t) => t.kind === 'video')!.clips.length, captions: final.tracks.find((t) => t.kind === 'caption')!.clips.length, output },
  timings,
};
const { writeFile } = await import('node:fs/promises');
await writeFile(join(dataDir, 'timings.json'), JSON.stringify(report, null, 2));
console.log('\n| stage | start | end | seconds | note |\n|---|---|---|---|---|');
for (const t of timings) console.log(`| ${t.stage} | ${t.start.toFixed(1)} | ${t.end.toFixed(1)} | ${(t.end - t.start).toFixed(2)} | ${t.note ?? ''} |`);
console.log(`\noutput: ${output}\ntimings: ${join(dataDir, 'timings.json')}`);
await app.close();
process.exit(0);
