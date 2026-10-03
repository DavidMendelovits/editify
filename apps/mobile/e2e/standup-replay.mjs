#!/usr/bin/env node
// Stand-up workflow replay: the same flow a person does on the phone, driven
// by agent-device against a local server, with every step timed.
//
//   node apps/mobile/e2e/standup-replay.mjs [--mode cold|warm] [--record] [--review]
//        [--export device|server|both|none] [--server-baseline 0.88|<review dir>] [--skip-render]
//        [--build Release|Debug]   (the installed app's configuration, shown on the review page)
//
//   cold  empty server: pick the 4K clip from the camera roll and the memo from
//         Files, wait for real processing (what a person waits for today)
//   warm  server cloned from the stand-up fixture (server/scripts/fixtures):
//         the project already holds both clips, so the run starts at the agent.
//         The phone's media registry gets rows for the fixture's assets, copied from
//         the newest rows a cold run left (the same IMG_0008 and memo), so the clips
//         count as on this iPhone, as if imported earlier
//
// Export (1080p, after the agent's edit):
//   device (default)  in the UI: open export, tap render; when every clip is on this
//         iPhone the screen routes to the device path and the replay waits on the card's
//         state (never the server), reading what it shows: LUFS, pre-encode true peak,
//         the app's x realtime. Recorded with the rest of the flow. If the screen routes
//         to the server instead, its reason is recorded and the server path runs
//   server  the request the export sheet sends to the server, through the API, after the
//         recording (the pre-device behaviour)
//   both    device, then the server render too (tagged `compare`: in neither total)
//   none    no export (`--skip-render` is the old spelling)
// The server baseline (render speed of the newest earlier review with a done server
// render at this resolution, or --server-baseline) goes in timings.json for the page.
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
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const exportPath = args.includes('--skip-render') ? 'none' : (opt('--export') ?? 'device');
if (!['device', 'server', 'both', 'none'].includes(exportPath)) throw new Error(`--export ${exportPath}: device, server, both or none`);
const RESOLUTION = '1080p';
const REVIEWS = process.env.REVIEWS_ROOT ?? join(process.env.HOME, 'editify-reviews');
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

