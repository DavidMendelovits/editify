// HTML for the "Profile" section of a review page (from profile.mjs output) and
// the home-card chips. Plain strings + CSS vars from build-review's BASE_CSS; no
// external libraries, so the page stays one static file.

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 7.3s / 2m 04s */
export function dur(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return 'n/a';
  if (seconds < 9.95) return `${seconds.toFixed(1)}s`;
  // Round once, then split: 119.6 is 2m 00s, never 1m 60s.
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}
const ms = (value) => (value == null ? 'n/a' : value < 1000 ? `${Math.round(value)} ms` : dur(value / 1000));
const pct = (part, whole) => (whole > 0 ? (100 * part) / whole : 0);
const shortId = (id) => (id ? String(id).slice(0, 8) : '');

export const PROFILE_CSS = `
:root{--human:var(--step);--wait:#e0a43a;--render:#3fb8c4;--overhead:#5d5d66;--job:#a48bf0;--http:#7a7a84}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--wait:#b7791f;--render:#1f8790;--overhead:#a5a5ad;--job:#6d4fc2;--http:#8a8a93}}
.profile{padding:16px;border-top:1px solid var(--border);max-width:1180px;margin:0 auto}
.profile h2{font-size:17px;margin:0 0 4px}.profile h3{font-size:13px;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.profile .notes{margin:6px 0 0;padding:8px 10px;border:1px dashed var(--border);border-radius:6px;color:var(--muted);font-size:13px}
.callouts{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:12px}
.callout{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
.callout .big{font:600 22px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.callout .sub{color:var(--muted);font-size:12px;margin-top:2px}
.bars{display:grid;grid-template-columns:96px 1fr;gap:6px 10px;align-items:center}
.stack{display:flex;height:22px;border-radius:5px;overflow:hidden;background:var(--raised)}
.stack span{display:block;height:100%;min-width:1px}
.seg-human{background:var(--human)}.seg-wait{background:var(--wait)}.seg-render{background:var(--render)}.seg-overhead{background:var(--overhead)}.seg-job{background:var(--job)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.gantt{display:grid;grid-template-columns:96px 1fr;gap:4px 10px;align-items:center;font-size:12px}
.gantt .lane{position:relative;height:18px;background:var(--raised);border-radius:4px}
.gantt .lane b{position:absolute;top:2px;bottom:2px;border-radius:3px;min-width:2px}
.gantt .lane b.queue{background:repeating-linear-gradient(45deg,var(--job) 0 3px,transparent 3px 6px);opacity:.55}
.gantt .lane b.job{background:var(--job)}.gantt .lane b.fail{background:var(--issue)}
.gantt .lane b.human{background:var(--human)}.gantt .lane b.wait{background:var(--wait)}.gantt .lane b.render{background:var(--render)}
.flag{font-size:11px;font-weight:600;color:var(--wait);margin-left:6px}
.gantt .lane b.http{background:var(--http);opacity:.8}.gantt .lane b.tick{width:1px;min-width:1px;opacity:.6}
.gantt .name{color:var(--muted);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gantt .axis{position:relative;height:14px;color:var(--muted);font-size:11px}
.gantt .axis span{position:absolute;transform:translateX(-50%)}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:var(--panel)}
.profile table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
.profile th,.profile td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
.profile th{color:var(--muted);font-weight:600;font-size:12px}
.profile td.n,.profile th.n{text-align:right}
.profile tr.sub td{color:var(--muted);font-size:12px;padding-top:3px;padding-bottom:3px;border-bottom:0}
.profile tr.sub td:first-child{padding-left:26px}
.profile tr.last td{border-bottom:1px solid var(--border)}
.profile code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
@media (max-width:600px){.bars,.gantt{grid-template-columns:64px 1fr}.callouts{grid-template-columns:repeat(2,minmax(0,1fr))}.callout .big{font-size:19px}.gantt .axis span:nth-child(even){display:none}}`;

/** Every export of the run (older profiles have only `render`). */
const rendersOf = (p) => (Array.isArray(p.renders) && p.renders.length ? p.renders : p.render ? [p.render] : []);
const pathName = (r) => (r.path === 'device' ? 'Device render' : 'Server render');

