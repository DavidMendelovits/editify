import { previewBatch, type Operation, type Project } from '@editify/shared';

/**
 * Optimistic edits (decision 5A): the phone paints the result of the same
 * edit rules the server runs (`previewBatch` from @editify/shared), so the
 * paint and the server's answer agree on ripple, crossfade edges and the rest.
 * Ids must be explicit before a batch is painted or sent (`withExplicitIds`).
 *
 * The paint skips checks only the server can make (asset grants, a stale base
 * version), so the server can still refuse a painted batch: the ledger below
 * rolls that paint back.
 */

/** The paint for `ops` on `current`, or undefined when there is nothing safe to paint. */
export function optimisticProject(current: Project, ops: readonly Operation[]): Project | undefined {
  try {
    return previewBatch(current, ops);
  } catch (error) {
    // Expected for undo and for edits the server will refuse; its answer decides.
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[optimistic] not painted:', error);
    return undefined;
  }
}

/** One batch on its way to the server. Compared by identity. */
export interface PendingBatch { readonly ops: readonly Operation[] }

/**
 * The last document the server confirmed with every pending batch painted on
 * top, oldest first. A batch whose paint is refused is skipped, not fatal.
 */
export function repaint(confirmed: Project, pending: readonly PendingBatch[]): Project {
  return pending.reduce((doc, batch) => optimisticProject(doc, batch.ops) ?? doc, confirmed);
}

/**
 * Tracks what the server last confirmed and which batches are still painted on
 * top of it, so the screen can always be redrawn as confirmed + pending.
 *
 * Rule: a batch settling (either way) never discards another batch's paint.
 * On success the server's document becomes the base and the batches still in
 * flight are repainted onto it; on failure the failed batch's paint is dropped
 * and the rest are repainted onto the last confirmed document. So an offline
 * failure leaves no phantom edit behind, and an earlier batch's answer does
 * not wipe a later batch's paint.
 */
export class OptimisticLedger {
  private confirmed: Project | undefined;
  private pending: PendingBatch[] = [];

  /** A new batch: `cached` is what the screen shows now. Returns what to show next. */
  begin(cached: Project, batch: PendingBatch): Project {
    // With nothing in flight the cache is the server's document (a fetch, a
    // chat turn or an undo may have replaced it since the last confirm).
    if (this.pending.length === 0 || !this.confirmed) this.confirmed = cached;
    this.pending.push(batch);
    return repaint(this.confirmed, this.pending);
  }

  /** The server's answer: for `batch`, or for a write outside the ledger (undo, revert, chat). */
  confirm(doc: Project, batch?: PendingBatch): Project {
    this.confirmed = doc;
    if (batch) this.pending = this.pending.filter((entry) => entry !== batch);
    return repaint(doc, this.pending);
  }

  /** The server refused `batch`. Undefined when it was never painted (nothing to roll back). */
  reject(batch: PendingBatch): Project | undefined {
    if (!this.pending.includes(batch) || !this.confirmed) return undefined;
    this.pending = this.pending.filter((entry) => entry !== batch);
    return repaint(this.confirmed, this.pending);
  }
}
