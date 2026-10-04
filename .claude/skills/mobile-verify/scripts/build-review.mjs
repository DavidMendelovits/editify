#!/usr/bin/env node
// Builds one review page (video + timestamped key moments) and refreshes the
// reviews home page. Static files only: serve-tailnet.sh exposes the folder.
//
//   node build-review.mjs --video flow.mp4 --moments moments.json \
//     [--title "Stand-up sync"] [--slug standup-sync] [--offset 0.6] \
//     [--meta "branch=mobile-capability-lab" --meta "device=iPhone 17 Pro Max"] \
//     [--summary "one paragraph"] [--root ~/editify-reviews] [--profile profile.json]
//
//   --section results.html appends that HTML fragment under the video (e.g. a lab results
//   table; trusted input, written by our own scripts). Repeatable.
//
//   --profile adds a "Profile" section (profile.mjs output: time split, user
//   waits vs server jobs, timeline, render speed, agent stats, request stats).
//
//   <root>/
//     index.html                  every review, newest first (regenerated)
//     <date>-<slug>/
//       index.html                player + moment list (data inlined)
//       video.mp4  review.json  thumbs/NN.jpg  [profile.json]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { PROFILE_CSS, profileChips, profileSection } from './profile-view.mjs';

const args = process.argv.slice(2);
const one = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const many = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]] : []));

const videoPath = one('video');
const momentsPath = one('moments');
if (!videoPath || !existsSync(videoPath)) fail('--video <file> is required and must exist');
const root = resolve((one('root') ?? process.env.REVIEWS_DIR ?? join(homedir(), 'editify-reviews')).replace(/^~/, homedir()));
const offset = Number(one('offset') ?? 0);
const log = momentsPath ? JSON.parse(readFileSync(momentsPath, 'utf8')) : { moments: [] };
const title = one('title') ?? log.title ?? basename(videoPath, extname(videoPath));
const slug = (one('slug') ?? title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'review';
const recordedAt = log.startedAt ? new Date(log.startedAt) : new Date();
const stamp = recordedAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const dir = join(root, `${stamp}-${slug}`);

function fail(message) { console.error(`build-review: ${message}`); process.exit(2); }
function run(bin, argv) { return execFileSync(bin, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

mkdirSync(join(dir, 'thumbs'), { recursive: true });
const ext = extname(videoPath).toLowerCase() || '.mp4';
const videoFile = `video${ext}`;
copyFileSync(videoPath, join(dir, videoFile));

const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, videoFile)]).trim()) || 0;
const moments = log.moments
  .map((m) => ({ ...m, t: Math.max(0, Math.min(duration, Number(m.t) - offset)) }))
  .sort((a, b) => a.t - b.t);