function renderCard(r, named, baseline) {
  const label = named ? pathName(r) : 'Render speed';
  if (r.status !== 'done') {
    return [named ? pathName(r) : 'Render', r.status === 'error' || r.status === 'failed' ? 'failed' : r.status, [r.resolution, r.seconds != null ? `after ${dur(r.seconds)}` : null, r.error, r.note].filter(Boolean).join(' · ')];
  }
  const speed = r.xRealtime != null ? `${r.xRealtime.toFixed(2)}x realtime` : dur(r.serverSeconds ?? r.seconds);
  if (r.path === 'device') {
    const shown = r.shown ?? {};
    const vs = baseline?.xRealtime && r.xRealtime ? `${(r.xRealtime / baseline.xRealtime).toFixed(1)}x the server's ${baseline.xRealtime.toFixed(2)}x` : null;
    const sub = [r.resolution, `tap to done ${dur(r.seconds)}`, r.outputSeconds != null ? `${dur(r.outputSeconds)} of output` : null,
      shown.xRealtime != null ? `app shows ${shown.xRealtime.toFixed(1)}x` : null, vs].filter(Boolean).join(' · ');
    return [label, speed, sub];
  }
  const basis = r.speedBasis === 'server' ? `server encode ${dur(r.serverSeconds)}` : r.speedBasis === 'wall' ? `wall clock ${dur(r.seconds)}` : null;
  const sub = [r.resolution, r.secondsPerOutputMinute != null ? `${dur(r.secondsPerOutputMinute)} per output minute` : null,
    r.outputSeconds != null ? `${dur(r.outputSeconds)} of output` : null, basis,
    r.speedBasis === 'server' && r.seconds != null ? `waited ${dur(r.seconds)}` : null,
    r.queueMs ? `queued ${ms(r.queueMs)}` : null, r.note].filter(Boolean).join(' · ');
  return [label, speed, sub];
}

/** Device vs server render speed (this run, and the server baseline from an earlier run). */
function renderTable(p) {
  const renders = rendersOf(p);
  if (!renders.some((r) => r.path === 'device') && !p.baseline) return '';
  const x = (value) => (value == null ? 'n/a' : `${value.toFixed(2)}x`);
  const rows = renders.map((r) => {
    const shown = r.shown ?? {};
    const audio = r.path !== 'device' ? '' : [shown.silent ? 'silent' : shown.lufs != null ? `${shown.lufs.toFixed(1)} LUFS` : null,
      shown.truePeakPreEncode != null ? `${shown.truePeakPreEncode.toFixed(1)} dBTP pre-encode` : null].filter(Boolean).join(' · ');
    const memory = r.path === 'device' ? (shown.peakMemMB != null ? `${shown.peakMemMB} MB` : 'not shown') : '';
    const took = r.path === 'device' ? `${dur(r.seconds)} tap to done` : r.speedBasis === 'server' ? `${dur(r.serverSeconds)} encode (waited ${dur(r.seconds)})` : dur(r.seconds);
    return `<tr><td><b>${esc(pathName(r))}</b> <span class="muted">this run</span></td><td>${esc(r.resolution ?? '')}</td><td>${r.status === 'done' ? '' : `<span class="kind issue">${esc(r.status)}</span>`}</td><td class="n"><b>${esc(x(r.xRealtime))}</b></td><td class="n">${esc(took)}</td><td class="n">${r.secondsPerOutputMinute != null ? esc(dur(r.secondsPerOutputMinute)) : 'n/a'}</td><td>${esc(audio)}</td><td class="n">${esc(memory)}</td></tr>`;
  });
  if (p.baseline) {
    const b = p.baseline;
    rows.push(`<tr><td><b>${esc(b.path === 'device' ? 'Device render' : 'Server render')}</b> <span class="muted">earlier run${b.source ? ` (${esc(b.source)})` : ''}</span></td><td>${esc(b.resolution ?? '')}</td><td></td><td class="n"><b>${esc(x(b.xRealtime))}</b></td><td class="n">n/a</td><td class="n">${b.xRealtime ? esc(dur(60 / b.xRealtime)) : 'n/a'}</td><td></td><td></td></tr>`);
  }
  const states = renders.find((r) => r.path === 'device' && r.states?.length)?.states ?? [];
  const stateLine = states.length ? `<p class="muted" style="font-size:12px">Device card states (seconds after the tap): ${states.map((s) => `${esc(s.state)} ${esc(dur(s.at))}`).join(' → ')}</p>` : '';
  return `<h3>Render speed</h3><div class="tablewrap"><table><tr><th>Path</th><th>Resolution</th><th>Status</th><th class="n">x realtime</th><th class="n">Took</th><th class="n">Per output minute</th><th>Audio (shown)</th><th class="n">Peak memory</th></tr>${rows.join('')}</table></div>
<p class="muted" style="font-size:12px">Device speed is the replay's clock from the export tap to the card's done state (preparing clips, the loudness pass, writing, saving). Server speed is the server's own encode time when its job is logged.</p>${stateLine}`;
}

