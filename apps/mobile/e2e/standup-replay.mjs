#!/usr/bin/env node
// Stand-up workflow replay: the same flow a person does on the phone, driven
// by agent-device against a local server, with every step timed.
//
//   node apps/mobile/e2e/standup-replay.mjs [--mode cold|warm] [--record] [--review] [--skip-render]
//
//   cold  empty server: pick the 4K clip from the camera roll and the memo from
//         Files, wait for real processing (what a person waits for today)
//   warm  server cloned from the stand-up fixture (server/scripts/fixtures):
//         the project already holds both clips, so the run starts at the agent
//
// Each step is `human` (a tap/pick/type, with an estimate of how long a person
// takes) or `wait` (product latency, measured from server state). The report
// adds them up: "how long would this take a person" = human estimates + waits.
//
//   setup server ─▶ open app ─▶ steps (agent-device + server polling) ─▶ export 1080p ─▶ timings.json
//        └─ server.ndjson (pino log) ──────────────────────────────▶ profile.json ─(--record)─▶ review page
//
// The run dir keeps timings.json, server.ndjson, chat.json and profile.json (see
// .claude/skills/mobile-verify/scripts/profile.mjs): which server jobs ran during
// each wait, request/polling stats, render speed and the agent turn.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'cold';
const record = args.includes('--record');
const exportRender = !args.includes('--skip-render');
const SESSION = 'standup-replay';
const DEVICE = process.env.SIM_DEVICE ?? 'iPhone 17 Pro Max';
const API = 'http://127.0.0.1:3001';
const findUp = (name, from) => { for (let d = from; d !== dirname(d); d = dirname(d)) if (existsSync(join(d, name))) return join(d, name); };
const envFile = findUp('.env.local', repo);
const MEDIA = process.env.STANDUP_MEDIA ?? join(dirname(envFile ?? repo), 'stand-up audio sync test');
const PICKER_VIDEO = 'Video, four minutes, fifty-five seconds';
const MEMO_CELL = 'Brooklyn Roasting Company, m4a';
const out = mkdtempSync(join(tmpdir(), `standup-${mode}-`));
const S = join(repo, '.claude/skills/mobile-verify/scripts');

