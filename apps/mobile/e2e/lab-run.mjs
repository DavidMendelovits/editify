#!/usr/bin/env node
// Capability lab runner (plan P7): drives the lab screen with agent-device, waits for each
// spike's rows in Documents/lab/results.jsonl, and judges them with src/lab/evaluate.ts.
// The app must be a build with EXPO_PUBLIC_LAB=1 (a Release build for decision-grade rows).
//
//   node apps/mobile/e2e/lab-run.mjs --spike "S4 · Export" --spike "S5 · Native preview" \
//        [--memo] [--lag 59.424] [--seconds 20] [--record --review --title "..." --summary "..."]
//        [--device "iPhone 17 Pro Max"]            simulator (default), rows read from its container
//        [--udid <devicectl id>]                    a physical iPhone (agent-device --device <udid>, its
//                                                   XCTest runner signed: agent-device help physical-device);
//                                                   rows copied out with devicectl. Not yet run on a phone.
//
//   --spike  the start of a lab button's label (repeatable, run in order); every variant the
//            button lists runs RUNS_REQUIRED times inside the app. Append "#<rows>" (e.g.
//            "S4 · Export#6": two variants x 3 runs) to wait for exactly that many rows; the
//            busy line sits below the fold, so without it the runner can move on early
//   --memo   also pick the stand-up memo from Files (S11); --lag fills the expected lag
//
//   open editify://lab ─▶ pick the clip (Photos) [─▶ memo (Files)] ─▶ per spike: tap, wait for
//   its rows ─▶ results.jsonl (this session's rows) ─▶ evaluate ─▶ results.html (+ S5 frames)
//   ─(--record --review)─▶ review page with the results under the video
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '../..');
const S = join(repo, '.claude/skills/mobile-verify/scripts');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const many = (name) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
const spikes = many('--spike');
if (!spikes.length) throw new Error('--spike "<button label start>" is required');
const record = args.includes('--record');
const DEVICE = opt('--device') ?? 'iPhone 17 Pro Max';
const PHONE = opt('--udid');
const SESSION = 'lab-run';
const BUNDLE = 'com.editify.app';
const PICKER_VIDEO = 'Video, four minutes, fifty-five seconds';
const MEMO_CELL = 'Brooklyn Roasting Company, m4a';
const out = mkdtempSync(join(tmpdir(), 'lab-run-'));
const startedAt = new Date().toISOString();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ad = (...argv) => execFileSync('agent-device', [...argv, '--session', SESSION], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryAd = (...argv) => { try { return ad(...argv); } catch { return undefined; } };
const t0 = Date.now();
const mark = (label, kind = 'step', note) => {
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s  ${kind.padEnd(5)} ${label}${note ? ` (${note})` : ''}`);
  if (record) execFileSync('node', [join(S, 'moments.mjs'), 'mark', join(out, 'moments.json'), label, '--kind', kind, ...(note ? ['--note', note] : [])]);
};

// ── results.jsonl, from the simulator's container or the phone's ──
const simUdid = PHONE ? null : Object.values(JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' })).devices)
  .flat().find((d) => d.name === DEVICE)?.udid;
if (!PHONE && !simUdid) throw new Error(`no booted simulator named ${DEVICE}`);
function readResults() {
  if (PHONE) {
    const local = join(out, 'phone-results.jsonl');
    try {
      execFileSync('xcrun', ['devicectl', 'device', 'copy', 'from', '--device', PHONE, '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
        '--source', 'Documents/lab/results.jsonl', '--destination', local], { stdio: 'ignore' });
      return readFileSync(local, 'utf8');
    } catch { return ''; }
  }
  const container = execFileSync('xcrun', ['simctl', 'get_app_container', simUdid, BUNDLE, 'data'], { encoding: 'utf8' }).trim();
  const file = join(container, 'Documents/lab/results.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
const sessionRows = () => readResults().split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => !r.startedAt || r.startedAt >= startedAt.slice(0, 19));
function labFile(name) {
  if (PHONE) {
    const local = join(out, name);
    try {
      execFileSync('xcrun', ['devicectl', 'device', 'copy', 'from', '--device', PHONE, '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
        '--source', `Documents/lab/${name}`, '--destination', local], { stdio: 'ignore' });
      return local;
    } catch { return null; }
  }
  const container = execFileSync('xcrun', ['simctl', 'get_app_container', simUdid, BUNDLE, 'data'], { encoding: 'utf8' }).trim();
  const file = join(container, 'Documents/lab', name);
  return existsSync(file) ? file : null;
}

// ── open the lab ──
try {
  const listed = JSON.parse(execFileSync('agent-device', ['session', 'list', '--json'], { encoding: 'utf8' }));
  for (const session of listed.data?.sessions ?? []) {
    const name = session.name ?? session.session ?? session.id;
    if (name) try { execFileSync('agent-device', ['close', '--session', name], { stdio: 'ignore' }); } catch {}
  }
} catch {}
const target = ['--device', PHONE ?? DEVICE];
ad('open', BUNDLE, '--platform', 'ios', ...target, '--relaunch');
const video = join(out, 'flow.mp4');
if (record) {
  tryAd('record', 'stop');
  ad('record', 'start', video, '--hide-touches');
  execFileSync('node', [join(S, 'moments.mjs'), 'start', join(out, 'moments.json'), '--title', opt('--title') ?? 'Capability lab']);
}
await sleep(2000);
ad('open', 'editify://lab');
ad('wait', 'label="Pick local clip"', '30000');
mark('Lab open (Release, no Metro)');

/** Taps a lab button by the start of its label, scrolling down to it when it is below the fold. */
async function press(labelStart) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const screen = ad('snapshot', '-i');
    const escaped = labelStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ref = new RegExp(`(@e\\d+) \\[[^\\]]+\\] "${escaped}`).exec(screen)?.[1];
    if (ref) { ad('press', ref); return; }
    tryAd('scroll', 'down', '500');
    await sleep(400);
  }
  throw new Error(`no button starting "${labelStart}"`);
}