function callouts(p) {
  const t = p.totals;
  const cards = [];
  const exported = t.exportPersonSeconds > 0 ? ` · export ${dur(t.exportPersonSeconds)} not included` : '';
  cards.push(['Person time', `~${dur(t.personSeconds)}`, `${dur(t.humanEstimateSeconds)} acting + ${dur(t.productWaitSeconds)} waiting${exported}`]);
  const serverLine = p.hasMediaJobs
    ? `server busy ${dur(t.serverBusySeconds)}`
    : t.requestBusySeconds != null ? `requests in flight ${dur(t.requestBusySeconds)}; background work not logged` : 'no server log';
  cards.push(['Product waits', dur(t.productWaitSeconds), serverLine]);
  for (const r of rendersOf(p)) cards.push(renderCard(r, rendersOf(p).length > 1 || r.path === 'device', p.baseline));
  if (p.agent) {
    const a = p.agent;
    const sub = a.toolCalls != null
      ? `${a.toolCalls} tool call${a.toolCalls === 1 ? '' : 's'}${a.failedToolCalls ? ` (${a.failedToolCalls} failed)` : ''} · ${a.thoughts} thought${a.thoughts === 1 ? '' : 's'} · ${a.ops} op${a.ops === 1 ? '' : 's'}`
      : 'no chat trace';
    cards.push(['Agent turn', dur(a.seconds ?? (a.serverMs != null ? a.serverMs / 1000 : null)), `${sub}${a.serverMs != null ? ` · server ${ms(a.serverMs)}` : ''}`]);
  }
  const harness = p.requests?.harness?.total ? ` · ${p.requests.harness.total} replay calls left out` : '';
  if (p.requests?.total || harness) cards.push(['App requests', String(p.requests.total), `${p.requests.pollingDuringWaits} while the person waited${harness}`]);
  return `<div class="callouts">${cards.map(([label, big, sub]) => `<div class="callout"><div class="muted">${esc(label)}</div><div class="big">${esc(big)}</div><div class="sub">${esc(sub)}</div></div>`).join('')}</div>`;
}

function stackedBars(p) {
  const t = p.totals;
  const person = [['human', t.humanEstimateSeconds, 'acting (estimate)'], ['wait', t.productWaitSeconds, 'product waits']];
  const replay = [['human', t.automationSeconds, 'driving the UI'], ['wait', t.productWaitSeconds, 'product waits'], ['render', t.renderWaitSeconds ?? 0, 'render wait (export, not in person time)'], ['overhead', t.automationOverheadSeconds, 'automation overhead (setup, glue)']];
  const scale = Math.max(t.personSeconds ?? 0, t.runSeconds ?? 0, 1);
  const bar = (parts) => `<div class="stack">${parts.map(([kind, s, label]) => (s > 0 ? `<span class="seg-${kind}" style="width:${pct(s, scale).toFixed(2)}%" title="${esc(`${label}: ${dur(s)}`)}"></span>` : '')).join('')}</div>`;
  const rows = [['A person', person, t.personSeconds], ['This replay', replay, t.runSeconds]];
  return `<div class="bars">${rows.map(([name, parts, total]) => `<div class="muted">${esc(name)}<br><b style="color:var(--text)">${esc(dur(total))}</b></div>${bar(parts)}`).join('')}</div>
<div class="legend"><span><i class="seg-human"></i>person acting (estimate) / UI driven by the replay</span><span><i class="seg-wait"></i>product waits</span>${t.renderWaitSeconds > 0 ? '<span><i class="seg-render"></i>render wait (export, not in person time)</span>' : ''}<span><i class="seg-overhead"></i>automation overhead</span></div>`;
}

