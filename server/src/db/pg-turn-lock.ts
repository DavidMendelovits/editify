import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { TurnLock } from '../routes/agent-turn.js';

/** Longer than any real turn (24 model calls); past it the lock is let go even if the turn never finished. */
export const MAX_TURN_HOLD_MS = 5 * 60 * 1000;

/**
 * A signed 64-bit advisory-lock key for one (user, project) pair, namespaced so
 * other locks cannot collide. Advisory locks are database-wide, not per schema,
 * so the key also carries the line's schema (`public` for 1.0, DATABASE_SCHEMA
 * `v11` for 1.1): two lines on the same Postgres never block each other's turns.
 */
export function turnLockKey(user: string, projectId: string, schema = 'public'): string {
  return createHash('sha256').update(`editify:agent-turn\u0000${schema}\u0000${user}\u0000${projectId}`).digest().readBigInt64BE(0).toString();
}

/** The lock database could not be reached (down, refused, TLS or login failure). */
export class TurnLockUnavailableError extends Error {
  constructor() {
    super('AI edits are unavailable for a moment. Try again shortly.');
    this.name = 'TurnLockUnavailableError';
  }
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
 * lock needs a session that ends when the machine does, so it must not go
 * through a pooler: DATABASE_LOCK_URL points the lock pool at the direct host
 * (db.<ref>.supabase.co:5432). A pooler may keep a dead machine's server
 * connection, and the lock with it.
 */
export class PgTurnLock implements TurnLock {
  /** `schema` is the line's sync schema (PgPools.schema), which namespaces the lock keys. */
  constructor(private readonly pool: pg.Pool, private readonly schema = 'public', private readonly maxHoldMs = MAX_TURN_HOLD_MS) {}

  private full(): boolean {
    return this.pool.totalCount >= (this.pool.options.max ?? 10) && this.pool.idleCount === 0;
  }

  async tryAcquire(user: string, projectId: string): Promise<(() => Promise<void>) | undefined> {
    const key = turnLockKey(user, projectId, this.schema);
    // Full pool: refuse now rather than queue for the connect timeout.
    if (this.full()) throw new TurnCapacityError();
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      // Still full after the wait means turns held every connection; anything else is the database.
      if (this.full()) throw new TurnCapacityError();
      console.error('[turn-lock] could not connect to the lock database', (error as Error).message);
      throw new TurnLockUnavailableError();
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
