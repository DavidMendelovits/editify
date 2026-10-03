import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { TurnLock } from '../routes/agent-turn.js';

/** A signed 64-bit advisory-lock key for one (user, project) pair, namespaced so other locks cannot collide. */
export function turnLockKey(user: string, projectId: string): string {
  return createHash('sha256').update(`editify:agent-turn\u0000${user}\u0000${projectId}`).digest().readBigInt64BE(0).toString();
}

/**
 * One AI turn per project across every Fly machine (decision 4A). A
 * session-level pg_try_advisory_lock on a client held for the whole turn: if
 * the machine dies or the connection drops, Postgres ends the session and the
 * lock goes with it, so a crash can never leave a project stuck.
 *
 * The held client pins one connection per in-flight turn, and the lock needs
 * a session: DATABASE_URL must be a direct or session-mode pooler connection
 * (Supabase port 5432), not the transaction-mode pooler (6543).
 */
export class PgTurnLock implements TurnLock {
  constructor(private readonly pool: pg.Pool) {}

  async tryAcquire(user: string, projectId: string): Promise<(() => Promise<void>) | undefined> {
    const key = turnLockKey(user, projectId);
    const client = await this.pool.connect();
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
    return async () => {
      if (released) return;
      released = true;
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
  }
}
