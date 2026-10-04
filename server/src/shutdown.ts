import type { FastifyInstance } from 'fastify';
import type { EditifyDatabase } from './db/database.js';

/**
 * Folds the WAL back into editify.db, then closes. A writable connection only:
 * a READ_ONLY=1 connection cannot checkpoint, and must not try (the freeze
 * promises the file is never touched). Safe to call twice.
 */
export function checkpointAndClose(database: EditifyDatabase, log: (line: string) => void = () => {}): void {
  if (!database.open) return;
  if (!database.readonly) {
    try {
      database.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      log(`WAL checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  database.close();
}

export interface ShutdownOptions {
  app: FastifyInstance;
  database: EditifyDatabase;
  /** How long in-flight requests get to finish. Fly sends SIGKILL 5s after the signal by default. */
  graceMs?: number;
  log?: (line: string) => void;
  exit?: (code: number) => void;
}

/**
 * The SIGINT/SIGTERM handler (Fly's default kill signal is SIGINT): stop
 * accepting requests, give in-flight ones `graceMs` to finish, checkpoint the
 * WAL and close SQLite, then exit. A second signal skips the wait.
 */
export function createShutdownHandler(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { app, database, graceMs = 3_000, log = (line) => console.log(line), exit = (code) => process.exit(code) } = options;
  let closing = false;
  return async (signal) => {
    if (closing) {
      log(`[shutdown] ${signal} again; closing the database and exiting now`);
      checkpointAndClose(database, log);
      exit(1);
      return;
    }
    closing = true;
    log(`[shutdown] ${signal}: no new requests, ${graceMs}ms for in-flight ones`);
    let timer: NodeJS.Timeout | undefined;
    // A keep-alive connection whose request finishes mid-close would otherwise
    // hold the server open until its idle timeout; drop each as it goes idle.
    const sweep = setInterval(() => { app.server.closeIdleConnections(); }, 50);
    const finished = await Promise.race([
      app.close().then(() => true, (error: unknown) => {
        log(`[shutdown] close failed: ${error instanceof Error ? error.message : String(error)}`);
        return true;
      }),
      new Promise<false>((done) => { timer = setTimeout(() => done(false), graceMs); }),
    ]);
    clearTimeout(timer);
    clearInterval(sweep);
    if (!finished) log(`[shutdown] requests still running after ${graceMs}ms; closing anyway`);
    // The app's onClose hook already did this when every request finished.
    checkpointAndClose(database, log);
    log(`[shutdown] database ${database.readonly ? 'closed (read-only, no checkpoint)' : 'checkpointed and closed'}`);
    exit(0);
  };
}

export function installShutdownHandlers(options: ShutdownOptions, signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']): void {
  const handler = createShutdownHandler(options);
  for (const signal of signals) process.on(signal, (received) => { void handler(received); });
}