// ── helpers ────────────────────────────────────────────────────────────────
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const steps = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function ad(...argv) {
  return execFileSync('agent-device', [...argv, '--session', SESSION], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryAd(...argv) { try { return ad(...argv); } catch { return undefined; } }
// Every call from this script carries `via=replay` (visible in the pino req.url),
// so profile.mjs can keep harness polling out of the app's request stats.
const tagged = (path) => `${path}${path.includes('?') ? '&' : '?'}via=replay`;
async function api(path, init) {
  const response = await fetch(`${API}${tagged(path)}`, init);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}
let serverExit; // set once the server child exits: polling a dead server is pointless
async function until(check, { timeout = 600_000, every = 500, what }) {
  const start = Date.now();
  for (;;) {
    if (serverExit) throw new Error(`server exited (${serverExit}) while waiting for ${what}`);
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
/** A person's action: run it, time it, and record how long a person would take. */
async function human(name, humanSeconds, run, note, tag) {
  const start = now();
  await run();
  steps.push({ name, kind: 'human', start, seconds: now() - start, humanSeconds, note, ...(tag ? { tag } : {}) });
  console.log(`${start.toFixed(1).padStart(7)}s  human ${String(humanSeconds).padStart(4)}s  ${name}`);
}
/** Product latency: how long the app makes the person wait, measured from server state. */
async function wait(name, run, note, tag) {
  const start = now();
  const value = await run();
  const seconds = now() - start;
  steps.push({ name, kind: 'wait', start, seconds, note, ...(tag ? { tag } : {}) });
  console.log(`${start.toFixed(1).padStart(7)}s  wait  ${seconds.toFixed(1).padStart(5)}s  ${name}`);
  return value;
}
const tap = (selector) => ad('press', selector);
const waitFor = (selector, ms = 15000) => ad('wait', selector, String(ms));

// ── server ─────────────────────────────────────────────────────────────────
for (const pid of (tryAdPids() ?? [])) try { process.kill(pid); } catch {}
function tryAdPids() {
  try { return execFileSync('lsof', ['-tiTCP:3001', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
}
await sleep(800);
const dataDir = join(out, 'data');
let manifest;
if (mode === 'warm') {
  execFileSync('npx', ['tsx', 'scripts/fixtures/standup-fixture.ts', 'clone', dataDir], { cwd: join(repo, 'server'), stdio: 'inherit' });
  manifest = JSON.parse((await import('node:fs')).readFileSync(join(dataDir, 'manifest.json'), 'utf8'));
} else {
  mkdirSync(dataDir, { recursive: true });
}
// stdout + stderr (pino JSON lines) go to the run dir for profile.mjs.
const serverLog = join(out, 'server.ndjson');
const serverLogFd = openSync(serverLog, 'w');
const serverStartedAtMs = Date.now();
const server = spawn('node', [...(envFile ? [`--env-file=${envFile}`] : []), '--import', 'tsx', 'src/index.ts'], {
  cwd: join(repo, 'server'),
  env: { ...process.env, EDITIFY_DATA_DIR: dataDir, MEDIA_IMPORT_DIR: MEDIA, PORT: '3001', EDITIFY_TOKEN: '', SUPABASE_URL: '' },
  stdio: ['ignore', serverLogFd, serverLogFd],
});
closeSync(serverLogFd); // the child keeps its own copy
server.on('exit', (code, signal) => { serverExit = signal ?? `code ${code}`; });
process.on('exit', () => { try { server.kill(); } catch {} });
await until(() => fetch(`${API}${tagged('/presets')}`).then((r) => r.ok), { what: 'server', every: 300, timeout: 30000 });

// Simulator media for the cold flow (idempotent).
const udid = Object.values(JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' })).devices)
  .flat().find((d) => d.name === DEVICE)?.udid;
if (mode === 'cold' && udid) {
  const groups = join(process.env.HOME, 'Library/Developer/CoreSimulator/Devices', udid, 'data/Containers/Shared/AppGroup');
  for (const g of readdirSync(groups)) {
    const storage = join(groups, g, 'File Provider Storage');
    if (existsSync(storage) && readdirSync(storage).some((f) => f.endsWith('.m4a'))) {
      const memo = readdirSync(MEDIA).find((f) => f.endsWith('.m4a'));
      if (memo && !existsSync(join(storage, memo))) copyFileSync(join(MEDIA, memo), join(storage, memo));
    }
  }
}

// ── the flow ───────────────────────────────────────────────────────────────
// One session owns a device: close any other agent-device session first (e.g. a manual one).
try {
  const listed = JSON.parse(execFileSync('agent-device', ['session', 'list', '--json'], { encoding: 'utf8' }));
  for (const session of listed.data?.sessions ?? []) {
    const name = session.name ?? session.session ?? session.id;
    if (name) try { execFileSync('agent-device', ['close', '--session', name], { stdio: 'ignore' }); } catch {}
  }
} catch {}
try {
  ad('open', 'com.editify.app', '--platform', 'ios', '--device', DEVICE, '--relaunch');
} catch (error) {
  // The session list can miss a stale owner; the error names it.
  const owner = /in use by session "([^"]+)"/.exec(String(error.stderr ?? error))?.[1];
  if (!owner) throw error;
  execFileSync('agent-device', ['close', '--session', owner], { stdio: 'ignore' });
  ad('open', 'com.editify.app', '--platform', 'ios', '--device', DEVICE, '--relaunch');
}
const video = join(out, 'flow.mp4');
if (record) { tryAd('record', 'stop'); ad('record', 'start', video, '--hide-touches'); execFileSync('node', [join(S, 'moments.mjs'), 'start', join(out, 'moments.json'), '--title', `Stand-up workflow replay (${mode})`]); }
process.on('uncaughtException', (error) => {
  if (record) tryAd('record', 'stop');
  try { server.kill(); } catch {}
  console.error(error);
  process.exit(1);
});
const mark = (label, kind = 'step', note) => record && execFileSync('node', [join(S, 'moments.mjs'), 'mark', join(out, 'moments.json'), label, '--kind', kind, ...(note ? ['--note', note] : [])]);
await sleep(1500);

let projectId;
if (mode === 'warm') {
  // The fixture's clips placed on a fresh project before the UI run, as if imported earlier.
  const project = await api('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Stand-up (fixture)', format: '9:16' }) });
  projectId = project.id;
  for (const id of [manifest.video.id, manifest.memo.id]) await api(`/assets/${id}/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) });
  const v = await api(`/assets/${manifest.video.id}`); const m = await api(`/assets/${manifest.memo.id}`);
  await api(`/projects/${projectId}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: project.version, ops: [
    { type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'clip-1', assetId: v.id, start: 0, in: 0, out: v.duration } } },
    { type: 'add_clip', params: { trackId: 'audio-main', clip: { id: 'memo-1', assetId: m.id, start: 59.42375, in: 0, out: m.duration } } },
  ] }) });
  await human('Open the stand-up project', 2, () => { ad('open', `editify://project/${projectId}`); waitFor('label="add media from camera roll"', 20000); });
} else {
  await human('Start a 9:16 Instagram Reel project', 2, () => { tap('label="9:16, Instagram Reel, 9:16 · UP TO 90S"'); waitFor('label="add media from camera roll"'); });
  projectId = (await api('/projects'))[0].id;
  mark('New project');
  await human('Pick the 4K clip from the camera roll', 5, async () => {
    tap('label="add media from camera roll"'); waitFor('label="Done"');
    const ref = /(@e\d+) \[image\] "Video, four minutes, fifty-five seconds/.exec(ad('snapshot', '-i'))?.[1];
    if (!ref) throw new Error('stand-up clip not in the picker');
    tap(ref); tap('label="Done"');
  });
  mark('Picked the clip');
  const asset = await wait('Upload the clip', () => until(async () => (await api(`/assets?projectId=${projectId}`))[0], { what: 'upload' }), undefined, 'upload');
  mark('Clip uploaded', 'check');
  if (/Allow Full Access/.test(tryAd('snapshot', '-i') ?? '')) {
    await human('Allow full Photos access', 3, () => tap('label="Allow Full Access"'), 'iOS asks after the pick');
  }
  await wait('Preview playable (server proxy)', () => until(async () => (await api(`/assets/${asset.id}`)).status === 'ready', { what: 'proxy', every: 1000 }), 'the 540p proxy gates the preview', 'proxy');
  mark('Preview playable', 'check');
  await human('Pick the voice memo from Files', 6, async () => {
    tap('label="add media from documents"'); await sleep(1200);
    tryAd('press', 'label="Browse"'); await sleep(800);
    const memoRef = () => new RegExp(`(@e\\d+) \\[cell\\] "${MEMO_CELL}`).exec(ad('snapshot', '-i'))?.[1];
    // Files reopens wherever it was last: the folder itself, or the Locations root.
    let ref = memoRef();
    if (!ref) { tryAd('press', 'label="On My iPhone"'); await sleep(1000); ref = memoRef(); }
    if (!ref) throw new Error('memo not in Files');
    tap(ref); tap('label="Open"');
  });
  await wait('Memo uploaded and auto-synced', () => until(async () => {
    const project = await api(`/projects/${projectId}`);
    return project.tracks.flatMap((t) => t.clips).some((c) => c.assetId && c.start > 50 && c.start < 70) && project;
  }, { what: 'sync' }), undefined, 'sync');
  mark('Memo synced', 'check');
}

