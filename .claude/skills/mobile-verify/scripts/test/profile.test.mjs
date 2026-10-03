// node --test .claude/skills/mobile-verify/scripts/test/*.test.mjs
// Synthetic run (see timings.json): 95s run, 4 human steps, 4 waits; the server
// log has 5 media jobs (probe, thumbnail, proxy, transcribe, render) and 29
// requests. server-no-jobs.ndjson is the same log from an older server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProfile, routePattern } from '../profile.mjs';
import { profileSection, profileChips } from '../profile-view.mjs';

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
  assert.equal(p.source.requestLines, 29);
  assert.equal(p.source.serverStartedAt, 1);

  assert.equal(p.totals.personSeconds, 124);
  assert.equal(p.totals.humanEstimateSeconds, 54);
  assert.equal(p.totals.productWaitSeconds, 70);
  assert.equal(p.totals.automationSeconds, 15.5);
  assert.equal(p.totals.automationOverheadSeconds, 9.5);
  assert.equal(p.totals.serverBusySource, 'media jobs');
  assert.equal(p.totals.serverBusySeconds, 53.5); // union of job runs
  assert.equal(p.totals.jobSeconds, 54.5); // sum of job ms
  assert.equal(p.totals.queueSeconds, 1.5);

  const upload = wait(p, 'Upload the clip');
  assert.deepEqual(upload.jobs.map((j) => j.job), ['probe']);
  near(upload.serverBusySeconds, 7); // the upload POST is in flight 10.2-17.2
  near(upload.idleSeconds, 1);
  assert.equal(upload.requests.count, 4);

  const preview = wait(p, 'Preview playable (server proxy)');
  assert.deepEqual(preview.jobs.map((j) => j.job), ['thumbnail', 'proxy']);
  const proxy = preview.jobs.find((j) => j.job === 'proxy');
  assert.equal(proxy.ms, 9000);
  assert.equal(proxy.waitMs, 1000);
  assert.equal(proxy.queuedAt, 18);
  assert.equal(proxy.start, 19);
  assert.equal(proxy.end, 28);
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
  assert.equal(renderWait.jobBusySeconds, 28);
  assert.equal(renderWait.queueSeconds, 0.5);
  assert.equal(renderWait.requests.count, 8);

  assert.equal(p.requests.total, 29);
  assert.equal(p.requests.pollingDuringWaits, 25);
  assert.equal(p.requests.timeline.length, 29);
  const assets = p.requests.routes.find((r) => r.route === '/assets/:id');
  assert.deepEqual([assets.count, assets.p50Ms, assets.p95Ms, assets.maxMs], [6, 3, 6, 6]);
  assert.equal(p.requests.routes.find((r) => r.route === '/missing').errors, 1);

  assert.deepEqual(
    { seconds: p.render.seconds, out: p.render.outputSeconds, x: p.render.xRealtime, perMin: p.render.secondsPerOutputMinute, serverMs: p.render.serverMs, queueMs: p.render.queueMs },
    { seconds: 30, out: 60, x: 2, perMin: 30, serverMs: 28000, queueMs: 500 },
  );
  assert.deepEqual(
    { seconds: p.agent.seconds, serverMs: p.agent.serverMs, toolCalls: p.agent.toolCalls, failed: p.agent.failedToolCalls, thoughts: p.agent.thoughts, ops: p.agent.ops, polls: p.agent.pollRequests },
    { seconds: 20, serverMs: 19000, toolCalls: 3, failed: 1, thoughts: 2, ops: 4, polls: 7 },
  );
  assert.deepEqual(p.agent.tools, { get_transcript: 1, remove_silences: 2 });
});

test('degrades to request-derived data without media job lines', () => {
  const p = buildProfile({ timings, logText: fixture('server-no-jobs.ndjson') });
  assert.equal(p.hasMediaJobs, false);
  assert.ok(p.notes.some((n) => n.includes('"media job"')), p.notes.join('\n'));
  assert.ok(p.notes.some((n) => n.includes('No chat trace')));
  assert.deepEqual(p.jobs, []);
  assert.equal(p.totals.serverBusySource, 'requests');
  near(p.totals.serverBusySeconds, p.totals.requestBusySeconds, 0);
  assert.equal(p.totals.jobSeconds, null);

  const upload = wait(p, 'Upload the clip');
  assert.equal(upload.jobs, undefined);
  assert.equal(upload.idleSeconds, undefined); // background work is invisible: no idle claim
  near(upload.requestBusySeconds, 7);
  assert.equal(p.requests.pollingDuringWaits, 25);

  assert.equal(p.render.xRealtime, 2);
  assert.equal(p.render.serverMs, undefined);
  assert.equal(p.agent.serverMs, 19000);
  assert.equal(p.agent.toolCalls, undefined);

  const html = profileSection(p);
  assert.match(html, /does not log &quot;media job&quot; lines/);
  assert.match(html, /Request in flight/);
});

test('works from timings alone (no server log)', () => {
  const legacy = { ...timings, startedAtMs: undefined, render: undefined };
  const p = buildProfile({ timings: legacy });
  assert.ok(p.notes.some((n) => n.startsWith('No server log')));
  assert.equal(p.requests.total, 0);
  assert.equal(p.render, null);
  assert.equal(p.totals.personSeconds, 124);
  assert.equal(p.source.runStartMs, timings.startedAtMs); // recovered from `at` - runSeconds
  assert.match(profileSection(p), /id="profile"/);
});

test('profile section and home chips render the numbers', () => {
  const p = buildProfile({ timings, logText: fixture('server.ndjson'), chat });
  const html = profileSection(p);
  for (const needle of ['id="profile"', '<h2>Profile</h2>', 'Where the time went', 'Timeline', 'User waits', 'Requests',
    '~2m 04s', '2.00x realtime', '30s per output minute', '3 tool calls (1 failed)', 'class="gantt"', 'class="stack"',
    '>proxy<', 'Upload the clip', '<code>GET /renders/:id</code>']) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
  assert.ok(!/\u2014/.test(html), 'no em dashes in page copy');
  assert.equal(profileSection(null), '');
  assert.match(profileChips(p), /person ~2m 04s.*render 2\.0x/);
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
  assert.ok(html.includes('2.00x realtime'));
  assert.ok(existsSync(join(dirname(page), 'profile.json')));
  assert.equal(JSON.parse(readFileSync(join(dirname(page), 'review.json'), 'utf8')).profile.totals.personSeconds, 124);

  const plain = readFileSync(build('--slug', 'without-profile'), 'utf8');
  assert.ok(!plain.includes('id="profile"'));

  const home = readFileSync(join(root, 'index.html'), 'utf8');
  assert.ok(home.includes('person ~2m 04s'));
  assert.ok(home.includes('render 2.0x'));
  assert.equal(readdirSync(root).filter((d) => d.endsWith('profile')).length, 2);
});