// Warm: the fixture's clips are on this iPhone too. The registry (expo-sqlite,
// Documents/SQLite/local-media.db in the app's data container) gets rows for the
// fixture's asset ids, copied from the newest local rows of the same media (matched by
// duration) that a cold run left. Written with the app stopped; a cold run first if none.
const SEED = 'local_media';
if (mode === 'warm' && udid && exportPath !== 'none') {
  try { execFileSync('xcrun', ['simctl', 'terminate', udid, 'com.editify.app'], { stdio: 'ignore' }); } catch {}
  const container = execFileSync('xcrun', ['simctl', 'get_app_container', udid, 'com.editify.app', 'data'], { encoding: 'utf8' }).trim();
  const db = join(container, 'Documents/SQLite/local-media.db');
  const sql = (query) => execFileSync('sqlite3', [db, query], { encoding: 'utf8' }).trim();
  const columns = existsSync(db) ? sql(`SELECT group_concat(name, ',') FROM pragma_table_info('${SEED}')`).split(',').filter((c) => c && c !== 'asset_id') : [];
  for (const [what, id, local] of [['video', manifest.video.id, 'ph_local_id IS NOT NULL'], ['memo', manifest.memo.id, 'file_uri IS NOT NULL']]) {
    const { duration } = await api(`/assets/${id}`);
    const from = columns.length && /^[\w-]+$/.test(id) && Number.isFinite(duration)
      ? sql(`SELECT asset_id FROM ${SEED} WHERE ${local} AND server_only = 0 AND asset_id != '${id}' AND abs(duration - ${duration}) < 0.5 ORDER BY updated_at DESC LIMIT 1`)
      : '';
    if (!from) { console.warn(`warm: no local ${what} row on the phone to copy (run a cold replay first); the export will route to the server`); continue; }
    sql(`INSERT OR REPLACE INTO ${SEED} (asset_id, ${columns.join(', ')}) SELECT '${id}', ${columns.join(', ')} FROM ${SEED} WHERE asset_id = '${from}'`);
    console.log(`warm: registry row for the fixture ${what} ${id} copied from ${from}`);
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
  // A relaunched dev client can still be loading its bundle: wait for home first.
  waitFor('label="9:16, Instagram Reel, 9:16 · UP TO 90S"', 60000);
  await human('Start a 9:16 Instagram Reel project', 2, () => { tap('label="9:16, Instagram Reel, 9:16 · UP TO 90S"'); waitFor('label="add media from camera roll"'); });
  projectId = (await api('/projects'))[0].id;
  mark('New project');
  await human('Pick the 4K clip from the camera roll', 5, async () => {
    tap('label="add media from camera roll"');
    // First import: our "Use your originals" explainer, then iOS's Photos prompt (Allow
    // Full Access), then the picker. Each only shows while access is undetermined.
    for (let i = 0; i < 40; i += 1) {
      const screen = tryAd('snapshot', '-i') ?? '';
      if (/"Use your originals"/.test(screen)) { tap('label="Continue"'); mark('Use your originals: Continue'); continue; }
      if (/"Allow Full Access"/.test(screen)) { tap('label="Allow Full Access"'); mark('iOS Photos prompt: Allow Full Access'); continue; }
      if (/"Done"/.test(screen)) break;
      await sleep(500);
    }
    waitFor('label="Done"');
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

// ── export ─────────────────────────────────────────────────────────────────
// The export phase (tagged export/render) is reported beside person time, not in it.
// A failed or stuck export is recorded, never fatal: the run's timings still get written.
const renders = [];
let projectSeconds = null;
if (exportPath !== 'none') projectSeconds = await api(`/projects/${projectId}`).then((p) => p.duration).catch(() => null);
const renderTimeout = () => Math.max(5 * 60_000, 3 * (projectSeconds ?? 0) * 1000);

/** The device export card's state labels (export.tsx exportStateLabel, upper-cased). */
const CARD_STATE = /"(STARTING|WAITING TO START|PREPARING CLIPS|MEASURING LOUDNESS|RENDERING \d+%|SAVING TO PHOTOS|SAVED TO PHOTOS|READY TO SHARE|EXPORT FAILED|CANCELLED)"/;
const CARD_DONE = /^(SAVED TO PHOTOS|READY TO SHARE|EXPORT FAILED|CANCELLED)$/;
/** "-16.0 LUFS · PEAK -1.2 dBTP PRE-ENCODE · 2.3x REALTIME" (or SILENT, no peak). */
function readCardStats(screen) {
  const line = /"((?:-?\d+(?:\.\d+)? LUFS|SILENT)[^"]*REALTIME)"/.exec(screen)?.[1];
  if (!line) return {};
  const lufs = /(-?\d+(?:\.\d+)?) LUFS/.exec(line)?.[1];
  const peak = /PEAK (-?\d+(?:\.\d+)?) dBTP/.exec(line)?.[1];
  const memory = /(\d+(?:\.\d+)?) ?MB/.exec(line)?.[1];
  return {
    label: line, silent: line.startsWith('SILENT'), lufs: lufs ? Number(lufs) : null, truePeakPreEncode: peak ? Number(peak) : null,
    xRealtime: Number(/([\d.]+)x REALTIME/.exec(line)?.[1] ?? NaN), peakMemMB: memory ? Number(memory) : null,
  };
}

/**
 * The device path, in the UI: open export (1080p is the default), and when the screen
 * routes to this iPhone tap render and wait on the card's state. Returns null when the
 * screen routes to the server (the caller falls back), with the reason in `routed`.
 */
const routed = { line: null };
async function deviceExport() {
  await human('Open export (1080p)', 3, async () => {
    tryAd('press', 'label="pause"');
    tap('label="export ↗"');
    waitFor(`label="render ${RESOLUTION} master"`, 20000);
  }, 'tap export; 1080p is preselected', 'export');
  // The route query resolves every clip against the registry before the line shows. A full
  // snapshot: `-i` leaves out the button, the route line and the card below the fold.
  let screen = '';
  for (let i = 0; i < 40; i += 1) {
    screen = tryAd('snapshot') ?? '';
    routed.line = /"(Exports on this iPhone[^"]*|Renders on the server[^"]*)"/.exec(screen)?.[1] ?? null;
    if (routed.line) break;
    await sleep(500);
  }
  if (!routed.line?.startsWith('Exports on this iPhone')) {
    mark('Export routes to the server', 'issue', routed.line ?? 'no route line on the export screen');
    tryAd('press', 'label="‹  EDITOR"');
    return null;
  }
  mark('Export routes to this iPhone', 'check', routed.line);
  let tapAt = 0;
  await human(`Render ${RESOLUTION} on this iPhone`, 1, () => { tap(`label="render ${RESOLUTION} master"`); tapAt = now(); }, 'tap render', 'export');
  const states = [];
  let shown = {};
  let error = null;
  const finished = await wait(`Render ${RESOLUTION} on this iPhone`, async () => {
    for (let scrolled = false; ;) {
      screen = tryAd('snapshot') ?? '';
      // iOS asks for add-only Photos access the first time an export saves.
      if (/"Allow Full Access"|"Allow Access"|"Allow"/.test(screen) && !CARD_STATE.test(screen)) { tryAd('alert', 'accept'); continue; }
      const state = CARD_STATE.exec(screen)?.[1];
      if (!state && !scrolled) { tryAd('scroll', 'down', '600'); scrolled = true; continue; }
      if (state && state !== states.at(-1)?.state) {
        states.push({ state, at: Math.round((now() - tapAt) * 10) / 10 });
        console.log(`          device card: ${state} (+${states.at(-1).at}s)`);
      }
      if (state && CARD_DONE.test(state)) return state;
      if (now() - tapAt > renderTimeout() / 1000) throw new Error(`device export still "${state}" after ${Math.round(now() - tapAt)}s`);
      await sleep(700);
    }
  }, 'tap render until the card says saved/ready (UI state, no server polling)', 'render');
  const seconds = now() - tapAt;
  // The stats line sits under the card, below the fold: scroll, then read it.
  tryAd('scroll', 'down', '600');
  screen = tryAd('snapshot') ?? screen;
  if (finished === 'EXPORT FAILED') error = /"EXPORT FAILED"[\s\S]*?\[text\] "([^"]+)"/.exec(screen)?.[1] ?? 'the export failed';
  else shown = readCardStats(screen);
  const done = finished === 'SAVED TO PHOTOS' || finished === 'READY TO SHARE';
  mark(done ? `Exported on this iPhone: ${shown.label ?? finished}` : `Device export: ${finished}`, done ? 'check' : 'issue', error ?? undefined);
  return { path: 'device', resolution: RESOLUTION, status: done ? 'done' : finished === 'CANCELLED' ? 'cancelled' : 'error', seconds, projectSeconds,
    xRealtime: done && projectSeconds > 0 ? projectSeconds / seconds : null, secondsPerOutputMinute: done && projectSeconds > 0 ? seconds / (projectSeconds / 60) : null,
    shown, states, finalState: finished, ...(error ? { error } : {}) };
}

