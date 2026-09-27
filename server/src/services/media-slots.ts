import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One pool for every CPU and memory heavy media job: import encodes, renders
 * and whisper runs. Production is a single 4 GB machine, and each of these can
 * eat a core and a gigabyte on its own, so they share one small FIFO limit
 * instead of each path guessing at its own.
 *
 * Rule: a single async chain never holds two slots. Import work holds a slot
 * and then transcribes, and transcription takes a slot too; nesting those would
 * deadlock as soon as every slot is held by an import waiting for a second one.
 * So the pool is reentrant: a call made while the current chain already holds a
 * slot just runs, inside the slot it already has. The flip side is that work
 * started fire-and-forget from inside a slot inherits the context and runs
 * unmetered once the parent releases, so heavy work inside a slot is awaited.
 */
export class MediaSlots {
  private readonly holding = new AsyncLocalStorage<string>();
  private readonly running: string[] = [];
  private readonly waiting: Array<{ label: string; start: () => void }> = [];

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
    return this.waiting.map((waiter) => waiter.label);
  }

  async run<T>(label: string, job: () => Promise<T>): Promise<T> {
    if (this.held()) return await job();
    await this.acquire(label);
    try {
      return await this.holding.run(label, job);
    } finally {
      this.release(label);
    }
  }

  private async acquire(label: string): Promise<void> {
    if (this.running.length < this.capacity) {
      this.running.push(label);
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push({ label, start: resolve });
    });
  }

  private release(label: string): void {
    this.running.splice(this.running.indexOf(label), 1);
    // Hand the slot straight to the next waiter so a newcomer cannot jump the queue.
    const next = this.waiting.shift();
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

export function withMediaSlot<T>(label: string, job: () => Promise<T>): Promise<T> {
  return mediaSlots.run(label, job);
}
