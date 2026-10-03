import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which queue a job waits in when every slot is busy. Foreground work is
 * something a person is looking at: an import's preview, a render, a
 * transcript the agent asked for. Background work is what an import starts on
 * its own (its transcription) so it is ready before anyone asks. A free slot
 * goes to the oldest foreground waiter first, then the oldest background one.
 */
export type SlotLane = 'foreground' | 'background';

export interface SlotOptions {
  lane?: SlotLane;
}

interface Waiter {
  label: string;
  start: () => void;
}

/**
 * One pool for every CPU and memory heavy media job: import encodes, renders
 * and whisper runs. Production is a single 4 GB machine, and each of these can
 * eat a core and a gigabyte on its own, so they share one small limit instead
 * of each path guessing at its own. The lanes only reorder who waits; they
 * never let more than `capacity` jobs run.
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
  private readonly running: string[] = [];
  private readonly waiting: Waiter[] = [];
  private readonly background: Waiter[] = [];

  constructor(readonly capacity: number) {}

  /** Whether the calling async chain already holds a slot. */
  held(): boolean {
    return this.holding.getStore() !== undefined;
  }

  /** Labels of the jobs holding a slot right now, oldest first. */
  active(): readonly string[] {
    return [...this.running];
  }

  /** Labels of the jobs waiting for a slot, in the order they will get one. */
  queued(): readonly string[] {
    return [...this.waiting, ...this.background].map((waiter) => waiter.label);
  }

  async run<T>(label: string, job: () => Promise<T>, options: SlotOptions = {}): Promise<T> {
    if (this.held()) return await job();
    await this.acquire(label, options.lane ?? 'foreground');
    try {
      return await this.holding.run(label, job);
    } finally {
      this.release(label);
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
   * Moves a background waiter to the back of the foreground queue: someone is
   * now waiting on it. Returns false when it already started or never queued.
   */
  promote(label: string): boolean {
    const index = this.background.findIndex((waiter) => waiter.label === label);
    if (index < 0) return false;
    const [waiter] = this.background.splice(index, 1);
    this.waiting.push(waiter as Waiter);
    return true;
  }

  private async acquire(label: string, lane: SlotLane): Promise<void> {
    if (this.running.length < this.capacity) {
      this.running.push(label);
      return;
    }
    await new Promise<void>((resolve) => {
      (lane === 'background' ? this.background : this.waiting).push({ label, start: resolve });
    });
  }

  private release(label: string): void {
    this.running.splice(this.running.indexOf(label), 1);
    // Hand the slot straight to the next waiter so a newcomer cannot jump the queue.
    const next = this.waiting.shift() ?? this.background.shift();
    if (!next) return;
    this.running.push(next.label);
    next.start();
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
