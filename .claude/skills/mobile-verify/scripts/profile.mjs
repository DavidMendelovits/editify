#!/usr/bin/env node
// Merges a replay's timings.json with the server's pino log (and optionally the
// project's chat) into profile.json: where a run's time went, which server
// processes ran during each user wait, request/polling stats, render speed and
// the agent turn. Pure Node, no dependencies.
//
//   node profile.mjs --timings timings.json [--log server.log] [--chat chat.json] [--out profile.json]
//
// Inputs
//   timings.json  steps[] {name, kind: human|wait, start, seconds, humanSeconds?, note?, tag?}
//                 (tag export|render = the export phase, reported apart from person time)
//                 + totals, startedAtMs (run clock epoch), server.startedAtMs, render?
//   server.log    pino JSON lines. `{"msg":"media job", job, ms, waitMs, ok, time}` when a
//                 background media job finishes (`ms` = the job's own run time, `waitMs` =
//                 time queued for a media slot before it); Fastify request lines
//                 `{reqId, req:{method,url}}` / `{reqId, res:{statusCode}, responseTime}`;
//                 urls with `via=replay` are the replay's own calls (harness, not app).
//   chat.json     GET /projects/:id/chat (messages with trace[] / ops[])
//
// Every time in profile.json is seconds on the run clock (0 = replay start) unless
// the field name says ms.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const round = (value, digits = 2) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);

