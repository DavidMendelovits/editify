/*
 * The stateless agent turn (decision 3A): the phone owns the project (D3), the
 * server runs the model over a snapshot and returns a proposal, and the phone
 * decides whether to commit it (D4). Pure, so the phone verifies a proposal
 * with the same code the server built it with.
 *
 *  device rev R ──POST /agent/turn {snapshot @R, bundle | bundleDigest}──▶ server
 *                                                                           │ tools run in memory;
 *                                                                           │ generated ids written
 *                                                                           ▼ into each op (OV1)
 *  device ◀──── proposal { id, baseRevision R, ops, deviceCommands, expectedHash }
 *    │
 *    verifyProposal(device project, proposal)
 *      ├─ device rev != R ............. 'stale'    "your edit changed since": nothing applied
 *      ├─ ops fail to apply ........... 'invalid'  nothing applied
 *      ├─ hash(replay) != expected .... 'mismatch' nothing applied
 *      └─ ok ─▶ commit as ONE undo step (OV2, OV7), dedupe by proposal id
 *
 *  deviceCommands (undo / redo / revert_run) are never run on the server
 *  (OV5): the phone holds the history, so it runs them if the user agrees.
 */
import { z } from 'zod';
import {
  agentTraceStepSchema,
  chatRequestSchema,
  operationSchema,
  projectSchema,
  type Operation,
  type Project,
} from './index.js';
import { analysisBundleSchema } from './analysis.js';
import { OperationError, applyBatch } from './apply.js';

/**
 * One AI action is one undo step however many ops it takes, so a proposal is
 * not held to `operationBatchSchema`'s 100 (OV7): captioning a 5-minute set is
 * about 200 ops on its own. This only bounds the payload.
 */
export const MAX_PROPOSAL_OPS = 2000;
/** Undo twice is a request; ten is a loop. */
export const MAX_DEVICE_COMMANDS = 10;

/*
 * index.ts re-exports this module, so it is evaluated before index.ts's own
 * schemas exist: anything taken from './index.js' is read through z.lazy.
 */

/** What the agent may ask the phone to do with its own history (the params of the same ops). */
export const deviceCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('undo'), params: z.object({}).strict() }),
  z.object({ type: z.literal('redo'), params: z.object({}).strict() }),
  z.object({ type: z.literal('revert_run'), params: z.object({ runId: z.string().min(1) }) }),
]);
export type DeviceCommand = z.infer<typeof deviceCommandSchema>;

export function isDeviceCommand(operation: Operation): operation is DeviceCommand {
  return operation.type === 'undo' || operation.type === 'redo' || operation.type === 'revert_run';
}

/** What the server needs to know about a recording; the file itself stays on the phone. */
export const snapshotAssetSchema = z.object({
  id: z.string().min(1),
  originalName: z.string(),
  duration: z.number().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  fps: z.number().min(0),
  hasAudio: z.boolean(),
});
export type SnapshotAsset = z.infer<typeof snapshotAssetSchema>;

export const agentTurnRequestSchema = z.object({
  message: z.lazy(() => chatRequestSchema.shape.message),
  /** The client's idempotency key. Generated ids are derived from it, so it is kept to id-safe characters. */
  proposalId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  snapshot: z.object({
    /** `project.version` is the device revision the proposal is based on. */
    project: z.lazy(() => projectSchema),
    assets: z.array(snapshotAssetSchema).max(500),
    styleDoc: z.string().max(20000).optional(),
  }),
  /** Sent inline the first time; afterwards `bundleDigest` (returned by the server) stands in for it. */
  bundle: analysisBundleSchema.optional(),
  bundleDigest: z.string().min(1).max(128).optional(),
});
export type AgentTurnRequest = z.infer<typeof agentTurnRequestSchema>;

export const proposalSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  baseRevision: z.number().int().min(0),
  /** Every generated id is already written in, so a replay makes exactly the server's document. */
  ops: z.array(z.lazy(() => operationSchema).refine((operation) => !isDeviceCommand(operation), {
    message: 'History commands travel as deviceCommands',
  })).max(MAX_PROPOSAL_OPS),
  deviceCommands: z.array(deviceCommandSchema).max(MAX_DEVICE_COMMANDS),
  /** projectHash of the document after `ops`. */
  expectedHash: z.string().min(1),
  status: z.literal('proposed'),
  reply: z.string(),
  trace: z.array(z.lazy(() => agentTraceStepSchema)),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const agentTurnResponseSchema = z.object({
  proposal: proposalSchema,
  /** The digest the server holds the bundle under; send it instead of the bundle next time. */
  bundleDigest: z.string().optional(),
});
export type AgentTurnResponse = z.infer<typeof agentTurnResponseSchema>;

/** JSON with object keys sorted, so equal values serialize identically on any engine. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A 64-bit fingerprint of the document, ignoring `version` (the server bumps
 * it per batch, the phone once per commit). Two 32-bit multiply-xor lanes in
 * plain integer math: no crypto, which Hermes does not have. It catches a
 * replay that diverged, not an adversary; the server is trusted either way.
 */
export function projectHash(project: Project): string {
  const text = canonicalJson({ ...project, version: 0 });
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export type ProposalCheck =
  | { ok: true; project: Project }
  | { ok: false; reason: 'stale' | 'mismatch' | 'invalid' };

/**
 * Whether the phone may commit `proposal` onto `deviceProject`, and the
 * document it would commit (at revision R + 1, one undo step). Nothing is
 * applied here; the caller commits atomically only on `ok`.
 */
export function verifyProposal(deviceProject: Project, proposal: Proposal): ProposalCheck {
  if (proposal.projectId !== deviceProject.id) return { ok: false, reason: 'invalid' };
  if (deviceProject.version !== proposal.baseRevision) return { ok: false, reason: 'stale' };
  let replayed: Project;
  try {
    // Replayed even with no ops: applyBatch is also what normalizes a document
    // (schema defaults, unknown keys dropped, duration derived), and the server
    // hashed its result the same way.
    replayed = applyBatch(deviceProject, proposal.ops, {
      // Every id was materialized on the server; needing a new one means the ops are not the server's.
      newId: () => { throw new OperationError('Proposal op is missing a generated id'); },
    });
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (projectHash(replayed) !== proposal.expectedHash) return { ok: false, reason: 'mismatch' };
  return { ok: true, project: { ...replayed, version: deviceProject.version + (proposal.ops.length ? 1 : 0) } };
}