function timeline(p) {
  const end = Math.max(p.totals.runSeconds ?? 0, ...p.steps.map((s) => s.end), ...p.jobs.map((j) => j.end), 1);
  const at = (s) => pct(Math.max(0, s), end).toFixed(2);
  const width = (a, b) => Math.max(0.15, pct(Math.max(0, b) - Math.max(0, a), end)).toFixed(2);
  const block = (cls, a, b, title) => `<b class="${cls}" style="left:${at(a)}%;width:${width(a, b)}%" title="${esc(title)}"></b>`;
  const rows = [];
  rows.push(['Person', p.steps.map((s) => block(s.kind === 'wait' ? (s.export || s.compare ? 'render' : 'wait') : 'human', s.start, s.end,
    `${s.name}: ${dur(s.seconds)}${s.kind === 'human' && s.humanSeconds != null ? ` (a person ~${dur(s.humanSeconds)})` : ''}`)).join('')]);
  const byJob = new Map();
  for (const j of p.jobs) { if (!byJob.has(j.job)) byJob.set(j.job, []); byJob.get(j.job).push(j); }
  for (const [name, list] of byJob) {
    rows.push([name, list.map((j) => (j.waitMs > 0 ? block('queue', j.queuedAt, j.start, `${name} queued ${ms(j.waitMs)}`) : '')
      + block(j.ok ? 'job' : 'fail', j.start, j.end, `${name}${j.assetId ? ` ${shortId(j.assetId)}` : ''}: ${ms(j.ms)}${j.ok ? '' : ' (failed)'}`)).join('')]);
  }
  if (p.requests?.timeline?.length) {
    rows.push(['HTTP', p.requests.timeline.map((r) => (r.end - r.start >= end / 400
      ? block('http', r.start, r.end, `${r.method} ${r.route}: ${ms(r.ms)}`)
      : `<b class="http tick" style="left:${at(r.start)}%" title="${esc(`${r.method} ${r.route}: ${ms(r.ms)}`)}"></b>`)).join('')]);
  }
  const step = [5, 10, 15, 30, 60, 120, 300, 600].find((s) => end / s <= 8) ?? 1200;
  const ticks = [];
  for (let s = 0; s <= end; s += step) ticks.push(`<span style="left:${at(s)}%">${esc(dur(s))}</span>`);
  return `<div class="gantt">${rows.map(([name, html]) => `<div class="name" title="${esc(name)}">${esc(name)}</div><div class="lane">${html}</div>`).join('')}
<div></div><div class="axis">${ticks.join('')}</div></div>
<div class="legend"><span><i class="seg-human"></i>person step</span><span><i class="seg-wait"></i>person waits</span><span><i class="seg-render"></i>render wait</span>${p.jobs.length ? '<span><i class="seg-job"></i>server job</span><span><i style="background:repeating-linear-gradient(45deg,var(--job) 0 3px,transparent 3px 6px)"></i>queued for a media slot</span>' : ''}<span><i style="background:var(--http)"></i>HTTP request</span></div>`;
}