/** Parses pino JSON lines; anything else (stack traces, tsx noise) is skipped. */
export function parseLog(text = '') {
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try { lines.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return lines;
}

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[A-Za-z0-9_-]{16,})$/i;
/** `/projects/3f2c.../chat?x=1` -> `/projects/:id/chat`. */
export function routePattern(url = '') {
  const path = String(url).split('?')[0];
  return path.split('/').map((part) => (part && ID_SEGMENT.test(part) && /\d/.test(part) ? ':id' : part)).join('/') || '/';
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Total length of the union of [start, end] intervals, optionally clipped to a window. */
function unionSeconds(intervals, from = -Infinity, to = Infinity) {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0; let curStart = null; let curEnd = null;
  for (const [a, b] of clipped) {
    if (curEnd === null || a > curEnd) { if (curEnd !== null) total += curEnd - curStart; curStart = a; curEnd = b; }
    else curEnd = Math.max(curEnd, b);
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
/** The replay tags its own API calls so they never count as the app's polling. */
export const HARNESS_QUERY = /[?&]via=replay(?:&|$)/;
/** Export steps (the tap and the render wait) sit outside the comparable person time. */
const EXPORT_TAGS = new Set(['export', 'render']);
const isExport = (step) => EXPORT_TAGS.has(step.tag);
/** A second export run only to compare paths (the server render after a device one): in neither total. */
const isCompare = (step) => step.tag === 'compare';

/** A server render: the replay's wall clock, and the server's own encode time when its job is logged. */
function serverRender(r, renderJobs, str) {
  const job = (r?.id ? renderJobs.find((j) => j.renderId === r.id) : undefined) ?? renderJobs.at(-1) ?? null;
  let status = r?.status ?? (job ? (job.ok ? 'done' : 'error') : 'unknown');
  if (job && !job.ok) status = 'error';
  const output = r?.projectSeconds ?? r?.outputSeconds ?? null;
  const wallSeconds = Number.isFinite(r?.seconds) ? r.seconds : null;
  // The server's own encode time is the cleaner speed; wall clock adds polling and queueing.
  const serverSeconds = job?.ok ? job.ms / 1000 : null;
  const basisSeconds = serverSeconds ?? wallSeconds;
  const fast = status === 'done' && output > 0 && basisSeconds > 0;
  return {
    path: 'server', id: r?.id ?? job?.renderId ?? null, resolution: r?.resolution ?? null, status, ...(r?.error ? { error: str(r.error, 300) } : {}),
    ...(r?.note ? { note: str(r.note, 300) } : {}),
    seconds: round(wallSeconds), serverSeconds: round(serverSeconds), queueMs: job ? job.waitMs : null, outputSeconds: round(output),
    speedBasis: fast ? (serverSeconds != null ? 'server' : 'wall') : null,
    xRealtime: fast ? round(output / basisSeconds) : null,
    secondsPerOutputMinute: fast ? round(basisSeconds / (output / 60), 1) : null,
    wallXRealtime: status === 'done' && output > 0 && wallSeconds > 0 ? round(output / wallSeconds) : null,
  };
}

/**
 * An on-device render: timed from the export tap to the card's done state (it covers
 * preparing clips, the loudness pass, writing and saving), plus what the card showed
 * (the app's own x realtime, LUFS, true peak) and the state changes seen while polling.
 */
function deviceRender(r) {
  const str = (value, max = 120) => String(value).slice(0, max);
  const num = (value) => (Number.isFinite(value) ? value : null);
  const output = num(r.projectSeconds ?? r.outputSeconds);
  const wallSeconds = num(r.seconds);
  const done = r.status === 'done' && output > 0 && wallSeconds > 0;
  const shown = r.shown ?? {};
  return {
    path: 'device', id: r.id ? str(r.id) : null, resolution: r.resolution ? str(r.resolution, 16) : null, status: str(r.status ?? 'unknown', 16),
    ...(r.error ? { error: str(r.error, 300) } : {}),
    seconds: round(wallSeconds), serverSeconds: null, queueMs: null, outputSeconds: round(output),
    speedBasis: done ? 'wall' : null,
    xRealtime: done ? round(output / wallSeconds) : null,
    secondsPerOutputMinute: done ? round(wallSeconds / (output / 60), 1) : null,
    wallXRealtime: done ? round(output / wallSeconds) : null,
    shown: {
      xRealtime: round(num(shown.xRealtime)), lufs: round(num(shown.lufs), 1), silent: shown.silent === true,
      truePeakPreEncode: round(num(shown.truePeakPreEncode), 1), peakMemMB: round(num(shown.peakMemMB), 0), label: shown.label ? str(shown.label, 60) : null,
    },
    states: (Array.isArray(r.states) ? r.states : []).slice(0, 200).map((s) => ({ state: str(s?.state, 40), at: round(num(s?.at)) })),
  };
}

/**
 * @param {{ timings: object, logText?: string, chat?: Array<object> }} input
 * @returns profile object (see SKILL.md for the shape)
 */
export function buildProfile({ timings, logText = '', chat = null }) {
  const notes = [];
  const steps = (timings.steps ?? []).map((s) => ({ ...s, end: s.start + s.seconds }));
  const runSeconds = timings.totals?.runSeconds ?? Math.max(0, ...steps.map((s) => s.end));
  // Run clock epoch: written by the replay; older timings only have `at` (report time ~ t0 + runSeconds).
  const runStartMs = timings.startedAtMs ?? (timings.at ? Date.parse(timings.at) - runSeconds * 1000 : null);
  if (timings.startedAtMs == null) notes.push('timings.json has no startedAtMs; server times are mapped from the report time, so they can be off by a second.');
  const toRun = (epochMs) => (runStartMs == null ? null : (epochMs - runStartMs) / 1000);

  const lines = parseLog(logText);
  const hasLog = lines.length > 0;
  if (!hasLog) notes.push('No server log: only the replay\'s own timings are shown.');

  // ── media jobs ────────────────────────────────────────────────────────────
  // Log values are data: coerce to plain strings/numbers; the page escapes them.
  const str = (value, max = 120) => String(value).slice(0, max);
  const jobLines = lines.filter((l) => l.msg === 'media job' && Number.isFinite(l.ms) && Number.isFinite(l.time));
  const jobs = jobLines
    .map((l) => {
      const end = toRun(l.time);
      const waitMs = Number(l.waitMs) || 0;
      return {
        job: str(l.job ?? 'job', 64), ok: l.ok !== false, ms: l.ms, waitMs,
        ...(l.assetId ? { assetId: str(l.assetId) } : {}), ...(l.projectId ? { projectId: str(l.projectId) } : {}), ...(l.renderId ? { renderId: str(l.renderId) } : {}),
        queuedAt: end == null ? null : round(end - (l.ms + waitMs) / 1000, 3), start: end == null ? null : round(end - l.ms / 1000, 3), end: end == null ? null : round(end, 3),
      };
    })
    .filter((j) => j.end != null)
    .sort((a, b) => a.queuedAt - b.queuedAt);
  if (jobs.length < jobLines.length) notes.push(`${jobLines.length - jobs.length} media job line(s) had no time anchor on the run clock and were left out.`);
  const hasMediaJobs = jobs.length > 0;
  if (hasLog && !hasMediaJobs) notes.push('No "media job" lines in the server log (older server, or no media work ran): server work is inferred from HTTP requests, and background work is not visible.');

  const jobStats = Object.create(null);
  for (const j of jobs) {
    if (!Object.hasOwn(jobStats, j.job)) jobStats[j.job] = { count: 0, failed: 0, totalMs: 0, maxMs: 0, waitMs: 0 };
    const s = jobStats[j.job];
    s.count += 1; s.failed += j.ok ? 0 : 1; s.totalMs += j.ms; s.maxMs = Math.max(s.maxMs, j.ms); s.waitMs += j.waitMs;
  }
  for (const s of Object.values(jobStats)) s.avgMs = Math.round(s.totalMs / s.count);

  // ── requests ──────────────────────────────────────────────────────────────
  // The replay's own API calls carry `via=replay`: they are harness polling, not
  // product polling, so they are counted apart and left out of every app stat.
  const open = new Map();
  const allRequests = [];
  for (const l of lines) {
    if (l.reqId == null) continue;
    if (l.req?.url) open.set(l.reqId, { method: str(l.req.method ?? 'GET', 12), url: str(l.req.url, 2048), startMs: l.time });
    else if (l.res && Number.isFinite(l.responseTime)) {
      const begun = open.get(l.reqId);
      open.delete(l.reqId);
      if (!begun) continue;
      const startMs = Number.isFinite(begun.startMs) ? begun.startMs : l.time - l.responseTime;
      const start = Number.isFinite(startMs) ? toRun(startMs) : null;
      allRequests.push({
        method: begun.method, route: routePattern(begun.url), status: Number(l.res.statusCode) || 0, ms: l.responseTime,
        start, end: start == null ? null : start + l.responseTime / 1000, harness: HARNESS_QUERY.test(begun.url),
      });
    }
  }
  const requests = allRequests.filter((r) => !r.harness);
  const harnessRequests = allRequests.filter((r) => r.harness);
  const timed = (list) => list.filter((r) => r.start != null);
  const byRoute = new Map();
  for (const r of requests) {
    const key = `${r.method} ${r.route}`;
    if (!byRoute.has(key)) byRoute.set(key, { method: r.method, route: r.route, times: [], errors: 0 });
    const entry = byRoute.get(key);
    entry.times.push(r.ms); if (r.status >= 400) entry.errors += 1;
  }
  const routes = [...byRoute.values()].map((e) => {
    const sorted = [...e.times].sort((a, b) => a - b);
    return { method: e.method, route: e.route, count: sorted.length, errors: e.errors,
      p50Ms: round(percentile(sorted, 50), 1), p95Ms: round(percentile(sorted, 95), 1), maxMs: round(sorted.at(-1), 1),
      totalMs: round(sorted.reduce((t, v) => t + v, 0), 1) };
  }).sort((a, b) => b.count - a.count || b.totalMs - a.totalMs);

  // ── per step ──────────────────────────────────────────────────────────────
  const startedIn = (list, s) => timed(list).filter((r) => r.start >= s.start && r.start < s.end);
  const profiledSteps = steps.map((s) => {
    const out = { name: s.name, kind: s.kind, start: round(s.start, 3), end: round(s.end, 3), seconds: round(s.seconds, 3) };
    if (s.humanSeconds != null) out.humanSeconds = s.humanSeconds;
    if (s.note) out.note = s.note;
    if (s.tag) out.tag = s.tag;
    if (isExport(s)) out.export = true;
    if (isCompare(s)) out.compare = true;
    if (s.kind !== 'wait') return out;
    const during = startedIn(requests, s);
    const routeCounts = Object.create(null);
    for (const r of during) { const key = `${r.method} ${r.route}`; routeCounts[key] = (routeCounts[key] ?? 0) + 1; }
    out.requests = {
      count: during.length, byRoute: routeCounts, harness: startedIn(harnessRequests, s).length,
      slowest: [...during].sort((a, b) => b.ms - a.ms).slice(0, 3).map((r) => ({ method: r.method, route: r.route, ms: round(r.ms, 1) })),
    };
    // In flight during the wait, including app requests that began before it (the agent's POST).
    const inFlight = timed(requests).filter((r) => overlap(r.start, r.end, s.start, s.end) > 0).map((r) => [r.start, r.end]);
    if (hasLog) out.requestBusySeconds = round(unionSeconds(inFlight, s.start, s.end), 3);
    if (hasMediaJobs) {
      const overlapping = jobs.filter((j) => overlap(j.queuedAt, j.end, s.start, s.end) > 0);
      out.jobs = overlapping.map((j) => ({ ...j, overlapSeconds: round(overlap(j.queuedAt, j.end, s.start, s.end), 3) }));
      const jobRuns = overlapping.map((j) => [j.start, j.end]);
      out.jobBusySeconds = round(unionSeconds(jobRuns, s.start, s.end), 3);
      out.queueSeconds = round(unionSeconds(overlapping.map((j) => [j.queuedAt, j.start]), s.start, s.end), 3);
      out.serverBusySeconds = round(unionSeconds([...jobRuns, ...inFlight], s.start, s.end), 3);
      // Nothing running, queued or in flight on the server: the wait is client side (poll gaps, UI).
      out.idleSeconds = round(Math.max(0, s.seconds - unionSeconds([...overlapping.map((j) => [j.queuedAt, j.end]), ...inFlight], s.start, s.end)), 3);
    } else if (hasLog) {
      // Without job lines background work is invisible: no busy/idle claim, just how much requests explain.
      out.requestCoverage = s.seconds > 0 ? round(out.requestBusySeconds / s.seconds, 3) : null;
      out.uncovered = out.requestCoverage != null && out.requestCoverage < 0.5;
    }
    return out;
  });
  const waitSteps = profiledSteps.filter((s) => s.kind === 'wait');
  const pollingDuringWaits = waitSteps.reduce((t, s) => t + (s.requests?.count ?? 0), 0);
  const harnessDuringWaits = waitSteps.reduce((t, s) => t + (s.requests?.harness ?? 0), 0);

  // ── renders ───────────────────────────────────────────────────────────────
  // `timings.renders` lists every export of the run: the device path (the phone renders,
  // timed from the tap to the card's done state) and/or the server path (POST /render
  // until done, matched with its media job). Older timings have one server `render`.
  // `profile.render` stays the primary one (the first) for the home card and old pages.
  const renderJobs = jobs.filter((j) => j.job === 'render');
  const inputs = Array.isArray(timings.renders) && timings.renders.length ? timings.renders : timings.render ? [timings.render] : renderJobs.length ? [{}] : [];
  const renders = inputs.map((r) => (r.path === 'device' ? deviceRender(r) : serverRender(r, renderJobs, str)));
  const render = renders[0] ?? null;
  const b = timings.baseline;
  const baseline = b && Number.isFinite(b.xRealtime)
    ? { path: str(b.path ?? 'server', 16), xRealtime: round(b.xRealtime), resolution: b.resolution ? str(b.resolution, 16) : null, source: b.source ? str(b.source, 200) : null }
    : null;

  // ── agent turn ────────────────────────────────────────────────────────────
  let agent = null;
  const agentStep = steps.find((s) => s.tag === 'agent') ?? steps.find((s) => s.kind === 'wait' && /agent/i.test(s.name));
  const chatPosts = requests.filter((q) => q.method === 'POST' && q.route === '/projects/:id/chat');
  const messages = Array.isArray(chat) ? chat : Array.isArray(chat?.messages) ? chat.messages : null;
  const lastReply = messages ? [...messages].reverse().find((m) => m?.role === 'assistant') : null;
  if (agentStep || chatPosts.length || lastReply) {
    agent = { seconds: agentStep ? round(agentStep.seconds) : null, serverMs: chatPosts.length ? round(chatPosts.at(-1).ms, 0) : null };
    if (lastReply) {
      const trace = Array.isArray(lastReply.trace) ? lastReply.trace : [];
      const calls = trace.filter((t) => t?.kind !== 'thought');
      const tools = Object.create(null);
      for (const t of calls) { const name = str(t?.tool ?? 'tool', 64); tools[name] = (tools[name] ?? 0) + 1; }
      agent.toolCalls = calls.length;
      agent.failedToolCalls = calls.filter((t) => t?.ok === false).length;
      agent.thoughts = trace.length - calls.length;
      agent.ops = Array.isArray(lastReply.ops) ? lastReply.ops.length : 0;
      agent.tools = tools;
      const asked = messages[messages.indexOf(lastReply) - 1];
      if (asked?.role === 'user' && asked.createdAt && lastReply.createdAt && agent.serverMs == null) {
        agent.serverMs = Date.parse(lastReply.createdAt) - Date.parse(asked.createdAt);
      }
    } else {
      notes.push('No chat trace: agent tool-call counts are unavailable.');
    }
    if (agentStep) {
      const polls = profiledSteps.find((s) => s.name === agentStep.name)?.requests?.count;
      if (polls != null) agent.pollRequests = polls;
    }
  }

  // ── totals ────────────────────────────────────────────────────────────────
  // Person time covers the editing flow only, so it stays comparable with runs
  // that never exported; the export (tap + render wait) is reported beside it.
  const sum = (kind, field, phase) => steps.filter((s) => s.kind === kind && !isCompare(s) && (phase === undefined || isExport(s) === phase)).reduce((t, s) => t + (s[field] ?? 0), 0);
  const compareSeconds = steps.filter(isCompare).reduce((t, s) => t + (s.seconds ?? 0), 0);
  const productWaitSeconds = sum('wait', 'seconds', false);
  const humanEstimateSeconds = sum('human', 'humanSeconds', false);
  const renderWaitSeconds = sum('wait', 'seconds', true);
  const exportPersonSeconds = sum('human', 'humanSeconds', true) + renderWaitSeconds;
  const automationSeconds = sum('human', 'seconds');
  const requestBusySeconds = timed(requests).length ? unionSeconds(timed(requests).map((q) => [q.start, q.end])) : null;
  const totals = {
    runSeconds: round(runSeconds),
    personSeconds: round(humanEstimateSeconds + productWaitSeconds),
    humanEstimateSeconds: round(humanEstimateSeconds),
    productWaitSeconds: round(productWaitSeconds),
    renderWaitSeconds: round(renderWaitSeconds),
    exportPersonSeconds: round(exportPersonSeconds),
    automationSeconds: round(automationSeconds),
    // Setup and glue outside any step: server start, app launch, marks, sleeps.
    automationOverheadSeconds: round(Math.max(0, runSeconds - productWaitSeconds - renderWaitSeconds - automationSeconds - compareSeconds)),
    // A comparison export (the server render after a device one): in neither person nor export time.
    compareSeconds: round(compareSeconds),
    // Server processes only when the server reports them (media jobs).
    serverBusySeconds: hasMediaJobs ? round(unionSeconds(jobs.map((j) => [j.start, j.end]))) : null,
    requestBusySeconds: round(requestBusySeconds),
    jobSeconds: hasMediaJobs ? round(jobs.reduce((t, j) => t + j.ms, 0) / 1000) : null,
    queueSeconds: hasMediaJobs ? round(jobs.reduce((t, j) => t + j.waitMs, 0) / 1000) : null,
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: timings.mode ?? null,
    commit: timings.commit ?? null,
    source: {
      runStartMs, serverStartedAt: timings.server?.startedAtMs != null && runStartMs != null ? round(toRun(timings.server.startedAtMs), 3) : null,
      logLines: lines.length, mediaJobLines: jobs.length, requestLines: allRequests.length, harnessRequests: harnessRequests.length, chat: Boolean(messages),
    },
    hasMediaJobs,
    notes,
    totals,
    steps: profiledSteps,
    jobs,
    jobStats,
    requests: {
      total: requests.length, pollingDuringWaits, routes,
      harness: { total: harnessRequests.length, duringWaits: harnessDuringWaits },
      // Compact list for the page's timeline row (app requests only).
      timeline: timed(requests).map((r) => ({ method: r.method, route: r.route, status: r.status, start: round(r.start, 3), end: round(r.end, 3), ms: round(r.ms, 1) })),
    },
    render,
    renders,
    baseline,
    agent,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const one = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const timingsPath = one('timings');
  if (!timingsPath) { console.error('usage: profile.mjs --timings timings.json [--log server.log] [--chat chat.json] [--out profile.json]'); process.exit(2); }
  const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };
  const logText = one('log') ? read(one('log')) ?? '' : '';
  const chatText = one('chat') ? read(one('chat')) : undefined;
  const profile = buildProfile({ timings: JSON.parse(readFileSync(timingsPath, 'utf8')), logText, chat: chatText ? JSON.parse(chatText) : null });
  const outPath = one('out');
  if (outPath) { writeFileSync(outPath, JSON.stringify(profile, null, 2)); console.log(outPath); }
  else console.log(JSON.stringify(profile, null, 2));
}
