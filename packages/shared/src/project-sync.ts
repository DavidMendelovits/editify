/*
 * Project sync (decision 4A, OV4): the phone owns the project (D3) and pushes
 * each committed change to the server, which keeps the latest document and an
 * ordered log in Postgres. One push is one transaction and one revision.
 *
 *  phone @R ──POST /sync/projects/:id/changes {changeId, baseRevision R, ops}──▶ server
 *     ├─ changeId seen before ........ the original receipt (retries are safe)
 *     ├─ revision != R ............... 409 stale + current revision: pull, rebase, push again
 *     ├─ ops fail / hash differs ..... rejected, nothing written
 *     └─ ok ─▶ { receipt: revision R + 1, seq, hash }
 *
 * Committing a proposal: changeId = runId = proposal.id and expectedHash =
 * proposal.expectedHash. Undo, redo and revert_run are pushed like any change
 * (alone, one per push) so the server's log replays the same history.
 */
import { z } from 'zod';
import { operationSchema, projectSchema } from './index.js';
import { MAX_PROPOSAL_OPS } from './proposal.js';

/*
 * index.ts re-exports this module, so it is evaluated before index.ts's own
 * schemas exist: anything taken from './index.js' is read through z.lazy.
 */

/** A client-generated idempotency key, the same shape as a proposal id. */
export const syncChangeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const syncCreateRequestSchema = z.object({
  /** `project.version` becomes the starting revision. */
  project: z.lazy(() => projectSchema),
});
export type SyncCreateRequest = z.infer<typeof syncCreateRequestSchema>;

export const syncPushRequestSchema = z.object({
  changeId: syncChangeIdSchema,
  baseRevision: z.number().int().min(0),
  /** Generated ids must already be in the ops: the server never mints one. */
  ops: z.array(z.lazy(() => operationSchema)).min(1).max(MAX_PROPOSAL_OPS),
  /** Tags the change as one agent turn, the handle revert_run takes. */
  runId: z.string().min(1).max(128).optional(),
  /** projectHash the device got; a different server result is refused. */
  expectedHash: z.string().min(1).max(64).optional(),
});
export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

export const syncReceiptSchema = z.object({
  projectId: z.string(),
  changeId: z.string(),
  baseRevision: z.number().int(),
  /** Equal to baseRevision when the change altered nothing. */
  revision: z.number().int(),
  /** The log row written, or null for a no-op. */
  seq: z.number().int().nullable(),
  hash: z.string(),
});
export type SyncReceipt = z.infer<typeof syncReceiptSchema>;

export const syncLogKindSchema = z.enum(['create', 'edit', 'undo', 'redo', 'revert_run']);
export type SyncLogKind = z.infer<typeof syncLogKindSchema>;

export const syncLogEntrySchema = z.object({
  seq: z.number().int(),
  kind: syncLogKindSchema,
  ops: z.array(z.lazy(() => operationSchema)),
  revision: z.number().int(),
  undone: z.boolean(),
  runId: z.string().nullable(),
  undoTargetSeq: z.number().int().nullable(),
  changeId: z.string().nullable(),
  createdAt: z.string(),
});
export type SyncLogEntry = z.infer<typeof syncLogEntrySchema>;
