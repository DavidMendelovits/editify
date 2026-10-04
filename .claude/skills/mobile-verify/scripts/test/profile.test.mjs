// node --test .claude/skills/mobile-verify/scripts/test/*.test.mjs
// Synthetic run (see timings.json): 95s run, 4 human steps, 4 waits (the last
// human + wait pair is the export); the server log has 5 media jobs (probe,
// thumbnail, proxy, transcribe, render), 19 app requests and 15 `via=replay`
// harness requests. server-no-jobs.ndjson is the same log without job lines.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProfile, routePattern } from '../profile.mjs';
import { dur, profileSection, profileChips } from '../profile-view.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, name), 'utf8');
const timings = JSON.parse(fixture('timings.json'));
const chat = JSON.parse(fixture('chat.json'));
const near = (actual, expected, tolerance = 0.02) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const wait = (p, name) => p.steps.find((s) => s.name === name);

test('route patterns collapse ids and drop the query', () => {
  assert.equal(routePattern('/projects/3f2c9a10-1b2c-4d5e-8f90-a1b2c3d4e5f6/chat?k=1'), '/projects/:id/chat');
  assert.equal(routePattern('/assets?projectId=abc'), '/assets');
  assert.equal(routePattern('/renders/42/file.mp4'), '/renders/:id/file.mp4');
  assert.equal(routePattern('/presets'), '/presets');
});

test('merges timings, media jobs, requests and chat', () => {
  const p = buildProfile({ timings, logText: fixture('server.ndjson'), chat });
  assert.equal(p.hasMediaJobs, true);
  assert.deepEqual(p.notes, []);
  assert.equal(p.source.mediaJobLines, 5);
  assert.equal(p.source.requestLines, 34);
  assert.equal(p.source.harnessRequests, 15);
  assert.equal(p.source.serverStartedAt, 1);

  // Person time is the editing flow; the export (3s tap + 30s render wait) sits beside it.
  assert.equal(p.totals.personSeconds, 91);
  assert.equal(p.totals.humanEstimateSeconds, 51);
  assert.equal(p.totals.productWaitSeconds, 40);
  assert.equal(p.totals.renderWaitSeconds, 30);
  assert.equal(p.totals.exportPersonSeconds, 33);
  assert.equal(p.totals.automationSeconds, 15.5);
  assert.equal(p.totals.automationOverheadSeconds, 9.5);
  assert.equal(p.totals.serverBusySeconds, 53.5); // union of job runs
  assert.equal(p.totals.jobSeconds, 54.5); // sum of job ms
  assert.equal(p.totals.queueSeconds, 1.5);

  const upload = wait(p, 'Upload the clip');
  assert.deepEqual(upload.jobs.map((j) => j.job), ['probe']);
  near(upload.serverBusySeconds, 7); // the upload POST is in flight 10.2-17.2
  near(upload.idleSeconds, 1);
  assert.equal(upload.requests.count, 4);
  assert.equal(upload.requests.harness, 3);

  const preview = wait(p, 'Preview playable (server proxy)');
  assert.deepEqual(preview.jobs.map((j) => j.job), ['thumbnail', 'proxy']);
  const proxy = preview.jobs.find((j) => j.job === 'proxy');
  assert.deepEqual([proxy.ms, proxy.waitMs, proxy.queuedAt, proxy.start, proxy.end], [9000, 1000, 18, 19, 28]);
  assert.equal(preview.jobBusySeconds, 10);
  assert.equal(preview.queueSeconds, 1);
  near(preview.idleSeconds, 2);
  assert.equal(preview.requests.count, 6);
  assert.equal(preview.requests.byRoute['GET /assets/:id'], 6);

  const agentWait = wait(p, 'Agent edits the project');
  assert.deepEqual(agentWait.jobs.map((j) => [j.job, j.overlapSeconds]), [['transcribe', 5]]);
  near(agentWait.serverBusySeconds, 18.5); // POST /chat in flight until 58.5
  assert.equal(agentWait.requests.count, 7);

  const renderWait = wait(p, 'Render 1080p');
  assert.equal(renderWait.export, true);
  assert.equal(renderWait.jobBusySeconds, 28);
  assert.equal(renderWait.queueSeconds, 0.5);
  assert.equal(renderWait.requests.count, 0); // only the replay polled /renders
  assert.equal(renderWait.requests.harness, 8);
  assert.equal(renderWait.requestBusySeconds, 0);

  assert.deepEqual(
    { seconds: p.render.seconds, server: p.render.serverSeconds, basis: p.render.speedBasis, out: p.render.outputSeconds, x: p.render.xRealtime, wallX: p.render.wallXRealtime, perMin: p.render.secondsPerOutputMinute, queueMs: p.render.queueMs },
    { seconds: 30, server: 28, basis: 'server', out: 60, x: 2.14, wallX: 2, perMin: 28, queueMs: 500 },
  );
  assert.equal(p.render.averageRenderMs, undefined);
  assert.deepEqual(
    { seconds: p.agent.seconds, serverMs: p.agent.serverMs, toolCalls: p.agent.toolCalls, failed: p.agent.failedToolCalls, thoughts: p.agent.thoughts, ops: p.agent.ops, polls: p.agent.pollRequests },
    { seconds: 20, serverMs: 19000, toolCalls: 3, failed: 1, thoughts: 2, ops: 4, polls: 7 },
  );
  assert.deepEqual({ ...p.agent.tools }, { get_transcript: 1, remove_silences: 2 });
});

