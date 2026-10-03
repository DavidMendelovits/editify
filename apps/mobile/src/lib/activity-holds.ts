export type ActivityKind = 'playback' | 'export';

/**
 * Reference-counted engine flags: `send(kind, true)` when the first holder of a kind
 * starts, `send(kind, false)` when the last one releases. Release is idempotent.
 */
export class ActivityHolds {
  private readonly counts = new Map<ActivityKind, number>();

  constructor(private readonly send: (kind: ActivityKind, value: boolean) => void) {}

  /** Starts holding `kind`; the returned function releases this hold. */
  hold(kind: ActivityKind): () => void {
    const count = this.counts.get(kind) ?? 0;
    this.counts.set(kind, count + 1);
    if (count === 0) this.send(kind, true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(kind) ?? 1) - 1;
      if (left > 0) {
        this.counts.set(kind, left);
        return;
      }
      this.counts.delete(kind);
      this.send(kind, false);
    };
  }

  count(kind: ActivityKind): number {
    return this.counts.get(kind) ?? 0;
  }
}