moments.forEach((m, index) => {
  const thumb = `thumbs/${String(index + 1).padStart(2, '0')}.jpg`;
  try {
    run('ffmpeg', ['-v', 'error', '-y', '-ss', String(m.t), '-i', join(dir, videoFile), '-frames:v', '1', '-vf', 'scale=-2:320', join(dir, thumb)]);
    m.thumb = thumb;
  } catch { /* a frame past the end just has no thumbnail */ }
});
try {
  run('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(duration / 3, 5)), '-i', join(dir, videoFile), '-frames:v', '1', '-vf', 'scale=-2:480', join(dir, 'poster.jpg')]);
} catch { /* poster is decoration */ }

const profilePath = one('profile');
if (profilePath && !existsSync(profilePath)) fail(`--profile ${profilePath} does not exist`);
const profile = profilePath ? JSON.parse(readFileSync(profilePath, 'utf8')) : null;
if (profilePath) copyFileSync(profilePath, join(dir, 'profile.json'));

const sections = many('section').map((file) => {
  if (!existsSync(file)) fail(`--section ${file} does not exist`);
  return readFileSync(file, 'utf8');
});

const meta = Object.fromEntries(many('meta').map((pair) => { const i = pair.indexOf('='); return [pair.slice(0, i), pair.slice(i + 1)]; }));
const review = {
  title, slug, recordedAt: recordedAt.toISOString(), duration, video: videoFile,
  summary: one('summary') ?? null, meta, moments, profile,
  counts: { step: moments.filter((m) => m.kind === 'step').length, check: moments.filter((m) => m.kind === 'check').length, issue: moments.filter((m) => m.kind === 'issue').length },
};

// ── pages ──────────────────────────────────────────────────────────────────
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function clock(seconds) {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const BASE_CSS = `
:root{--bg:#0e0e10;--panel:#161618;--raised:#1e1e21;--border:#2e2e33;--text:#ececee;--muted:#9a9aa3;--accent:#5b9bff;--step:#5b9bff;--check:#4cc98a;--issue:#f0656b}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f6f6f7;--panel:#fff;--raised:#f0f0f2;--border:#dcdce0;--text:#141416;--muted:#5d5d66;--accent:#2f6bc7;--step:#2f6bc7;--check:#1f8a55;--issue:#c4363c}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{padding:16px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
h1{font-size:18px;margin:0}.muted{color:var(--muted)}
.chip{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 6px;border-radius:4px;background:var(--raised);border:1px solid var(--border);white-space:nowrap}
.kind{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.kind.step{color:var(--step)}.kind.check{color:var(--check)}.kind.issue{color:var(--issue)}`;

function reviewPage(r) {
  const metaRows = Object.entries(r.meta).map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`).join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.title)}</title><style>${BASE_CSS}${r.profile ? PROFILE_CSS : ''}
main{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:0;height:calc(100vh - 58px)}
.stage{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:16px;gap:12px;min-width:0}
video{max-width:100%;max-height:calc(100vh - 170px);background:#000;border-radius:8px}
.timeline{position:relative;width:100%;max-width:900px;height:22px;background:var(--raised);border:1px solid var(--border);border-radius:6px;cursor:pointer}
.timeline .head{position:absolute;top:0;bottom:0;width:2px;background:var(--text)}
.timeline .tick{position:absolute;top:3px;bottom:3px;width:4px;border-radius:2px;transform:translateX(-2px)}
.tick.step{background:var(--step)}.tick.check{background:var(--check)}.tick.issue{background:var(--issue)}
aside{border-left:1px solid var(--border);overflow-y:auto;background:var(--panel)}
.summary{padding:12px 16px;border-bottom:1px solid var(--border);color:var(--muted)}
ol{list-style:none;margin:0;padding:0}
li{display:grid;grid-template-columns:96px 1fr;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer}
li:hover{background:var(--raised)}li.active{background:var(--raised);box-shadow:inset 3px 0 0 var(--accent)}
li img{width:96px;height:64px;object-fit:cover;border-radius:4px;background:#000}
.label{font-weight:600}.note{color:var(--muted);font-size:13px;margin-top:2px}
.row{display:flex;gap:8px;align-items:center;margin-bottom:2px}
.keys{font-size:12px;color:var(--muted)}
@media (max-width:860px){main{display:block;height:auto}aside{border-left:0;border-top:1px solid var(--border)}video{max-height:60vh}}
</style></head><body>
<header><a href="../">&larr; Reviews</a><h1>${esc(r.title)}</h1>
<span class="muted">${esc(new Date(r.recordedAt).toLocaleString())} &middot; ${clock(r.duration)}</span>
<span class="chip">${r.counts.step} steps</span><span class="chip">${r.counts.check} checks</span>${r.counts.issue ? `<span class="chip kind issue">${r.counts.issue} issues</span>` : ''} ${metaRows}</header>
<main><section class="stage">
<video id="v" src="${esc(r.video)}" controls playsinline preload="metadata"${existsSync(join(dir, 'poster.jpg')) ? ' poster="poster.jpg"' : ''}></video>
<div class="timeline" id="tl" title="Click to seek"><div class="head" id="head"></div></div>
<div class="keys">j / k: previous / next moment &middot; space: play / pause &middot; links like #t=12.5 open at a moment</div>
</section><aside>${r.summary ? `<div class="summary">${esc(r.summary)}</div>` : ''}${r.profile ? '<div class="summary"><a href="#profile">Profile: where the time went &darr;</a></div>' : ''}<ol id="list"></ol></aside></main>
${profileSection(r.profile)}
${sections.join('\n')}
<script>
const review = ${JSON.stringify({ ...r, profile: undefined }).replace(/</g, '\\u003c')};
const v = document.getElementById('v'), list = document.getElementById('list'), tl = document.getElementById('tl'), head = document.getElementById('head');
const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
review.moments.forEach((m, i) => {
  const li = document.createElement('li');
  li.innerHTML = (m.thumb ? '<img loading="lazy" src="' + m.thumb + '" alt="">' : '<span></span>') +
    '<div><div class="row"><span class="chip">' + clock(m.t) + '</span><span class="kind ' + m.kind + '">' + m.kind + '</span></div>' +
    '<div class="label">' + esc(m.label) + '</div>' + (m.note ? '<div class="note">' + esc(m.note) + '</div>' : '') + '</div>';
  li.onclick = () => seek(m.t, true);
  list.appendChild(li);
  const tick = document.createElement('div');
  tick.className = 'tick ' + m.kind; tick.title = clock(m.t) + '  ' + m.label;
  tick.style.left = (100 * m.t / Math.max(review.duration, 0.1)) + '%';
  tick.onclick = (e) => { e.stopPropagation(); seek(m.t, true); };
  tl.appendChild(tick);
});
function seek(t, play) { v.currentTime = t; history.replaceState(null, '', '#t=' + t.toFixed(1)); if (play) v.play(); }
function activeIndex() { let a = -1; review.moments.forEach((m, i) => { if (m.t <= v.currentTime + 0.05) a = i; }); return a; }
v.addEventListener('timeupdate', () => {
  head.style.left = (100 * v.currentTime / Math.max(v.duration || review.duration, 0.1)) + '%';
  const a = activeIndex();
  [...list.children].forEach((li, i) => li.classList.toggle('active', i === a));
});
tl.onclick = (e) => { const r = tl.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * (v.duration || review.duration), false); };
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const a = activeIndex();
  if (e.key === 'j') seek(review.moments[Math.max(0, a - 1)]?.t ?? 0, true);
  if (e.key === 'k') seek(review.moments[Math.min(review.moments.length - 1, a + 1)]?.t ?? 0, true);
  if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
});
const start = Number((location.hash.match(/t=([\\d.]+)/) || [])[1]);
if (start >= 0) {
  // Metadata can arrive before this script runs; seek now if it already has.
  if (v.readyState >= 1) v.currentTime = start;
  else v.addEventListener('loadedmetadata', () => { v.currentTime = start; }, { once: true });
}
</script></body></html>`;
}

function homePage(reviewsRoot) {
  const reviews = readdirSync(reviewsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(reviewsRoot, entry.name, 'review.json')))
    .map((entry) => ({ dir: entry.name, ...JSON.parse(readFileSync(join(reviewsRoot, entry.name, 'review.json'), 'utf8')) }))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const cards = reviews.map((r) => `<a class="card" href="${esc(r.dir)}/">
<img loading="lazy" src="${esc(r.dir)}/poster.jpg" alt="" onerror="this.style.visibility='hidden'">
<div><div class="t">${esc(r.title)}</div><div class="muted">${esc(new Date(r.recordedAt).toLocaleString())} &middot; ${clock(r.duration)}</div>
<div class="row"><span class="chip">${r.moments.length} moments</span>${r.counts.issue ? `<span class="chip kind issue">${r.counts.issue} issues</span>` : '<span class="chip kind check">no issues</span>'}${profileChips(r.profile)}${r.meta.branch ? `<span class="chip">${esc(r.meta.branch)}</span>` : ''}</div></div></a>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mobile reviews</title><style>${BASE_CSS}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:16px}
.card{display:grid;grid-template-columns:110px 1fr;gap:12px;padding:12px;background:var(--panel);border:1px solid var(--border);border-radius:8px;color:var(--text)}
.card:hover{border-color:var(--accent);text-decoration:none}.card img{width:110px;height:80px;object-fit:cover;border-radius:6px;background:#000}
.t{font-weight:600;margin-bottom:2px}.row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
</style></head><body><header><h1>Mobile reviews</h1><span class="muted">${reviews.length} recording${reviews.length === 1 ? '' : 's'}</span></header>
<div class="grid">${cards || '<p class="muted">No reviews yet.</p>'}</div></body></html>`;
}

// Written last: the page builders above use BASE_CSS, defined after them.
writeFileSync(join(dir, 'review.json'), JSON.stringify(review, null, 2));
writeFileSync(join(dir, 'index.html'), reviewPage(review));
writeFileSync(join(root, 'index.html'), homePage(root));
console.log(join(dir, 'index.html'));