test('replay (via=replay) requests stay out of app stats', () => {
  const p = buildProfile({ timings, logText: fixture('server.ndjson'), chat });
  assert.equal(p.requests.total, 19);
  assert.deepEqual(p.requests.harness, { total: 15, duringWaits: 13 });
  assert.equal(p.requests.pollingDuringWaits, 17);
  assert.equal(p.requests.timeline.length, 19);
  assert.ok(!p.requests.routes.some((r) => r.route === '/renders/:id' || r.route === '/presets'));
  const list = p.requests.routes.find((r) => r.method === 'GET' && r.route === '/assets');
  assert.deepEqual([list.count, list.p50Ms, list.p95Ms], [3, 4, 6]); // harness polls (2 ms) excluded
  const assets = p.requests.routes.find((r) => r.route === '/assets/:id');
  assert.deepEqual([assets.count, assets.p50Ms, assets.p95Ms, assets.maxMs], [6, 3, 6, 6]);
  assert.equal(p.requests.routes.find((r) => r.route === '/missing').errors, 1);
  assert.equal(p.agent.pollRequests, 7); // the replay's 2 chat polls are not the app's
  const html = profileSection(p);
  assert.ok(html.includes('15 replay calls left out'));
  assert.ok(!html.includes('<code>GET /renders/:id</code>'));
});

test('no media job lines (older server, or no media work ran): request data only', () => {
  const p = buildProfile({ timings, logText: fixture('server-no-jobs.ndjson') });
  assert.equal(p.hasMediaJobs, false);
  assert.ok(p.notes.some((n) => n.includes('older server, or no media work ran')), p.notes.join('\n'));
  assert.ok(p.notes.some((n) => n.includes('No chat trace')));
  assert.deepEqual(p.jobs, []);
  assert.equal(p.totals.serverBusySeconds, null); // never called "server busy" without job lines
  assert.ok(p.totals.requestBusySeconds > 26);
  assert.equal(p.totals.jobSeconds, null);

  const upload = wait(p, 'Upload the clip');
  assert.equal(upload.jobs, undefined);
  assert.equal(upload.idleSeconds, undefined); // background work is invisible: no idle claim
  near(upload.requestBusySeconds, 7);
  assert.equal(upload.uncovered, false);
  assert.equal(wait(p, 'Preview playable (server proxy)').uncovered, true);
  assert.equal(wait(p, 'Render 1080p').uncovered, true);
  assert.equal(p.requests.pollingDuringWaits, 17);

  assert.equal(p.render.speedBasis, 'wall');
  assert.equal(p.render.xRealtime, 2);
  assert.equal(p.render.serverSeconds, null);
  assert.equal(p.agent.serverMs, 19000);
  assert.equal(p.agent.toolCalls, undefined);

  const html = profileSection(p);
  assert.ok(html.includes('older server, or no media work ran'));
  assert.ok(html.includes('background work not logged'));
  assert.ok(html.includes('Requests in flight'));
  assert.ok(!html.includes('server busy'), 'fallback must not claim server busy time');
});

