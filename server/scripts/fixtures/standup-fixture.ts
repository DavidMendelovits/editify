/**
 * Stand-up fixture: the 4K stand-up clip + voice memo imported and fully
 * processed ONCE (proxy, transcripts, faces), then cloned into a fresh data
 * dir per test run so warm replays skip the 1.17 GB import and every encode.
 *
 *   npx tsx scripts/fixtures/standup-fixture.ts build ["<media folder>"]
 *   npx tsx scripts/fixtures/standup-fixture.ts clone <dest data dir>
 *
 *   build:  data/fixtures/standup/   (SQLite + assets/ + manifest.json)
 *   clone:  cp -cR (APFS copy-on-write: instant, no extra disk until written)
 *
 * The video is imported by path, so the fixture references the original in
 * the media folder instead of copying it; manifest.json records the ids.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const fixtureDir = join(serverRoot, 'data', 'fixtures', 'standup');
const [command, arg] = process.argv.slice(2);

function findUp(name: string, from: string): string | undefined {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, name))) return join(dir, name);
  return undefined;
}

if (command === 'clone') {
  if (!arg) throw new Error('clone needs a destination data dir');
  if (!existsSync(join(fixtureDir, 'manifest.json'))) throw new Error(`no fixture yet: run "build" first (${fixtureDir})`);
  if (existsSync(arg)) throw new Error(`${arg} already exists; clone into a fresh dir`);
  execFileSync('cp', ['-cR', fixtureDir, resolve(arg)]);
  console.log(resolve(arg));
  process.exit(0);
}
if (command !== 'build') {
  console.error('usage: standup-fixture.ts build [media folder] | clone <dest>');
  process.exit(2);
}

const envFile = findUp('.env.local', serverRoot);
const mediaDir = resolve(arg ?? join(dirname(envFile ?? serverRoot), 'stand-up audio sync test'));
const files = readdirSync(mediaDir).filter((name) => !name.startsWith('.'));
const videoName = files.find((name) => ['.mov', '.mp4', '.m4v'].includes(extname(name).toLowerCase()));
const memoName = files.find((name) => ['.m4a', '.wav', '.mp3', '.aac'].includes(extname(name).toLowerCase()));
if (!videoName || !memoName) throw new Error(`${mediaDir} needs one video and one audio file`);
if (existsSync(fixtureDir)) throw new Error(`${fixtureDir} exists; move it aside to rebuild`);

process.env.EDITIFY_DATA_DIR = fixtureDir;
process.env.MEDIA_IMPORT_DIR = mediaDir;
delete process.env.EDITIFY_TOKEN;
delete process.env.SUPABASE_URL;

const { buildApp } = await import('../../src/app.js');
const { createDatabase } = await import('../../src/db/database.js');
const { AssetStore } = await import('../../src/db/asset-store.js');
const { TranscriptStore } = await import('../../src/db/transcript-store.js');
const { FaceService } = await import('../../src/services/face-service.js');

const database = createDatabase();
const app = await buildApp({ database });
await app.ready();
const assets = new AssetStore(database);
const transcripts = new TranscriptStore(database);
const faces = new FaceService(database);
const call = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>): Promise<T> => {
  const response = await app.inject({ method, url, payload: payload as never, headers });
  if (response.statusCode >= 400) throw new Error(`${method} ${url} -> ${response.statusCode}: ${response.body.slice(0, 200)}`);
  return response.json() as T;
};

const started = performance.now();
const video = await call<{ id: string }>('POST', '/assets/import', { name: videoName });
const memo = await call<{ id: string }>('POST', `/assets/raw?name=${encodeURIComponent(memoName)}`, createReadStream(join(mediaDir, memoName)), { 'content-type': 'audio/mp4' });
process.stdout.write('processing (proxy, transcripts, faces)');
while (assets.get(video.id)?.status === 'processing' || !transcripts.get(video.id) || !transcripts.get(memo.id) || !faces.get(video.id)) {
  if (assets.get(video.id)?.status === 'error') throw new Error('video processing failed');
  process.stdout.write('.');
  await new Promise((done) => setTimeout(done, 2000));
}
const seconds = Math.round((performance.now() - started) / 1000);
writeFileSync(join(fixtureDir, 'manifest.json'), JSON.stringify({
  builtAt: new Date().toISOString(), seconds, mediaDir, video: { id: video.id, name: videoName }, memo: { id: memo.id, name: memoName },
}, null, 2));
console.log(`\nfixture ready in ${seconds}s: ${fixtureDir}`);
await app.close();
process.exit(0);
