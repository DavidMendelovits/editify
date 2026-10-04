import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { checkpointAndClose, createShutdownHandler } from '../src/shutdown.js';

const walSize = (path: string): number => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
const hashFiles = (path: string): string => {
  const hash = createHash('sha256');
  for (const file of [path, `${path}-wal`]) hash.update(existsSync(file) ? readFileSync(file) : Buffer.from('absent'));
  return hash.digest('hex');
};

/** A writable WAL database with commits still sitting in the -wal file. */
function seeded(): { path: string; database: EditifyDatabase } {
  const path = join(mkdtempSync(join(tmpdir(), 'editify-shutdown-')), 'editify.db');
  const database = createDatabase(path, { readonly: false, journal: false });
  // Keep SQLite from folding the WAL in on its own, so the test sees ours.
  database.pragma('wal_autocheckpoint = 0');
  const projects = new ProjectStore(database);
  for (let index = 0; index < 20; index += 1) projects.create({ title: `p${index}`, format: '9:16', fps: 30 }, 'alice');
  return { path, database };
}

const opened: EditifyDatabase[] = [];
afterEach(() => {
  for (const database of opened.splice(0)) if (database.open) database.close();
});

describe('checkpointAndClose', () => {
  it('folds the WAL into editify.db before closing a writable database', () => {
    const { path, database } = seeded();
    expect(walSize(path)).toBeGreaterThan(0);
    checkpointAndClose(database);
    expect(database.open).toBe(false);
    expect(walSize(path)).toBe(0);
    // The .db file alone now holds every commit.
    const copy = new Database(path, { readonly: true });
    opened.push(copy);
    expect((copy.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count).toBe(20);
  });

  it('skips the checkpoint on a read-only connection and leaves the files untouched', () => {
    const { path, database } = seeded();
    checkpointAndClose(database);
    const before = hashFiles(path);
    const frozen = createDatabase(path, { readonly: true });
    const pragma = vi.spyOn(frozen, 'pragma');
    checkpointAndClose(frozen);
    expect(pragma).not.toHaveBeenCalled();
    expect(frozen.open).toBe(false);
    expect(hashFiles(path)).toBe(before);
    // Twice is harmless.
    expect(() => checkpointAndClose(frozen)).not.toThrow();
  });
});

describe('the SIGINT/SIGTERM handler', () => {
  it('stops accepting requests, lets an in-flight one finish, then checkpoints, closes and exits 0', async () => {
    const { path, database } = seeded();
    const app = Fastify();
    let release: () => void = () => {};
    app.get('/slow', async () => { await new Promise<void>((done) => { release = done; }); return { ok: true }; });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const inFlight = fetch(`${base}/slow`);
    await vi.waitFor(() => { expect(release).not.toBe(undefined); });
    await new Promise((done) => setTimeout(done, 50));
    const exit = vi.fn();
    const lines: string[] = [];
    const shutdown = createShutdownHandler({ app, database, graceMs: 2_000, exit, log: (line) => lines.push(line) });
    const done = shutdown('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exit).not.toHaveBeenCalled();
    // Closing: a new request is turned away (503, or refused outright) while the old one runs.
    const late = await fetch(`${base}/slow`).then((response) => response.status, () => 'refused');
    expect([503, 'refused']).toContain(late);
    release();
    expect((await inFlight).status).toBe(200);
    await done;

    expect(exit).toHaveBeenCalledWith(0);
    expect(database.open).toBe(false);
    expect(walSize(path)).toBe(0);
    expect(lines.join('\n')).toContain('checkpointed and closed');
    // Finished on its own, well inside the grace period.
    expect(lines.join('\n')).not.toContain('still running');
  });

  it('closes anyway when a request outlives the grace period', async () => {
    const { path, database } = seeded();
    const app = Fastify();
    app.get('/hang', async () => await new Promise(() => {}));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    void fetch(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hang`).catch(() => {});
    await new Promise((done) => setTimeout(done, 50));

    const exit = vi.fn();
    const lines: string[] = [];
    const started = Date.now();
    await createShutdownHandler({ app, database, graceMs: 100, exit, log: (line) => lines.push(line) })('SIGTERM');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(exit).toHaveBeenCalledWith(0);
    expect(database.open).toBe(false);
    expect(walSize(path)).toBe(0);
    expect(lines.join('\n')).toContain('still running after 100ms');
    app.server.closeAllConnections();
  });

  it('in READ_ONLY mode closes without checkpointing, leaving editify.db and -wal byte-identical', async () => {
    const { path, database: writer } = seeded();
    checkpointAndClose(writer);
    const before = hashFiles(path);
    const database = createDatabase(path, { readonly: true });
    const app = Fastify();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const exit = vi.fn();
    const lines: string[] = [];
    await createShutdownHandler({ app, database, graceMs: 500, exit, log: (line) => lines.push(line) })('SIGINT');
    expect(exit).toHaveBeenCalledWith(0);
    expect(database.open).toBe(false);
    expect(hashFiles(path)).toBe(before);
    expect(lines.join('\n')).toContain('read-only, no checkpoint');
  });
});
