import {
  applyBatch,
  findVideoOverlaps,
  operationSchema,
  overlapKey,
  type Operation,
  type Project,
} from '@editify/shared';

/**
 * Optimistic edits (decision 5A): the phone paints the result of the same
 * `applyBatch` the server runs, so the paint and the server's answer agree on
 * ripple, crossfade edges and everything else, instead of a second rulebook.
 */

/** A fresh id. `crypto.randomUUID` is not in every Hermes build, hence the fallback. */
export function clientId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Names every id the server would otherwise mint (today only the right half of
 * a `split_clip`), so the batch sent and the batch painted produce the same
 * clips and the server's echo does not swap ids under the selection.
 */
export function withClientIds(ops: readonly Operation[], newId: () => string = clientId): Operation[] {
  return ops.map((op) => (op.type === 'split_clip' && !op.params.newClipId
    ? { ...op, params: { ...op.params, newClipId: newId() } }
    : op));
}

/**
 * What the server will answer for `ops` on `current`, or undefined when there
 * is nothing safe to paint: the batch breaks a rule (an OperationError, a
 * history op such as undo, an invalid result) or would introduce a video
 * overlap the server rejects. The server's answer then decides, as before.
 * Keeps `current.version`: the queued request reads it as its base version.
 */
export function optimisticProject(current: Project, ops: readonly Operation[]): Project | undefined {
  try {
    const parsed = ops.map((op) => operationSchema.parse(op));
    const next = applyBatch(current, parsed, {
      // withClientIds already named every new clip; a minted id here would not
      // match the server's, so refuse to paint rather than flash a wrong id.
      newId: () => { throw new Error('Optimistic ops must carry explicit ids'); },
    });
    const existing = new Set(findVideoOverlaps(current).map(overlapKey));
    if (findVideoOverlaps(next).some((overlap) => !existing.has(overlapKey(overlap)))) return undefined;
    return { ...next, version: current.version };
  } catch {
    return undefined;
  }
}