// The clip from Photos: a single pick may close the picker on its own, or want Done.
await press('Pick local clip');
for (let i = 0; i < 40; i += 1) {
  const screen = tryAd('snapshot', '-i') ?? '';
  if (/"Allow Full Access"/.test(screen)) { tryAd('press', 'label="Allow Full Access"'); continue; }
  const ref = new RegExp(`(@e\\d+) \\[image\\] "${PICKER_VIDEO}`).exec(screen)?.[1];
  if (ref) { ad('press', ref); break; }
  await sleep(500);
}
await sleep(1200);
if (/"Done"/.test(tryAd('snapshot', '-i') ?? '')) tryAd('press', 'label="Done"');
ad('wait', 'label="Local clip ✓"', '20000');
mark('Picked the 4K stand-up clip (IMG_0008) from Photos');

if (args.includes('--memo')) {
  await press('Pick memo');
  await sleep(1500);
  tryAd('press', 'label="Browse"'); await sleep(800);
  const memoRef = () => new RegExp(`(@e\\d+) \\[cell\\] "${MEMO_CELL}`).exec(ad('snapshot', '-i'))?.[1];
  let ref = memoRef();
  if (!ref) { tryAd('press', 'label="On My iPhone"'); await sleep(1000); ref = memoRef(); }
  if (!ref) throw new Error('memo not in Files');
  ad('press', ref); await sleep(800); tryAd('press', 'label="Open"');
  ad('wait', 'label="Memo ✓"', '20000');
  mark('Picked the voice memo from Files');
  if (opt('--lag')) { ad('fill', 'label="Expected memo lag in seconds"', opt('--lag')); mark(`Expected lag ${opt('--lag')} s`); }
}
if (opt('--seconds')) { ad('fill', 'label="Preview seconds"', opt('--seconds')); mark(`Preview seconds: ${opt('--seconds')}`); }
// The decimal pad has no return key, and while it is up the ScrollView spends the next tap on
// dismissing it (a button tapped then never fires): tap the title first.
tryAd('keyboard', 'dismiss');
tryAd('press', 'label="Capability lab"');
await sleep(800);