const before = (await api(`/projects/${projectId}/chat`)).length;
await human('Ask the agent for a stand-up cut', 4 + 120 / 3, async () => {
  for (let i = 0; i < 4 && !/Use the standup clip preset/.test(ad('snapshot', '-i')); i += 1) ad('scroll', 'down', '2000');
  tap('label="Use the standup clip preset"'); await sleep(600);
  for (let i = 0; i < 4 && !/\[text-view\]/.test(ad('snapshot', '-i')); i += 1) ad('scroll', 'down', '1500');
  // The composer is labelled "chat composer"; until Metro serves that, it is the
  // only editable text view on screen before sending.
  const composer = /(@e\d+) \[text-view\] "chat composer"/.exec(ad('snapshot', '-i'))?.[1]
    ?? /(@e\d+) \[text-view\][^\n]*\[editable\]/.exec(ad('snapshot', '-i'))?.[1];
  if (!composer) throw new Error('chat composer not found');
  tap(composer);
  ad('type', '. The memo is synced: use it as the sound, remove the silences but keep the laughs, and add stand-up style captions.');
  tap('label="Editor"'); await sleep(400); // dismiss the keyboard: it covers send
  tap('label="send"');
}, 'preset chip + ~120 typed characters at ~3 chars/s');
await human('Accept the improved prompt', 4, async () => { waitFor('label="use this"', 15000); tap('label="use this"'); }, 'read the card, tap "use this"');
mark('Sent to the agent');
await wait('Agent edits the project', () => until(async () => {
  const messages = await api(`/projects/${projectId}/chat`);
  return messages.length >= before + 2 && messages.at(-1).role === 'assistant';
}, { what: 'agent', every: 1000 }), undefined, 'agent');
mark('Agent done', 'check');
await human('Watch the result', 10, async () => { for (let i = 0; i < 4; i += 1) ad('scroll', 'up', '4000'); tap('label="play"'); await sleep(10000); tryAd('press', 'label="pause"'); });

