#!/usr/bin/env node
/**
 * The 1.0 side of the 1.1 cutover (plan T9/T16, C6). Runs ON editify-dm and only
 * ever reads: it measures the volume, hashes the media, takes a consistent copy
 * of the SQLite database with the online backup API, and serves all of it to the
 * importer on editify-v11 over Fly's private 6PN network. No public endpoint.
 *
 * Self-contained on purpose: node builtins plus better-sqlite3 (resolved from the
 * 1.0 image's /app/server), so it can be uploaded to a running 1.0 machine with
 * `fly ssh sftp` without a 1.0 deploy. RUNBOOK.md next to this file has the commands.
 *
 *   node source-agent.mjs status   --db /data/editify.db               journal on? its newest id, DB + WAL size
 *   node source-agent.mjs measure  --root /data                      du per directory
 *   node source-agent.mjs manifest --root /data                      hash every file (warms the cache)
 *   node source-agent.mjs backup   --db /data/editify.db --out F     backup API copy of the DB
 *   node source-agent.mjs serve    --root /data --db /data/editify.db --host fly-local-6pn --port 7373
 *
 * `serve` needs CUTOVER_TOKEN (32+ chars) in the environment and answers only
 * requests that carry it as a bearer token:
 *
 *   GET  /du                 { root, entries: [{ name, bytes, files }], total }
 *   GET  /manifest           NDJSON, one { path, size, mtimeMs, sha256 } per file (blank lines are keep-alives)
 *   GET  /file?path=<rel>    the file's bytes
 *   POST /snapshot           backup API copy now ─▶ { name, size, sha256, journalId }
 *   GET  /snapshot/<name>    that copy's bytes
 *
 * Why the backup API: editify.db runs in WAL mode, so the newest commits can sit
 * in editify.db-wal. Copying editify.db alone can miss them; a backup reads
 * through the WAL and yields one consistent file at a single point in time.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** Never media: the live database and its sidecars, the importer's own work dirs, fsck's dir. */
export const EXCLUDED_TOP_LEVEL = new Set([
  'editify.db', 'editify.db-wal', 'editify.db-shm', 'editify.db-journal', 'cutover', 'lost+found',
]);
const TEMP_SUFFIX = '.cutover-tmp';

function loadSqlite() {
  const candidates = [import.meta.url, '/app/server/package.json', join(process.cwd(), 'package.json')];
  for (const from of candidates) {
    try {
      return createRequire(from)('better-sqlite3');
    } catch {
      // try the next place
    }
  }
  throw new Error('better-sqlite3 not found: run from /app/server on a 1.0 machine, or from the repo');
}

/** `rel` resolved inside `root`, or undefined when it escapes it or names an excluded entry. */
export function insideRoot(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return undefined;
  const full = resolve(root, rel);
  const back = relative(resolve(root), full);
  if (back === '' || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) return undefined;
  if (EXCLUDED_TOP_LEVEL.has(back.split(sep)[0])) return undefined;
  return full;
}

/** Every regular file under root (sorted, POSIX-style relative paths), minus the excluded entries. */
export async function walk(root) {
  const files = [];
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
      if (entry.name.endsWith(TEMP_SUFFIX)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, rel);
      else if (entry.isFile()) {
        const info = await stat(full);
        files.push({ path: rel, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
      }
      // Symlinks, sockets and devices are not media; they are skipped.
    }
  };
  await visit(resolve(root), '');
  return files;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** du per top-level entry of root, largest first, plus the total. */
export async function measure(root) {
  const totals = new Map();
  for (const file of await walk(root)) {
    const top = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : file.path;
    const entry = totals.get(top) ?? { name: top, bytes: 0, files: 0 };
    entry.bytes += file.size;
    entry.files += 1;
    totals.set(top, entry);
  }
  const entries = [...totals.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return {
    root: resolve(root),
    entries,
    total: { bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), files: entries.reduce((sum, entry) => sum + entry.files, 0) },
  };
}

/**
 * Hashes every file, reusing a cached hash while size and mtime are unchanged.
 * `onEntry` sees each entry as soon as it is hashed (the NDJSON stream uses it).
 */
export async function manifest(root, { cachePath, onEntry } = {}) {
  let cache = {};
  if (cachePath && existsSync(cachePath)) {
    try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
  }
  const next = {};
  const entries = [];
  for (const file of await walk(root)) {
    const cached = cache[file.path];
    const sha256 = cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs
      ? cached.sha256
      : await sha256File(join(root, file.path));
    const entry = { ...file, sha256 };
    next[file.path] = entry;
    entries.push(entry);
    await onEntry?.(entry);
  }
  if (cachePath) {
    await mkdir(resolve(cachePath, '..'), { recursive: true });
    writeFileSync(`${cachePath}${TEMP_SUFFIX}`, JSON.stringify(next));
    await rename(`${cachePath}${TEMP_SUFFIX}`, cachePath);
  }
  return entries;
}

/**
 * A consistent copy of the database through SQLite's online backup API, then
 * the journal watermark read from the copy itself: J is exactly what the copy holds.
 */
export async function backupDatabase(dbPath, outPath) {
  const Database = loadSqlite();
  await mkdir(resolve(outPath, '..'), { recursive: true });
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    source.pragma('busy_timeout = 15000');
    await source.backup(`${outPath}${TEMP_SUFFIX}`);
  } finally {
    source.close();
  }
  await rename(`${outPath}${TEMP_SUFFIX}`, outPath);
  const copy = new Database(outPath, { readonly: true, fileMustExist: true });
  let journalId = 0;
  try {
    const check = copy.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`The backup copy failed quick_check: ${check}`);
    const hasJournal = copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mutations'").get();
    if (hasJournal) journalId = copy.prepare('SELECT MAX(id) AS id FROM mutations').get().id ?? 0;
  } finally {
    copy.close();
  }
  const info = await stat(outPath);
  return { name: basename(outPath), path: outPath, size: info.size, sha256: await sha256File(outPath), journalId };
}

