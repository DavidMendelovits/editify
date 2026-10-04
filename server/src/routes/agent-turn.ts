import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  agentTurnRequestSchema,
  canonicalJson,
  type AgentTurnResponse,
  type AnalysisBundle,
} from '@editify/shared';
import type { AgentService } from '../agent/service.js';
import { TurnCapacityError, TurnLockUnavailableError } from '../db/pg-turn-lock.js';

/** How long a bundle and a finished proposal are remembered: a few retries' worth, not a session. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * The turn's own body limit. A 1-hour set (video words, loudness and faces at
 * 2 fps, plus the memo's words and loudness) measures 2.0 MB of JSON with
 * rounded numbers and 4.8 MB if the phone writes full-precision doubles; 8 MB
 * fits that plus the project snapshot, well under the app's 20 MB upload limit.
 */
export const AGENT_TURN_BODY_LIMIT = 8 * 1024 * 1024;
/** Bundles held per user: a couple of projects being edited, each with an older digest or two. */
const BUNDLES_PER_USER = 4;
/**
 * All users' bundles together, in JSON characters (the parsed objects cost a
 * few times that in heap). Past it the oldest bundle goes, whoever's it is;
 * BUNDLES_PER_USER keeps one account from holding more than its share.
 */
const BUNDLE_BYTES = 48 * 1024 * 1024;
const PROPOSAL_LIMIT = 256;
/** Each turn is up to 24 model calls, so the default allowance is a burst of 6 and one more every 10 s. */
const DEFAULT_RATE = { capacity: 6, refillPerSecond: 0.1 };
/** Past this many users with a bucket, full buckets (the same as no bucket) are swept. */
const BUCKET_SWEEP_AT = 1024;

/** Insertion-ordered map with expiry; past `limit` the oldest entry goes. */
class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  constructor(private readonly limit: number, private readonly now: () => number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires > this.now()) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + CACHE_TTL_MS });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

/** Bundles by (user, digest), bounded per user and by total size, oldest out first. */
class BundleCache {
  private readonly entries = new Map<string, { user: string; bundle: AnalysisBundle; bytes: number; expires: number }>();
  private bytes = 0;
  constructor(private readonly now: () => number) {}

  get(user: string, digest: string): AnalysisBundle | undefined {
    const key = `${user}\u0000${digest}`;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.remove(key);
    if (entry.expires <= this.now()) return undefined;
    // Still in use: keep it another TTL rather than make the phone resend it mid-session.
    this.entries.set(key, { ...entry, expires: this.now() + CACHE_TTL_MS });
    this.bytes += entry.bytes;
    return entry.bundle;
  }