if (record) ad('record', 'stop');
tryAd('close');

// Export: the same request the export sheet sends, then the wait for the master.
// Driven through the API (the recording has stopped), timed like any other step.
// The export phase (tagged export/render) is reported beside person time, not in it.
// A failed or stuck render is recorded, never fatal: the run's timings still get written.
let render;
if (exportRender) {
  let projectSeconds = null;
  const renderStart = { at: null };
  try {
    projectSeconds = (await api(`/projects/${projectId}`)).duration;
    let queued;
    await human('Start the 1080p export', 3, async () => {
      queued = await api(`/projects/${projectId}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: '1080p' }) });
    }, 'open export, pick 1080p, tap export (sent through the API)', 'export');
    renderStart.at = now();
    const timeout = Math.max(5 * 60_000, 3 * (projectSeconds ?? 0) * 1000);
    const finished = await wait('Render 1080p', () => until(async () => {
      const row = await api(`/renders/${queued.id}`);
      return (row.status === 'done' || row.status === 'error') && row;
    }, { what: 'render', every: 1000, timeout }), 'POST /projects/:id/render until GET /renders/:id is done', 'render');
    const seconds = now() - renderStart.at;
    const done = finished.status === 'done' && projectSeconds > 0;
    render = { id: queued.id, resolution: finished.resolution, status: finished.status, seconds, projectSeconds,
      xRealtime: done ? projectSeconds / seconds : null, secondsPerOutputMinute: done ? seconds / (projectSeconds / 60) : null,
      ...(finished.error ? { error: finished.error } : {}) };
  } catch (error) {
    render = { status: 'error', error: String(error.message ?? error), projectSeconds, seconds: renderStart.at == null ? null : now() - renderStart.at, xRealtime: null, secondsPerOutputMinute: null };
  }
  console.log(render.xRealtime
    ? `render done: ${render.projectSeconds}s of output in ${render.seconds.toFixed(1)}s (${render.xRealtime.toFixed(2)}x realtime wall clock, ${render.secondsPerOutputMinute.toFixed(1)}s per output minute)`
    : `render ${render.status}${render.error ? `: ${render.error}` : ''}`);
}
// The agent's trace (tool calls, thoughts, ops) for the profile.
if (!serverExit) try { writeFileSync(join(out, 'chat.json'), JSON.stringify(await api(`/projects/${projectId}/chat`), null, 2)); } catch {}
server.kill();

// ── report ─────────────────────────────────────────────────────────────────
// Person time is the editing flow only (comparable with runs that never exported).
const exportPhase = (s) => s.tag === 'export' || s.tag === 'render';
const sum = (kind, field, phase = false) => steps.filter((s) => s.kind === kind && exportPhase(s) === phase).reduce((total, s) => total + s[field], 0);
const report = {
  mode, at: new Date().toISOString(), startedAtMs: t0, server: { startedAtMs: serverStartedAtMs, log: 'server.ndjson' }, ...(render ? { render } : {}), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  steps, totals: {
    runSeconds: now(), productWaitSeconds: sum('wait', 'seconds'), automationSeconds: sum('human', 'seconds') + sum('human', 'seconds', true),
    humanEstimateSeconds: sum('human', 'humanSeconds'), personSeconds: sum('human', 'humanSeconds') + sum('wait', 'seconds'),
    renderWaitSeconds: sum('wait', 'seconds', true), exportPersonSeconds: sum('human', 'humanSeconds', true) + sum('wait', 'seconds', true),
  },
};
writeFileSync(join(out, 'timings.json'), JSON.stringify(report, null, 2));
const fmt = (s) => { const whole = Math.round(s); return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`; };
console.log(`\n| step | kind | measured | a person |\n|---|---|---|---|`);
for (const s of steps) console.log(`| ${s.name} | ${s.kind} | ${s.seconds.toFixed(1)}s | ${(s.kind === 'wait' ? s.seconds : s.humanSeconds).toFixed(1)}s |`);
console.log(`\nproduct waits ${fmt(report.totals.productWaitSeconds)} · a person ~${fmt(report.totals.personSeconds)}${render ? ` (+ export ${fmt(report.totals.exportPersonSeconds)})` : ''} · this replay ${fmt(report.totals.runSeconds)}`);
console.log(`timings: ${join(out, 'timings.json')}`);
await sleep(300); // let the killed server's last log lines land
const profilePath = join(out, 'profile.json');
let profiled = false;
try {
  execFileSync('node', [join(S, 'profile.mjs'), '--timings', join(out, 'timings.json'), '--log', serverLog, '--chat', join(out, 'chat.json'), '--out', profilePath], { stdio: 'ignore' });
  profiled = true;
  console.log(`profile: ${profilePath}`);
  // The profile's speed prefers the server's encode time over this script's wall clock.
  const speed = JSON.parse(readFileSync(profilePath, 'utf8')).render?.xRealtime;
  if (render && speed != null) render.profileXRealtime = speed;
} catch (error) { console.error(`profile failed: ${error.message}`); }
const renderSpeed = render?.profileXRealtime ?? render?.xRealtime;
const renderMeta = !render ? null : render.status !== 'done' ? 'failed' : renderSpeed != null ? `${renderSpeed.toFixed(2)}x` : null;
if (record && args.includes('--review')) {
  const page = execFileSync('node', [join(S, 'build-review.mjs'), '--video', video, '--moments', join(out, 'moments.json'), '--slug', `standup-replay-${mode}`, '--meta', `mode=${mode}`, '--meta', `commit=${report.commit}`, '--meta', `person=~${fmt(report.totals.personSeconds)}`,
    ...(renderMeta ? ['--meta', `render=${renderMeta}`] : []), ...(profiled ? ['--profile', profilePath] : [])], { encoding: 'utf8' }).trim();
  console.log(execFileSync(join(S, 'serve-tailnet.sh'), [dirname(page)], { encoding: 'utf8' }).trim());
}
process.exit(0);