test('a failed render is reported as failed, never as a speed', () => {
  const failed = { ...timings, render: { id: 'r-x', resolution: '1080p', status: 'error', error: 'ffmpeg exited 1', seconds: 12, projectSeconds: 60 } };
  const p = buildProfile({ timings: failed, logText: fixture('server-no-jobs.ndjson') });
  assert.equal(p.render.status, 'error');
  assert.equal(p.render.xRealtime, null);
  assert.equal(p.render.secondsPerOutputMinute, null);
  const html = profileSection(p);
  assert.ok(html.includes('>failed<'));
  assert.ok(html.includes('ffmpeg exited 1'));
  assert.ok(!html.includes('x realtime'));
  assert.ok(!profileChips(p).includes('render'));

  // The server's job says it failed even though the replay saw "done".
  const log = fixture('server.ndjson').replace(/("job":"render".*?"ok":)true/, '$1false');
  const q = buildProfile({ timings, logText: log });
  assert.equal(q.render.status, 'error');
  assert.equal(q.render.xRealtime, null);

  // The replay could not even start it (server gone): status error, no seconds.
  const r = buildProfile({ timings: { ...timings, render: { status: 'error', error: 'server exited', seconds: null, projectSeconds: 60 } } });
  assert.equal(r.render.status, 'error');
  assert.match(profileSection(r), /server exited/);
});

test('hostile log values are escaped and cannot pollute objects', () => {
  const t = timings.startedAtMs;
  const evil = [
    { time: t + 20000, msg: 'media job', job: '<img src=x onerror=alert(1)>', ms: 1000, waitMs: 0, ok: true, assetId: '"><script>alert(2)</script>' },
    { time: t + 21000, msg: 'media job', job: '__proto__', ms: 1000, waitMs: 0, ok: true },
    { time: t + 19000, reqId: 'e1', req: { method: 'GET', url: '/x/<script>alert(3)</script>' } },
    { time: t + 19001, reqId: 'e1', res: { statusCode: 200 }, responseTime: 1 },
    { time: t + 22000, msg: 'media job', job: 'probe', ms: 5, waitMs: 0 }, // fine
  ].map((l) => JSON.stringify(l)).join('\n');
  const hostileChat = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y', trace: [{ tool: '__proto__', ok: true }, { tool: '<b>x</b>', ok: true }] }];
  const p = buildProfile({ timings, logText: evil, chat: hostileChat });
  assert.equal({}.count, undefined);
  assert.equal(p.jobStats.__proto__.count, 1);
  assert.equal(p.agent.tools.__proto__, 1);
  const html = profileSection(p);
  for (const raw of ['<img src=x', '<script>alert', '"><script>']) assert.ok(!html.includes(raw), `unescaped ${raw}`);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('jobs without a run-clock anchor are dropped with a note', () => {
  const p = buildProfile({ timings: { ...timings, startedAtMs: undefined, at: undefined }, logText: fixture('server.ndjson') });
  assert.equal(p.jobs.length, 0);
  assert.ok(p.notes.some((n) => n.includes('no time anchor')));
});

test('works from timings alone (no server log)', () => {
  const legacy = { ...timings, startedAtMs: undefined, render: undefined };
  const p = buildProfile({ timings: legacy });
  assert.ok(p.notes.some((n) => n.startsWith('No server log')));
  assert.equal(p.requests.total, 0);
  assert.equal(p.render, null);
  assert.equal(p.totals.personSeconds, 91);
  assert.equal(p.source.runStartMs, timings.startedAtMs); // recovered from `at` - runSeconds
  assert.match(profileSection(p), /id="profile"/);
});

test('durations round once: never "1m 60s"', () => {
  assert.equal(dur(119.6), '2m 00s');
  assert.equal(dur(59.6), '1m 00s');
  assert.equal(dur(9.96), '10s');
  assert.equal(dur(7.25), '7.3s');
  assert.equal(dur(125), '2m 05s');
});

test('profile section and home chips render the numbers', () => {
  const p = buildProfile({ timings, logText: fixture('server.ndjson'), chat });
  const html = profileSection(p);
  for (const needle of ['id="profile"', '<h2>Profile</h2>', 'Where the time went', 'Timeline', 'User waits', 'Requests',
    '~1m 31s', 'export 33s not included', '2.14x realtime', 'server encode 28s', '28s per output minute', '3 tool calls (1 failed)',
    'class="gantt"', 'class="stack"', 'seg-render', '>proxy<', 'Upload the clip', '(export)', '<code>GET /assets/:id</code>']) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
  assert.ok(!/\u2014/.test(html), 'no em dashes in page copy');
  assert.equal(profileSection(null), '');
  assert.match(profileChips(p), /person ~1m 31s.*render 2\.1x/);
});

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('build-review renders the Profile section from fixtures', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const work = mkdtempSync(join(tmpdir(), 'review-profile-'));
  const root = join(work, 'reviews');
  const video = join(work, 'flow.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x320:d=3', '-pix_fmt', 'yuv420p', video]);
  const moments = join(work, 'moments.json');
  writeFileSync(moments, JSON.stringify({ title: 'Profile fixture', startedAt: timings.startedAtMs, moments: [{ t: 1, label: 'Picked', kind: 'step' }] }));
  const profilePath = join(work, 'profile.json');
  execFileSync('node', [join(here, '..', 'profile.mjs'), '--timings', join(here, 'timings.json'), '--log', join(here, 'server.ndjson'), '--chat', join(here, 'chat.json'), '--out', profilePath]);
  const build = (...extra) => execFileSync('node', [join(here, '..', 'build-review.mjs'), '--video', video, '--moments', moments, '--root', root, ...extra], { encoding: 'utf8' }).trim();

  const page = build('--profile', profilePath, '--slug', 'with-profile');
  const html = readFileSync(page, 'utf8');
  assert.ok(html.includes('<section class="profile" id="profile">'));
  assert.ok(html.includes('href="#profile"'));
  assert.ok(html.includes('2.14x realtime'));
  assert.ok(existsSync(join(dirname(page), 'profile.json')));
  assert.equal(JSON.parse(readFileSync(join(dirname(page), 'review.json'), 'utf8')).profile.totals.personSeconds, 91);

  const plain = readFileSync(build('--slug', 'without-profile'), 'utf8');
  assert.ok(!plain.includes('id="profile"'));

  const home = readFileSync(join(root, 'index.html'), 'utf8');
  assert.ok(home.includes('person ~1m 31s'));
  assert.ok(home.includes('render 2.1x'));
  assert.equal(readdirSync(root).filter((d) => d.endsWith('profile')).length, 2);
});