// ── each spike: tap, then wait for its rows ──
const timeoutMs = Number(opt('--timeout') ?? 45 * 60) * 1000;
for (const spec of spikes) {
  const [label, count] = spec.split('#');
  const expected = Number(count) || 0;
  const before = sessionRows().length;
  await press(label);
  mark(`Run ${label}`);
  const started = Date.now();
  let seen = before;
  let idleSince = Date.now();
  let retried = false;
  for (;;) {
    await sleep(3000);
    const rows = sessionRows();
    for (const row of rows.slice(seen)) {
      const m = row.metrics ?? {};
      const headline = ['exportSeconds', 'xRealtime', 'msPerFrame', 'msPerFrameP95', 'fpsSustained', 'visualDiff', 'readySeconds', 'readyRealtimeFactor', 'lufsOut', 'truePeakPreEncode']
        .filter((k) => m[k] != null).map((k) => `${k} ${m[k]}`).join(', ');
      mark(`${row.spike} ${row.variant} #${row.run}: ${row.status}`, row.status === 'ok' ? 'check' : 'issue',
        [headline, `mem ${row.memPeakMB} MB`, row.note].filter(Boolean).join(' · '));
      idleSince = Date.now();
    }
    seen = rows.length;
    const screen = tryAd('snapshot') ?? '';
    // The busy line ("S4 writer-60s-1080 run 2/3 41%") is gone once the button's last run ends.
    const busy = /run \d\/\d/.test(screen);
    if (expected ? seen - before >= expected : seen > before && !busy && Date.now() - idleSince > 4000) break;
    // Nothing started (the tap was swallowed): tap once more.
    if (seen === before && !busy && !retried && Date.now() - started > 15000) { retried = true; await press(label); mark(`Run ${label} (tapped again)`); }
    if (rows.slice(before).some((r) => r.status === 'refused')) break;
    if (Date.now() - started > timeoutMs) { mark(`${label} still running after ${timeoutMs / 60000} min`, 'issue'); break; }
  }
}
if (record) tryAd('record', 'stop');
tryAd('close');

