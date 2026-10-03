import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { TurnLock } from '../routes/agent-turn.js';

/** Longer than any real turn (24 model calls); past it the lock is let go even if the turn never finished. */
export const MAX_TURN_HOLD_MS = 5 * 60 * 1000;

/** A signed 64-bit advisory-lock key for one (user, project) pair, namespaced so other locks cannot collide. */
export function turnLockKey(user: string, projectId: string): string {
  return createHash('sha256').update(`editify:agent-turn\u0000${user}\u0000${projectId}`).digest().readBigInt64BE(0).toString();
}

/** Every lock-pool connection is held by a running turn: the machine is at its AI-turn capacity. */
export class TurnCapacityError extends Error {
  constructor() {
    super('Too many AI edits are running right now. Try again shortly.');
    this.name = 'TurnCapacityError';
  }
}

/**
 * One AI turn per project across every Fly machine (decision 4A). A
 * session-level pg_try_advisory_lock on a client held for the whole turn: if
 * the machine dies or the connection drops, Postgres ends the session and the
 * lock goes with it, so a crash can never leave a project stuck.
 *
 * The held client pins one connection per in-flight turn, so this takes its
 * own small pool (db/postgres.ts) and running turns cannot starve /sync. The
 * lock needs a session: a direct or session-mode pooler connection (Supabase
 * port 5432), never the transaction pooler (6543).
 */
export class PgTurnLock implements TurnLock {
  constructor(private readonly pool: pg.Pool, private readonly maxHoldMs = MAX_TURN_HOLD_MS) {}

  async tryAcquire(user: string, projectId: string): Promise<(() => Promise<void>) | undefined> {
    const key = turnLockKey(user, projectId);
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      // The pool's short connect timeout ran out: every lock connection is in a turn (or Postgres is down).
      throw new TurnCapacityError();
    }
    // A checked-out client that loses its connection emits 'error'; unhandled, that crashes the process.
    const onError = (): void => undefined;
    client.on('error', onError);
    let locked: boolean;
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]);
      locked = rows[0]?.locked === true;
    } catch (error) {
      client.off('error', onError);
      client.release(error as Error);
      throw error;
    }
    if (!locked) {
      client.off('error', onError);
      client.release();
      return undefined;
    }
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
        client.off('error', onError);
        client.release();
      } catch (error) {
        // Destroying the connection ends the session, which drops the lock too.
        client.off('error', onError);
        client.release(error as Error);
      }
    };
    // A turn that hangs must not hold the project (or a lock connection) forever.
    const deadline = setTimeout(() => {
      console.warn(`[turn-lock] released a turn lock held past ${this.maxHoldMs} ms`);
      void release();
    }, this.maxHoldMs);
    deadline.unref();
    return release;
  }
}
