import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

/*
 * Connections for project sync and the agent-turn lock (decision 4A).
 *
 * Two pools per machine, so in-flight AI turns (each pins one connection for
 * its whole run) can never starve /sync writes:
 *
 *   sync pool  DATABASE_POOL_MAX       (default 4)  short transactions
 *   lock pool  DATABASE_LOCK_POOL_MAX  (default 2)  one held client per running turn;
 *                                                   when it is full, a new turn gets 503 capacity
 *
 * Sizing: Supabase's session-mode pooler hands each client connection its own
 * server connection, up to the project's pool_size (15 on the smaller compute
 * tiers; check Database settings). Keep
 *   machines × (DATABASE_POOL_MAX + DATABASE_LOCK_POOL_MAX)  <  pool_size
 * with headroom for migrations and the dashboard: 2 machines × 6 = 12 < 15.
 * With DATABASE_LOCK_URL on the direct host, the lock pool counts against
 * the database's max_connections instead of the pooler's pool_size.
 *
 * TLS: a non-local host always gets TLS. DATABASE_CA_CERT (PEM text) or
 * DATABASE_CA_CERT_PATH verifies the server; without one, only an explicit
 * `sslmode=no-verify` in the URL is accepted (encrypted, unverified), and
 * anything else refuses to start. Plaintext is allowed only for localhost.
 *
 * Port 6543 is Supabase's transaction-mode pooler. Sync transactions work
 * there, but a session advisory lock does not, so the turn lock falls back to
 * this process's memory with a loud warning.
 *
 * The turn lock must not go through a pooler at all. If a machine dies
 * mid-turn, a pooler can keep the server connection (without DISCARD ALL),
 * so the advisory lock outlives the turn and the project answers 409 busy
 * until that connection is recycled. DATABASE_LOCK_URL, used for the lock
 * pool only, should point at the direct host, db.<ref>.supabase.co:5432; it
 * falls back to DATABASE_URL, with a warning when that is a pooler. The same
 * TLS rules (and CA) apply to it.
 */

/** Client-side cap on any one query, and the wait for a free connection. */
const QUERY_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** Server-side caps, applied with SET LOCAL inside every sync transaction. */
export const STATEMENT_TIMEOUT_MS = 15_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

/**
 * The CA from env, checked now so a bad secret fails the boot with a clear
 * reason. Fly and shell secrets often carry a PEM as one line with literal
 * "\n" sequences, which are turned back into newlines first.
 */
function caFrom(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.DATABASE_CA_CERT || (env.DATABASE_CA_CERT_PATH ? readFileSync(env.DATABASE_CA_CERT_PATH, 'utf8') : undefined);
  if (!raw) return undefined;
  const ca = raw.replace(/\\n/g, '\n').trim();
  try {
    new X509Certificate(ca);
  } catch (error) {
    throw new Error(`DATABASE_CA_CERT is not a readable PEM certificate (${(error as Error).message})`);
  }
  return ca;
}

export interface PgSettings {
  pool: pg.PoolConfig;
  /** False on the transaction pooler: session advisory locks would not hold. */
  sessionLocks: boolean;
  /** Supabase's pooler host: fine for sync, wrong for the turn lock. */
  pooler: boolean;
  warnings: string[];
}

/** Pure: what DATABASE_URL and its companions resolve to, or a thrown reason not to start. */
export function pgSettings(connectionString: string, env: NodeJS.ProcessEnv = process.env, name = 'DATABASE_URL'): PgSettings {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${name} is not a valid postgres:// URL`);
  }
  const warnings: string[] = [];
  // A ?host=/path parameter is a Unix socket, which is as local as it gets.
  const hostParam = url.searchParams.get('host');
  const local = hostParam ? hostParam.startsWith('/') : LOCAL_HOSTS.has(url.hostname);
  const sslmode = url.searchParams.get('sslmode');
  // pg lets URL ssl parameters override the ssl object below, so TLS is decided here alone.
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('ssl') || key === 'uselibpqcompat') url.searchParams.delete(key);
  }

  const ca = caFrom(env);
  let ssl: pg.PoolConfig['ssl'];
  if (ca) {
    ssl = { ca, rejectUnauthorized: true };
  } else if (sslmode === 'no-verify') {
    ssl = { rejectUnauthorized: false };
    if (!local) warnings.push(`${name} uses sslmode=no-verify: encrypted, but the server certificate is not checked. Set DATABASE_CA_CERT to verify it.`);
  } else if (!local) {
    throw new Error(`${name} points at a remote host without a CA: set DATABASE_CA_CERT (or DATABASE_CA_CERT_PATH), or add sslmode=no-verify explicitly.`);
  } else if (sslmode && sslmode !== 'disable') {
    ssl = { rejectUnauthorized: false };
  }

  const sessionLocks = url.port !== '6543';

  return {
    pool: {
      connectionString: url.toString(),
      ...(ssl ? { ssl } : {}),
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      // TCP keepalive, so a half-open connection (a NAT or pooler dropping it) is noticed instead of hanging.
      keepAlive: true,
    },
    sessionLocks,
    pooler: url.hostname.includes('pooler.') || !sessionLocks,
    warnings,
  };
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pool(config: pg.PoolConfig, label: string): pg.Pool {
  const created = new pg.Pool(config);
  // An idle client losing its connection is reported here; unhandled, it would crash the process.
  created.on('error', (error) => { console.error(`[${label}] idle Postgres client error`, error.message); });
  return created;
}

export interface PgPools {
  sync: pg.Pool;
  /** Undefined when session locks cannot work (transaction pooler). */
  lock: pg.Pool | undefined;
  end(): Promise<void>;
}

/** Lazy: nothing connects until the first query. Throws (at boot) on an unsafe configuration. */
export function createPgPools(connectionString: string, env: NodeJS.ProcessEnv = process.env): PgPools {
  const settings = pgSettings(connectionString, env);
  const lockSettings = env.DATABASE_LOCK_URL ? pgSettings(env.DATABASE_LOCK_URL, env, 'DATABASE_LOCK_URL') : settings;
  const warnings = env.DATABASE_LOCK_URL ? [...settings.warnings, ...lockSettings.warnings] : [...settings.warnings];
  if (!lockSettings.sessionLocks) {
    warnings.push('The agent-turn lock would use the transaction-mode pooler (port 6543), where a session lock cannot hold, so it stays per machine. Set DATABASE_LOCK_URL to the direct host (db.<ref>.supabase.co:5432).');
  } else if (lockSettings.pooler) {
    warnings.push(`The agent-turn lock connects through a pooler: a machine that dies mid-turn can leave its project busy. Set DATABASE_LOCK_URL to the direct host (db.<ref>.supabase.co:5432).`);
  }
  for (const warning of warnings) console.warn(`[postgres] WARNING: ${warning}`);
  const sync = pool({ ...settings.pool, max: positive(env.DATABASE_POOL_MAX, 4) }, 'sync');
  const lock = lockSettings.sessionLocks
    ? pool({ ...lockSettings.pool, max: positive(env.DATABASE_LOCK_POOL_MAX, 2) }, 'turn-lock')
    : undefined;
  return {
    sync,
    lock,
    async end() { await Promise.all([sync.end(), lock?.end()]); },
  };
}
