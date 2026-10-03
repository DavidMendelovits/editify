import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which queue a job waits in when every slot is busy. Foreground work is
 * something a person is looking at: an import's preview, a render, a
 * transcript the agent asked for. Background work is what an import starts on
 * its own (its transcription) so it is ready before anyone asks. A free slot
 * goes to the oldest foreground waiter first, except that waiting background
 * work gets every third grant (`FOREGROUND_TURNS`) so it cannot starve.
 */
export type SlotLane = 'foreground' | 'background';

/**
 * Any object a caller keeps to name its own queued job to `promote` or
 * `cancel`. Labels can repeat (a replaced run and its successor share one),
 * a ticket cannot.
 */
export type SlotTicket = object;

export interface SlotOptions {
  lane?: SlotLane;
  ticket?: SlotTicket;
}

interface Grant {
  label: string;
  lane: SlotLane;
}

interface Waiter {
  grant: Grant;
  ticket: SlotTicket | undefined;
  /** A background job someone is now waiting on; see `promote`. */
  promoted?: boolean;
  start: () => void;
  cancel: (error: Error) => void;
}

/**
 * While background work waits, it gets a slot after at most this many
 * foreground grants in a row, so a long batch of previews cannot hold every
 * import's transcription back until the whole batch has encoded.
 */
const FOREGROUND_TURNS = 2;

/**
 * One pool for every CPU and memory heavy media job: import encodes, renders
 * and whisper runs. Production is a single 4 GB machine, and each of these can
 * eat a core and a gigabyte on its own, so they share one small limit instead
 * of each path guessing at its own. The lanes only reorder who waits; they
 * never let more than `capacity` jobs run.
 *
 * Background jobs hold at most `capacity - 1` slots at once (at least one),
 * so a preview or render that arrives waits on at most one Whisper run, never
 * on a slot pool full of them. The one exception is a promoted job taking a
 * slot no foreground job was waiting for (see `promote`).
 *
 * Rule: a single async chain never holds two slots. Nesting acquires would
 * deadlock as soon as every slot is held by a job waiting for a second one.
 * So the pool is reentrant: a call made while the current chain already holds a
 * slot just runs, inside the slot it already has. The flip side is that work
 * started fire-and-forget from inside a slot inherits the context and runs
 * unmetered once the parent releases, so heavy work inside a slot is awaited,
 * and work that must queue on its own is started through `detached`.
 */
export class MediaSlots {
  private readonly holding = new AsyncLocalStorage<string>();
  private readonly running: Grant[] = [];
  private readonly waiting: Waiter[] = [];
  private readonly background: Waiter[] = [];
  /** Foreground grants made in a row while background work was waiting. */
  private foregroundStreak = 0;

  constructor(readonly capacity: number) {}

  private get backgroundLimit(): number {
    return Math.max(1, this.capacity - 1);
  }

  /** Whether the calling async chain already holds a slot. */
  held(): boolean {
    return this.holding.getStore() !== undefined;
  }

  /** Labels of the jobs holding a slot right now, oldest first. */
  active(): readonly string[] {
    return this.running.map((grant) => grant.label);
  }

  /**
   * Labels of the jobs waiting for a slot: the foreground queue, then the
   * background one (promoted jobs at its head). Grant order interleaves them;
   * see `nextWaiter`.
   */
  queued(): readonly string[] {
    return [...this.waiting, ...this.background].map((waiter) => waiter.grant.label);
  }

  async run<T>(label: string, job: () => Promise<T>, options: SlotOptions = {}): Promise<T> {
    if (this.held()) return await job();
    const grant = await this.acquire({ label, lane: options.lane ?? 'foreground' }, options.ticket);
    try {
      return await this.holding.run(label, job);
    } finally {
      this.release(grant);
    }
  }

  /**
   * Runs `work` as if no slot were held, so the slot jobs it starts queue on
   * their own instead of riding (unmetered) on the caller's slot.
   */
  detached<T>(work: () => T): T {
    return this.holding.exit(work);
  }