test('device render beside the server render and the earlier server baseline', () => {
  const server = timings.render;
  const device = { path: 'device', resolution: '1080p', status: 'done', seconds: 20, projectSeconds: 60,
    shown: { label: '-16.0 LUFS · PEAK -1.4 dBTP PRE-ENCODE · 3.2x REALTIME', lufs: -16, truePeakPreEncode: -1.4, xRealtime: 3.2, peakMemMB: null },
    states: [{ state: 'PREPARING CLIPS', at: 0.4 }, { state: 'RENDERING 50%', at: 9 }, { state: 'SAVED TO PHOTOS', at: 20 }] };
  // The server render after the device one is a comparison: tagged `compare`, in neither total.
  const steps = [...timings.steps, { name: 'Render 1080p on the server', kind: 'wait', start: 95, seconds: 30, tag: 'compare' }];
  const both = { ...timings, steps, renders: [device, { ...server, path: 'server' }], baseline: { path: 'server', xRealtime: 0.88, resolution: '1080p', source: '20261003-0219-standup-replay-cold' } };
  const p = buildProfile({ timings: both, logText: fixture('server.ndjson') });
  assert.equal(p.render.path, 'device');
  assert.equal(p.render.xRealtime, 3);
  assert.equal(p.render.shown.lufs, -16);
  assert.equal(p.renders[1].path, 'server');
  assert.equal(p.renders[1].speedBasis, 'server');
  assert.equal(p.baseline.xRealtime, 0.88);
  assert.equal(p.totals.personSeconds, 91);
  assert.equal(p.totals.compareSeconds, 30);
  assert.equal(wait(p, 'Render 1080p on the server').compare, true);
  const html = profileSection(p);
  for (const needle of ['Device render', 'Server render', '3.00x realtime', '<h3>Render speed</h3>', '0.88x', '20261003-0219-standup-replay-cold',
    '-16.0 LUFS', '-1.4 dBTP pre-encode', 'app shows 3.2x', '3.4x the server', 'SAVED TO PHOTOS', '(comparison, not in any total)']) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
  assert.match(profileChips(p), /device 3\.0x.*server 2\.1x/);

  // A device export that failed is a failure, not a speed.
  const failed = buildProfile({ timings: { ...timings, renders: [{ path: 'device', resolution: '1080p', status: 'error', error: 'decode error', seconds: 4, projectSeconds: 60 }] } });
  assert.equal(failed.render.xRealtime, null);
  assert.match(profileSection(failed), /decode error/);
  assert.ok(!profileChips(failed).includes('device'));
});
