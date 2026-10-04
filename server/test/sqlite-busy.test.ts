import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase, SQLITE_BUSY_TIMEOUT_MS } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';

/**
 * The cutover importer writes the live 1.1 server's SQLite file from another process, inside
 * transactions that can run for seconds. A live write that lands meanwhile must wait for the
 * pass to commit, not fail with SQLITE_BUSY. The hold is longer than better-sqlite3's 5 s
 * default, so this fails without the server's own timeout.
 */
const HOLD_MS = 6_000;

/** Another process takes the write lock, says so, holds it for HOLD_MS, then commits. */
function holdWriteLock(path: string): Promise<{ released: Promise<void> }> {
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE projects SET title = title").run();
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${HOLD_MS});
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
  const released = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`))));
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) resolve({ released });
    });
  });
}

describe('SQLite busy timeout', () => {
  it('is set on the server connection, writable and read-only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'editify-busy-')), 'editify.db');
    const writable = createDatabase(path, { readonly: false, journal: false });
    expect(writable.pragma('busy_timeout', { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);
    const readonly = createDatabase(path, { readonly: true });
    expect(readonly.pragma('busy_timeout', { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);
    readonly.close();
    writable.close();
  });

  it('makes a live write wait for another process to commit instead of failing with SQLITE_BUSY', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'editify-busy-')), 'editify.db');
    const database = createDatabase(path, { readonly: false, journal: false });
    try {
      const projects = new ProjectStore(database);
      projects.create({ title: 'Before', format: '9:16', fps: 30 }, 'alice');
      const { released } = await holdWriteLock(path);
      const started = Date.now();
      // Synchronous: blocks here until the other process commits (or the timeout runs out).
      const created = projects.create({ title: 'During', format: '9:16', fps: 30 }, 'alice');
      const waited = Date.now() - started;
      await released;
      expect(created.title).toBe('During');
      expect(waited).toBeGreaterThan(HOLD_MS / 2);
      expect(waited).toBeLessThan(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      database.close();
    }
  }, 30_000);
});