  set(user: string, digest: string, bundle: AnalysisBundle, bytes: number): void {
    const key = `${user}\u0000${digest}`;
    this.remove(key);
    this.entries.set(key, { user, bundle, bytes, expires: this.now() + CACHE_TTL_MS });
    this.bytes += bytes;
    const mine = [...this.entries].filter(([, entry]) => entry.user === user).map(([entryKey]) => entryKey);
    for (const oldest of mine.slice(0, Math.max(0, mine.length - BUNDLES_PER_USER))) this.remove(oldest);
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= BUNDLE_BYTES || oldest === key) break;
      this.remove(oldest);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

/** One turn in flight per (user, project). */
export interface TurnLock {
  /** A release function, or undefined when a turn already holds this project. */
  tryAcquire(user: string, projectId: string): Promise<(() => Promise<void>) | undefined>;
}

/** This process's memory: exact on one machine, and the fallback when DATABASE_URL is unset. */
export function memoryTurnLock(): TurnLock {
  const running = new Set<string>();
  return {
    async tryAcquire(user, projectId) {
      const key = `${user}\u0000${projectId}`;
      if (running.has(key)) return undefined;
      running.add(key);
      return async () => { running.delete(key); };
    },
  };
}

export interface AgentTurnOptions {
  rate?: { capacity: number; refillPerSecond: number };
  now?: () => number;
  /** Shared across machines when Postgres is configured (db/pg-turn-lock.ts). */
  lock?: TurnLock;
}

/**
 * POST /agent/turn: one stateless agent turn over the phone's snapshot. The
 * response is a proposal (packages/shared/src/proposal.ts); nothing is written
 * to the project or asset tables.
 *
 *   body (8 MB max) ─▶ same (user, proposalId) seen? ─ yes ─▶ the same proposal (or the same in-flight run)
 *     │ no
 *   bundle inline ─▶ digest │ digest only ─▶ cache hit? ─ no ─▶ 409 needBundle
 *     │
 *   turn running on this project? ─ yes ─▶ 409 busy
 *   rate allowance left? ─ no ─▶ 429 + Retry-After
 *     │ (only now is an inline bundle cached: a refused request leaves nothing behind)
 *   run the turn ─▶ { proposal, bundleDigest }
 *
 * The project lock is a Postgres advisory lock when DATABASE_URL is set, so
 * it holds across N Fly machines (decision 4A), and this process's memory
 * otherwise.
 *
 * ponytail: the bundle cache, idempotency record and rate buckets are still
 * this process's memory, exact on one machine. With N machines a retry can
 * land elsewhere and run the model again (the phone still commits a proposal
 * once, deduped by its id), and the rate allowance is per machine. Move them
 * to a shared store if that cost shows up. A bundle miss already degrades to
 * a 409 the client answers by resending it.
 */
export function registerAgentTurnRoutes(app: FastifyInstance, agent: AgentService, options: AgentTurnOptions = {}): void {
  const now = options.now ?? Date.now;
  const rate = options.rate ?? DEFAULT_RATE;
  const bundles = new BundleCache(now);
  const proposals = new TtlCache<Promise<AgentTurnResponse>>(PROPOSAL_LIMIT, now);
  const lock = options.lock ?? memoryTurnLock();
  const buckets = new Map<string, { tokens: number; at: number }>();

  /** Seconds until the user may start another turn; 0 takes one now. */
  const takeToken = (user: string): number => {
    const at = now();
    if (buckets.size > BUCKET_SWEEP_AT) {
      for (const [key, idle] of buckets) {
        if (idle.tokens + ((at - idle.at) / 1000) * rate.refillPerSecond >= rate.capacity) buckets.delete(key);
      }
    }
    const bucket = buckets.get(user) ?? { tokens: rate.capacity, at };
    bucket.tokens = Math.min(rate.capacity, bucket.tokens + ((at - bucket.at) / 1000) * rate.refillPerSecond);
    bucket.at = at;
    buckets.set(user, bucket);
    if (bucket.tokens < 1) return (1 - bucket.tokens) / rate.refillPerSecond;
    bucket.tokens -= 1;
    return 0;
  };

  app.post('/agent/turn', { bodyLimit: AGENT_TURN_BODY_LIMIT }, async (request, reply) => {
    const body = agentTurnRequestSchema.parse(request.body);
    // Unauthenticated dev and shared-token requests share one scope, as they do for projects.
    const user = request.userId ?? '';
    const turnKey = `${user}\u0000${body.proposalId}`;
    // A retried delivery gets the first answer, without paying for the model again.
    const earlier = proposals.get(turnKey);
    if (earlier) return await earlier;

    let bundle: AnalysisBundle | undefined;
    let bundleDigest: string | undefined;
    let inline: { json: string } | undefined;
    if (body.bundle) {
      bundle = body.bundle;
      inline = { json: canonicalJson(bundle) };
      bundleDigest = createHash('sha256').update(inline.json).digest('hex');
    } else if (body.bundleDigest) {
      bundle = bundles.get(user, body.bundleDigest);
      if (!bundle) {
        return await reply.code(409).send({ error: 'The server no longer has that analysis; send the bundle again.', needBundle: true });
      }
      bundleDigest = body.bundleDigest;
    }

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock.tryAcquire(user, body.snapshot.project.id);
    } catch (error) {
      if (error instanceof TurnCapacityError) {
        return await reply.code(503).header('retry-after', '10').send({ error: error.message, code: 'capacity' });
      }
      if (error instanceof TurnLockUnavailableError) {
        return await reply.code(503).header('retry-after', '10').send({ error: error.message, code: 'lock_unavailable' });
      }
      throw error;
    }
    if (!release) {
      // The holder may be this very proposal, delivered twice at once: answer with its run.
      const inFlight = proposals.get(turnKey);
      if (inFlight) return await inFlight;
      return await reply.code(409).send({ error: 'An AI edit is already running on this project.', code: 'busy' });
    }
    const wait = takeToken(user);
    if (wait > 0) {
      await release();
      const retryAfter = Math.ceil(wait);
      return await reply.code(429).header('retry-after', String(retryAfter))
        .send({ error: `Too many AI edits in a row. Try again in ${retryAfter}s.`, retryAfter });
    }

    if (bundle && inline && bundleDigest) bundles.set(user, bundleDigest, bundle, inline.json.length);
    const pending = agent.propose(body, bundle, request.userId)
      .then((proposal): AgentTurnResponse => ({ proposal, ...(bundleDigest ? { bundleDigest } : {}) }));
    proposals.set(turnKey, pending);
    try {
      return await pending;
    } catch (error) {
      // A failed turn is not an answer: a retry runs it again.
      proposals.delete(turnKey);
      throw error;
    } finally {
      await release();
    }
  });
}