/** The server path: the request the export sheet sends, then the wait for the master, through the API. */
async function serverExport(tag, note) {
  const renderStart = { at: null };
  try {
    let queued;
    await human(`Start the ${RESOLUTION} server export`, 3, async () => {
      queued = await api(`/projects/${projectId}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: RESOLUTION }) });
    }, 'open export, pick 1080p, tap export (sent through the API)', tag === 'compare' ? 'compare' : 'export');
    renderStart.at = now();
    const finished = await wait(`Render ${RESOLUTION} on the server`, () => until(async () => {
      const row = await api(`/renders/${queued.id}`);
      return (row.status === 'done' || row.status === 'error') && row;
    }, { what: 'render', every: 1000, timeout: renderTimeout() }), 'POST /projects/:id/render until GET /renders/:id is done', tag);
    const seconds = now() - renderStart.at;
    const done = finished.status === 'done' && projectSeconds > 0;
    return { path: 'server', id: queued.id, resolution: finished.resolution, status: finished.status, seconds, projectSeconds,
      xRealtime: done ? projectSeconds / seconds : null, secondsPerOutputMinute: done ? seconds / (projectSeconds / 60) : null,
      ...(finished.error ? { error: finished.error } : {}), ...(note ? { note } : {}) };
  } catch (error) {
    return { path: 'server', status: 'error', error: String(error.message ?? error), projectSeconds, seconds: renderStart.at == null ? null : now() - renderStart.at, xRealtime: null, secondsPerOutputMinute: null, ...(note ? { note } : {}) };
  }
}

let fellBack = false;
if (exportPath === 'device' || exportPath === 'both') {
  try {
    const device = await deviceExport();
    if (device) renders.push(device);
    else fellBack = true;
  } catch (error) {
    renders.push({ path: 'device', resolution: RESOLUTION, status: 'error', error: String(error.message ?? error), projectSeconds, seconds: null, xRealtime: null });
    mark('Device export failed', 'issue', String(error.message ?? error));
  }
}
if (record) ad('record', 'stop');
tryAd('close');
if (exportPath === 'server' || fellBack) renders.push(await serverExport('render', fellBack ? `device path not offered: ${routed.line ?? 'no route line'}` : undefined));
if (exportPath === 'both') renders.push(await serverExport('compare'));
for (const r of renders) {
  console.log(r.xRealtime
    ? `${r.path} render done: ${r.projectSeconds}s of output in ${r.seconds.toFixed(1)}s (${r.xRealtime.toFixed(2)}x realtime wall clock, ${r.secondsPerOutputMinute.toFixed(1)}s per output minute)${r.shown?.label ? ` · card: ${r.shown.label}` : ''}`
    : `${r.path} render ${r.status}${r.error ? `: ${r.error}` : ''}`);
}
const render = renders[0];

/**
 * The server baseline: --server-baseline <x> or <review dir name>, else the newest earlier
 * stand-up review with a done server render at this resolution.
 */
function serverBaseline() {
  const pinned = opt('--server-baseline');
  const given = Number(pinned);
  if (Number.isFinite(given) && given > 0) return { path: 'server', xRealtime: given, resolution: RESOLUTION, source: '--server-baseline' };
  try {
    const names = pinned ? [pinned] : readdirSync(REVIEWS).filter((n) => /standup-replay/.test(n)).sort().reverse();
    for (const name of names) {
      const file = join(REVIEWS, name, 'review.json');
      if (!existsSync(file)) continue;
      const profile = JSON.parse(readFileSync(file, 'utf8')).profile;
      const found = [...(profile?.renders ?? []), ...(profile?.render ? [profile.render] : [])]
        .find((r) => (r.path ?? 'server') === 'server' && r.status === 'done' && r.resolution === RESOLUTION && r.xRealtime != null);
      if (found) return { path: 'server', xRealtime: found.xRealtime, resolution: RESOLUTION, source: name };
    }
  } catch {}
  return null;
}
const baseline = renders.length ? serverBaseline() : null;

// The agent's trace (tool calls, thoughts, ops) for the profile.
if (!serverExit) try { writeFileSync(join(out, 'chat.json'), JSON.stringify(await api(`/projects/${projectId}/chat`), null, 2)); } catch {}
server.kill();

// ── report ─────────────────────────────────────────────────────────────────
// Person time is the editing flow only (comparable with runs that never exported).
// A comparison export (`--export both`: the server render after the device one) is in neither total.
const exportPhase = (s) => s.tag === 'export' || s.tag === 'render';
const sum = (kind, field, phase = false) => steps.filter((s) => s.kind === kind && s.tag !== 'compare' && exportPhase(s) === phase).reduce((total, s) => total + s[field], 0);
const report = {
  mode, build: opt('--build') ?? null, at: new Date().toISOString(), startedAtMs: t0, server: { startedAtMs: serverStartedAtMs, log: 'server.ndjson' }, ...(render ? { render, renders } : {}), ...(baseline ? { baseline } : {}), exportPath, commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
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
  const profiledRenders = JSON.parse(readFileSync(profilePath, 'utf8')).renders ?? [];
  renders.forEach((r, i) => { if (profiledRenders[i]?.xRealtime != null) r.profileXRealtime = profiledRenders[i].xRealtime; });
} catch (error) { console.error(`profile failed: ${error.message}`); }
const renderMeta = (r) => { const speed = r.profileXRealtime ?? r.xRealtime; return r.status !== 'done' ? 'failed' : speed != null ? `${speed.toFixed(2)}x` : null; };
const renderMetas = renders.map((r) => renderMeta(r) && `${r.path === 'device' ? 'device' : 'server'}=${renderMeta(r)}`).filter(Boolean);
if (baseline) renderMetas.push(`server-baseline=${baseline.xRealtime.toFixed(2)}x`);
if (record && args.includes('--review')) {
  const page = execFileSync('node', [join(S, 'build-review.mjs'), '--video', video, '--moments', join(out, 'moments.json'), '--slug', `standup-replay-${mode}${renders.some((r) => r.path === 'device') ? '-device' : ''}`, '--meta', `mode=${mode}`, '--meta', `commit=${report.commit}`, '--meta', `person=~${fmt(report.totals.personSeconds)}`, ...(opt('--build') ? ['--meta', `build=${opt('--build')}`] : []),
    ...renderMetas.flatMap((m) => ['--meta', m]), ...(profiled ? ['--profile', profilePath] : [])], { encoding: 'utf8' }).trim();
  console.log(execFileSync(join(S, 'serve-tailnet.sh'), [dirname(page)], { encoding: 'utf8' }).trim());
}
process.exit(0);