  /**
   * Someone is now waiting on a queued background job (`target` is its ticket
   * or label). It moves to the head of the background queue, behind earlier
   * promotions, and from there goes before every foreground waiter whenever
   * the background cap allows, or whenever no foreground job wants the slot.
   * It still counts against the cap otherwise, so a burst of promotions
   * cannot fill the pool with Whisper runs while previews wait. Returns false
   * when it already started, was already promoted, or never queued.
   */
  promote(target: string | SlotTicket): boolean {
    const index = this.findBackground(target, (waiter) => !waiter.promoted);
    if (index < 0) return false;
    const [waiter] = this.background.splice(index, 1) as [Waiter];
    waiter.promoted = true;
    const firstUnpromoted = this.background.findIndex((other) => !other.promoted);
    this.background.splice(firstUnpromoted < 0 ? this.background.length : firstUnpromoted, 0, waiter);
    this.grantFreeSlots();
    return true;
  }

  /**
   * Drops a queued background job before it starts; its `run` rejects with
   * `error`. A promoted job (someone wants it) is kept.
   */
  cancel(target: string | SlotTicket, error: Error): boolean {
    const index = this.findBackground(target, (waiter) => !waiter.promoted);
    if (index < 0) return false;
    const [waiter] = this.background.splice(index, 1) as [Waiter];
    waiter.cancel(error);
    return true;
  }

  private findBackground(target: string | SlotTicket, eligible: (waiter: Waiter) => boolean): number {
    return this.background.findIndex((waiter) => eligible(waiter)
      && (typeof target === 'string' ? waiter.grant.label === target : waiter.ticket === target));
  }

  private canStart(lane: SlotLane): boolean {
    if (this.running.length >= this.capacity) return false;
    if (lane === 'foreground') return true;
    return this.running.filter((grant) => grant.lane === 'background').length < this.backgroundLimit;
  }

  private async acquire(grant: Grant, ticket?: SlotTicket): Promise<Grant> {
    // Waiters that could start were started on the last release, so a free
    // slot here means nobody eligible is ahead of this job.
    if (this.canStart(grant.lane)) {
      this.running.push(grant);
      return grant;
    }
    await new Promise<void>((start, cancel) => {
      (grant.lane === 'background' ? this.background : this.waiting).push({ grant, ticket, start, cancel });
    });
    return grant;
  }

  private release(grant: Grant): void {
    this.running.splice(this.running.indexOf(grant), 1);
    this.grantFreeSlots();
  }

  /** Hands free slots straight to waiters, so a newcomer cannot jump the queue. */
  private grantFreeSlots(): void {
    while (this.running.length < this.capacity) {
      const next = this.nextWaiter();
      if (!next) return;
      this.running.push(next.grant);
      next.start();
    }
  }

  private nextWaiter(): Waiter | undefined {
    const head = this.background[0];
    const backgroundReady = head !== undefined && this.canStart('background');
    // A promoted job may also take a slot the cap would leave idle.
    if (head?.promoted && (backgroundReady || this.waiting.length === 0)) {
      this.foregroundStreak = 0;
      return this.background.shift();
    }
    if (backgroundReady && (this.waiting.length === 0 || this.foregroundStreak >= FOREGROUND_TURNS)) {
      this.foregroundStreak = 0;
      return this.background.shift();
    }
    const next = this.waiting.shift();
    // Only a grant a background job could have had counts toward its turn;
    // while the cap holds it back, previews are not "jumping" it.
    if (next && backgroundReady) this.foregroundStreak += 1;
    return next;
  }
}

function capacityFromEnv(): number {
  const parsed = Number.parseInt(process.env.EDITIFY_MEDIA_SLOTS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

export const mediaSlots = new MediaSlots(capacityFromEnv());

export function withMediaSlot<T>(label: string, job: () => Promise<T>, options?: SlotOptions): Promise<T> {
  return mediaSlots.run(label, job, options);
}