// ── judge ──
const rows = sessionRows();
writeFileSync(join(out, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const judged = JSON.parse(execFileSync('npx', ['tsx', '-e', `
  import { readFileSync } from 'node:fs';
  import { evaluate, parseRows } from './src/lab/evaluate.ts';
  console.log(JSON.stringify(evaluate(parseRows(readFileSync(${JSON.stringify(join(out, 'results.jsonl'))}, 'utf8')))));
`], { cwd: mobile, encoding: 'utf8' }));
writeFileSync(join(out, 'verdicts.json'), JSON.stringify(judged, null, 2));

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : v == null ? '-' : String(v));
const median = (values) => { const s = values.filter((v) => typeof v === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
// Context metrics shown beside the gate, per spike (medians over the ok runs).
const CONTEXT = {
  S1: ['fpsSustained', 'fpsWorst1s', 'framesMissed', 'msPerFrame', 'msPerFrameP95', 'seconds'],
  S4: ['xRealtime', 'width', 'color', 'codec', 'profile', 'transfer', 'compositorMsP50', 'compositorMsP95', 'measureSeconds', 'writeSeconds', 'videoMbps', 'lufsIn', 'lufsOut', 'truePeakPreEncode', 'gainDb'],
  S5: ['msPerFrameP95', 'msPerFrameMax', 'fpsSustained', 'framesMissed', 'droppedFrames', 'visualDiff', 'applyMs'],
  S11: ['readySeconds', 'readyRealtimeFactor'],
};
const okRows = (g) => rows.filter((r) => r.status === 'ok' && r.spike === g.spike && r.variant === g.variant);
const tableRows = judged.map((g) => {
  const gate = g.metrics.map((m) => `<span class="${m.medianPass ? (m.worstPass ? 'ok' : 'warn') : 'bad'}">${esc(m.metric)} ${esc(fmt(m.median))} / ${esc(fmt(m.worst))} (${esc(m.op)} ${esc(fmt(m.target))})</span>`).join('<br>');
  const ctx = (CONTEXT[g.spike] ?? []).map((k) => {
    const values = okRows(g).map((r) => r.metrics?.[k]).filter((v) => v != null);
    if (!values.length) return null;
    const v = typeof values[0] === 'number' ? median(values) : values[0];
    return `${esc(k)} ${esc(fmt(v))}`;
  }).filter(Boolean).join(' · ');
  const thermal = okRows(g).map((r) => `${r.thermalStart}→${r.thermalEnd}`).join(', ');
  const failed = rows.filter((r) => r.spike === g.spike && r.variant === g.variant && r.status !== 'ok').map((r) => `#${r.run} ${r.status}: ${r.note ?? ''}`);
  return `<tr><td>${esc(g.spike)}</td><td>${esc(g.variant)}</td><td>${g.runs}</td><td class="${g.verdict === 'go' ? 'ok' : g.verdict === 'borderline' ? 'warn' : 'bad'}">${esc(g.verdict)}</td><td>${gate || '-'}</td><td>${ctx || '-'}<br><span class="muted">thermal ${esc(thermal || '-')}</span></td><td>${esc([...g.problems, ...failed].join('; ') || '-')}</td></tr>`;
}).join('');
let frames = '';
const s5 = rows.filter((r) => r.spike === 'S5' && r.status === 'ok' && Array.isArray(r.metrics?.visualFiles)).at(-1);
if (s5) {
  const imgs = s5.metrics.visualFiles.map((name) => {
    const file = labFile(name);
    if (!file) return '';
    const small = join(out, `small-${name}`);
    execFileSync('sips', ['-Z', '640', file, '--out', small], { stdio: 'ignore' });
    return `<figure style="margin:0"><img src="data:image/jpeg;base64,${readFileSync(small).toString('base64')}" style="height:420px;border-radius:6px"><figcaption class="muted">${esc(name.includes('preview') ? 'Preview (PlanPlayer)' : 'Export path (PlanBuilder + reader)')}, frame ${esc(s5.metrics.matchFrame)}</figcaption></figure>`;
  }).join('');
  frames = `<h3 style="font-size:15px">S5 visual match, run ${s5.run}: mean abs diff ${esc(fmt(s5.metrics.visualDiff))} of 255 (tolerance ${esc(fmt(s5.metrics.visualTolerance))}), worst channel ${esc(fmt(s5.metrics.visualDiffMaxChannel))}</h3><div style="display:flex;gap:16px;flex-wrap:wrap">${imgs}</div>`;
}
const device = rows[0] ? `${rows[0].device}, iOS ${rows[0].ios}, ${rows[0].config}` : '-';
const html = `<section id="lab" style="padding:16px;max-width:1200px">
<style>#lab td,#lab th{border-bottom:1px solid var(--border);padding:6px 8px;vertical-align:top;text-align:left}#lab .ok{color:#3fb950}#lab .warn{color:#d29922}#lab .bad{color:#f85149}</style>
<h2 style="font-size:16px">Lab results: median / worst of ${rows.length ? 3 : 0} runs (${esc(device)})</h2>
${opt('--note') ? `<p class="muted">${esc(opt('--note'))}</p>` : ''}
<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr><th>Spike</th><th>Variant</th><th>Runs</th><th>Verdict</th><th>Gate: median / worst (target)</th><th>Context (medians)</th><th>Problems</th></tr></thead><tbody>${tableRows}</tbody></table>
${frames}
</section>`;
writeFileSync(join(out, 'results.html'), html);
console.log(`\nrows: ${join(out, 'results.jsonl')}\nverdicts: ${judged.map((g) => `${g.spike}/${g.variant}=${g.verdict}`).join(', ')}`);

if (record && args.includes('--review')) {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const page = execFileSync('node', [join(S, 'build-review.mjs'), '--video', video, '--moments', join(out, 'moments.json'), '--slug', opt('--slug') ?? 'lab',
    '--meta', `commit=${commit}`, '--meta', `device=${device}`, ...(opt('--summary') ? ['--summary', opt('--summary')] : []), '--section', join(out, 'results.html')], { encoding: 'utf8' }).trim();
  console.log(execFileSync(join(S, 'serve-tailnet.sh'), [dirname(page)], { encoding: 'utf8' }).trim());
}
console.log(`run dir: ${out}`);