function waitsTable(p) {
  const waits = p.steps.filter((s) => s.kind === 'wait');
  if (!waits.length) return '<p class="muted">No user waits in this run.</p>';
  const head = p.hasMediaJobs
    ? '<tr><th>Wait</th><th class="n">Took</th><th class="n">Server busy</th><th class="n">Queued</th><th class="n">Idle</th><th class="n">Requests</th></tr>'
    : '<tr><th>Wait</th><th class="n">Took</th><th class="n">Requests in flight</th><th class="n">Requests</th><th>Most polled</th></tr>';
  const body = waits.map((s) => {
    const label = `<b>${esc(s.name)}</b>${s.export ? '<span class="muted"> (export)</span>' : s.compare ? '<span class="muted"> (comparison, not in any total)</span>' : ''}`
      + (s.uncovered ? '<span class="flag" title="No request was in flight for most of this wait; the server does not log its background jobs">background work not logged</span>' : '');
    const top = Object.entries(s.requests?.byRoute ?? {}).sort((a, b) => b[1] - a[1])[0];
    const subs = (s.jobs ?? []).map((j) => `<tr class="sub"><td>${esc(j.job)}${j.assetId ? ` <code>${esc(shortId(j.assetId))}</code>` : ''}${j.ok ? '' : ' <span class="kind issue">failed</span>'}</td><td class="n">${esc(ms(j.ms))}</td><td class="n">${esc(dur(j.overlapSeconds))} in this wait</td><td class="n">${j.waitMs ? esc(ms(j.waitMs)) : ''}</td><td></td><td></td></tr>`);
    const main = p.hasMediaJobs
      ? `<tr${subs.length ? '' : ' class="last"'}><td>${label}</td><td class="n">${esc(dur(s.seconds))}</td><td class="n">${esc(dur(s.serverBusySeconds))}</td><td class="n">${esc(dur(s.queueSeconds))}</td><td class="n">${esc(dur(s.idleSeconds))}</td><td class="n">${s.requests?.count ?? 0}</td></tr>`
      : `<tr class="last"><td>${label}</td><td class="n">${esc(dur(s.seconds))}</td><td class="n">${s.requestBusySeconds != null ? esc(dur(s.requestBusySeconds)) : 'n/a'}</td><td class="n">${s.requests?.count ?? 0}</td><td>${top ? `<code>${esc(top[0])}</code> x${top[1]}` : ''}</td></tr>`;
    if (subs.length) subs[subs.length - 1] = subs.at(-1).replace('<tr class="sub">', '<tr class="sub last">');
    return main + subs.join('');
  }).join('');
  return `<div class="tablewrap"><table>${head}${body}</table></div>`;
}

function requestsTable(p) {
  const routes = p.requests?.routes ?? [];
  if (!routes.length) return '<p class="muted">No app request lines in the server log.</p>';
  const rows = routes.slice(0, 14).map((r) => `<tr><td><code>${esc(r.method)} ${esc(r.route)}</code></td><td class="n">${r.count}</td><td class="n">${esc(ms(r.p50Ms))}</td><td class="n">${esc(ms(r.p95Ms))}</td><td class="n">${esc(ms(r.maxMs))}</td><td class="n">${r.errors ? `<span class="kind issue">${r.errors}</span>` : '0'}</td></tr>`).join('');
  return `<div class="tablewrap"><table><tr><th>Route</th><th class="n">Count</th><th class="n">p50</th><th class="n">p95</th><th class="n">Max</th><th class="n">Errors</th></tr>${rows}</table></div>
<p class="muted" style="font-size:12px">${p.requests.total} app requests, ${p.requests.pollingDuringWaits} of them while the person waited (polling).${p.requests.harness?.total ? ` ${p.requests.harness.total} calls from the replay itself (via=replay) are left out.` : ''}${routes.length > 14 ? ` ${routes.length - 14} more routes in profile.json.` : ''}</p>`;
}

/** The whole Profile section, or '' without a profile. */
export function profileSection(p) {
  if (!p?.totals) return '';
  const notes = p.notes?.length ? `<div class="notes">${p.notes.map(esc).join('<br>')}</div>` : '';
  return `<section class="profile" id="profile"><h2>Profile</h2>
<div class="muted">Where this run's time went: a person's time is human estimates plus product waits; server work comes from the server log.</div>${notes}
${callouts(p)}
${renderTable(p)}
<h3>Where the time went</h3>${stackedBars(p)}
<h3>Timeline</h3>${timeline(p)}
<h3>User waits</h3>${waitsTable(p)}
<h3>Requests</h3>${requestsTable(p)}
</section>`;
}

/** Chips for a home-page card. */
export function profileChips(p) {
  if (!p?.totals) return '';
  const chips = [`<span class="chip" title="person time">person ~${esc(dur(p.totals.personSeconds))}</span>`];
  const renders = rendersOf(p);
  const named = renders.length > 1 || renders.some((r) => r.path === 'device');
  for (const r of renders) {
    if (r.xRealtime == null) continue;
    const name = named ? (r.path === 'device' ? 'device' : 'server') : 'render';
    chips.push(`<span class="chip" title="${esc(named ? pathName(r) : 'render speed')}">${name} ${esc(r.xRealtime.toFixed(1))}x</span>`);
  }
  return chips.join('');
}