/** Whether the mutations journal (C19) is installed, and how far it has got. Read-only. */
export async function journalStatus(dbPath) {
  const Database = loadSqlite();
  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('busy_timeout = 15000');
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mutations'").get();
    const triggers = database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mutations_journal_%'").get().n;
    const journalId = table ? database.prepare('SELECT MAX(id) AS id FROM mutations').get().id ?? 0 : 0;
    const size = async (path) => (await stat(path).catch(() => undefined))?.size ?? 0;
    return { journal: Boolean(table), triggers, journalId, dbBytes: await size(dbPath), walBytes: await size(`${dbPath}-wal`) };
  } finally {
    database.close();
  }
}

function tokenMatches(header, token) {
  const presented = Buffer.from(String(header ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** The HTTP side. Resolves once listening, with `{ server, port, close }`. */
export async function serve({ root, dbPath, host, port, token, workDir }) {
  if (!token || token.length < 32) throw new Error('CUTOVER_TOKEN must be set to 32 or more characters');
  if (!host) throw new Error('--host is required (fly-local-6pn on Fly, 127.0.0.1 locally)');
  const snapshotsDir = join(workDir, 'snapshots');
  const cachePath = join(workDir, 'hash-cache.json');
  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const streamFile = async (response, full) => {
    const info = await lstat(full).catch(() => undefined);
    if (!info?.isFile()) return send(response, 404, { error: 'not found' });
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(info.size) });
    await pipeline(createReadStream(full), response);
  };
  const server = createServer(async (request, response) => {
    try {
      if (!tokenMatches(request.headers.authorization, token)) return send(response, 401, { error: 'unauthorized' });
      const url = new URL(request.url ?? '/', 'http://agent');
      if (request.method === 'GET' && url.pathname === '/du') return send(response, 200, await measure(root));
      if (request.method === 'GET' && url.pathname === '/manifest') {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.flushHeaders();
        const heartbeat = setInterval(() => response.write('\n'), 15_000);
        try {
          await manifest(root, { cachePath, onEntry: (entry) => { response.write(`${JSON.stringify(entry)}\n`); } });
        } finally {
          clearInterval(heartbeat);
        }
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/file') {
        const full = insideRoot(root, url.searchParams.get('path'));
        if (!full) return send(response, 400, { error: 'bad path' });
        // A symlinked directory on the way would lead out of root; the manifest never lists such files either.
        const real = await realpath(full).catch(() => undefined);
        if (!real || insideRoot(await realpath(root), relative(await realpath(root), real)) !== real) return send(response, 404, { error: 'not found' });
        return await streamFile(response, full);
      }
      if (request.method === 'POST' && url.pathname === '/snapshot') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const result = await backupDatabase(dbPath, join(snapshotsDir, `editify-${stamp}.db`));
        return send(response, 200, { name: result.name, size: result.size, sha256: result.sha256, journalId: result.journalId });
      }
      const snapshot = /^\/snapshot\/(editify-[0-9A-Za-z-]+\.db)$/.exec(url.pathname);
      if (request.method === 'GET' && snapshot) return await streamFile(response, join(snapshotsDir, snapshot[1]));
      return send(response, 404, { error: 'not found' });
    } catch (error) {
      if (!response.headersSent) send(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen(undefined));
  });
  const address = server.address();
  return {
    server,
    port: typeof address === 'object' && address ? address.port : port,
    close: () => new Promise((done) => server.close(() => done(undefined))),
  };
}

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function main(argv) {
  const [command] = argv;
  const root = resolve(option(argv, 'root', '/data'));
  const workDir = resolve(option(argv, 'work-dir', '/tmp/editify-cutover'));
  if (command === 'status') {
    console.log(JSON.stringify(await journalStatus(resolve(option(argv, 'db', join(root, 'editify.db'))))));
    return;
  }
  if (command === 'measure') {
    const result = await measure(root);
    for (const entry of result.entries) console.log(`${human(entry.bytes).padStart(10)}  ${String(entry.files).padStart(8)} files  ${entry.name}`);
    console.log(`${human(result.total.bytes).padStart(10)}  ${String(result.total.files).padStart(8)} files  total (${result.total.bytes} bytes)`);
    return;
  }
  if (command === 'manifest') {
    const entries = await manifest(root, { cachePath: join(workDir, 'hash-cache.json') });
    console.log(`hashed ${entries.length} files, ${human(entries.reduce((sum, entry) => sum + entry.size, 0))}`);
    return;
  }
  if (command === 'backup') {
    const dbPath = resolve(option(argv, 'db', join(root, 'editify.db')));
    const out = resolve(option(argv, 'out', join(workDir, 'snapshots', `editify-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)));
    console.log(JSON.stringify(await backupDatabase(dbPath, out)));
    return;
  }
  if (command === 'serve') {
    const agent = await serve({
      root,
      dbPath: resolve(option(argv, 'db', join(root, 'editify.db'))),
      host: option(argv, 'host', undefined),
      port: Number(option(argv, 'port', '7373')),
      token: process.env.CUTOVER_TOKEN ?? '',
      workDir,
    });
    console.log(`cutover source agent serving ${root} on port ${agent.port} (read-only)`);
    const stop = () => { void agent.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  console.error('usage: source-agent.mjs status|measure|manifest|backup|serve [--root /data] [--db F] [--out F] [--host H] [--port P] [--work-dir D]');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
