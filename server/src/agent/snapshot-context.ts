/*
 * The stateless agent turn (plan P3, decision 3A): the same tools and loop as
 * a chat turn, run over a snapshot of the phone's project held in memory. The
 * server's project and asset tables are never touched; what the turn produces
 * is a proposal the phone may commit (packages/shared/src/proposal.ts).
 *
 *   snapshot ──▶ in-memory ToolContext ──▶ runAgentLoop(toolsFor(available))
 *                 │ projects: shared applyBatch, ProjectStore's version rules,
 *                 │           every changed batch recorded with its ids written in
 *                 │ undo/redo: captured as device commands, never applied
 *                 │ words, loudness, faces, sync: the phone's AnalysisBundle
 *                 ▼
 *              proposal { ops, deviceCommands, expectedHash = projectHash(result) }
 */
import {
  MAX_DEVICE_COMMANDS,
  MAX_PROPOSAL_OPS,
  OperationError,
  applyBatch,
  isDeviceCommand,
  operationSchema,
  planSyncOps,
  projectHash,
  proposalSchema,
  readyPart,
  resolveSyncPair,
  type AgentTurnRequest,
  type AnalysisBundle,
  type DeviceCommand,
  type Operation,
  type Project,
  type Proposal,
  type SnapshotAsset,
} from '@editify/shared';
import type { StoredAsset } from '../db/asset-store.js';
import { AssetAccessError, VersionConflictError, assertNoNewVideoOverlap, assetIds, sameDoc } from '../db/project-store.js';
import type { StoredTranscript } from '../db/transcript-store.js';
import { runAgentLoop } from './loop.js';
import type { ToolProvider } from './providers.js';
import { toolsFor, type ToolContext, type ToolDef, type ToolNeed } from './tools.js';

const NOT_HERE = 'is not available in a stateless turn: the media is on the phone';

/** A snapshot asset as the stores' shape. No paths: nothing here may open the file. */
function storedAsset(asset: SnapshotAsset): StoredAsset {
  return {
    ...asset,
    mimeType: '',
    status: 'ready',
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '',
    originalPath: '', proxyPath: '', thumbnailPath: '',
    createdAt: '',
  };
}

/**
 * What this turn can serve (plan OV6). Project and asset metadata always;
 * words, loudness and sync only when the phone sent a ready result. Dissection,
 * library sounds, renders and insights need the server's media and never are.
 */
function availableNeeds(bundle: AnalysisBundle | undefined): Set<ToolNeed> {
  const available = new Set<ToolNeed>(['assets']);
  for (const analysis of Object.values(bundle?.assets ?? {})) {
    if (readyPart(analysis.transcript)) available.add('transcripts');
    if (readyPart(analysis.energy)) available.add('energy');
  }
  if (bundle?.syncs.some((sync) => sync.status === 'ready' && sync.measurement)) available.add('sync');
  return available;
}

export interface SnapshotTurn {
  ctx: ToolContext;
  available: Set<ToolNeed>;
  /** Every op of every changed batch, in order, generated ids written in: what the phone replays. */
  ops: Operation[];
  deviceCommands: DeviceCommand[];
  project(): Project;
}

export function createSnapshotContext(request: AgentTurnRequest, bundle: AnalysisBundle | undefined, userId?: string): SnapshotTurn {
  // Normalized the way the phone's replay normalizes (verifyProposal), so even a
  // proposal with no ops hashes the same on both sides.
  let project = applyBatch(request.snapshot.project, []);
  const ops: Operation[] = [];
  const deviceCommands: DeviceCommand[] = [];
  const assets = new Map(request.snapshot.assets.map((asset) => [asset.id, storedAsset(asset)]));
  const analysisOf = (assetId: string) => bundle?.assets[assetId];
  const transcriptOf = (assetId: string): StoredTranscript | undefined => {
    const transcript = readyPart(analysisOf(assetId)?.transcript);
    if (!transcript) return undefined;
    const energy = readyPart(analysisOf(assetId)?.energy);
    return { assetId, createdAt: '', ...transcript, ...(energy ? { energy } : {}) };
  };

  // OV1: a split the model did not name gets an id derived from the proposal,
  // written into the op itself, so the phone's replay needs no id generator.
  let splits = 0;
  const materialize = (operation: Operation): Operation => (
    operation.type === 'split_clip' && !operation.params.newClipId
      ? { ...operation, params: { ...operation.params, newClipId: `${request.proposalId}-s${++splits}` } }
      : operation
  );

  const projects: ToolContext['projects'] = {
    // A fresh copy per read, as the store's parse gives: a tool that mutates what it read must not edit the proposal.
    get: (id) => (id === project.id ? structuredClone(project) : undefined),
    // ProjectStore.applyOperations' rules, in memory: exact base version, one
    // version bump per changed batch, none for a batch that changed nothing.
    applyOperations: (projectId, rawOperations, baseVersion) => {
      if (projectId !== project.id) throw new OperationError(`Project ${projectId} was not found`);
      if (baseVersion !== project.version) throw new VersionConflictError(baseVersion, project.version);
      const operations = rawOperations.map((operation) => operationSchema.parse(operation));
      if (!operations.length) throw new OperationError('At least one operation is required');
      // OV5: the phone holds the history, so undo and redo go to it as commands.
      // A proposal carries either edits or a command, never both: an undo after
      // this turn's edits would undo the proposal itself, and edits planned
      // after an undo would sit on a timeline the server never saw.
      const command = operations.find(isDeviceCommand);
      if (command) {
        if (operations.length !== 1) throw new OperationError('Undo must be applied by itself');
        if (ops.length) throw new OperationError(`This turn already proposed edits, so ${command.type} would only take them back. Finish the turn; the user can undo from the phone.`);
        if (deviceCommands.length >= MAX_DEVICE_COMMANDS) throw new OperationError(`One turn proposes at most ${MAX_DEVICE_COMMANDS} history commands.`);
        deviceCommands.push(command);
        return project;
      }
      if (deviceCommands.length) {
        throw new OperationError(`This turn proposed ${deviceCommands[0]?.type ?? 'a history command'} for the phone to run, so further edits would land on a timeline that does not exist yet. Finish the turn.`);
      }
      const materialized = operations.map(materialize);
      if (ops.length + materialized.length > MAX_PROPOSAL_OPS) {
        throw new OperationError(`One turn proposes at most ${MAX_PROPOSAL_OPS} operations; finish here and continue in the next message.`);
      }
      const after = applyBatch(project, materialized, {
        newId: () => { throw new OperationError('Every generated id must be materialized'); },
      });
      assertNoNewVideoOverlap(project, after);
      const before = assetIds(project);
      const foreign = [...assetIds(after)].find((id) => !before.has(id) && !assets.has(id));
      if (foreign) throw new AssetAccessError(foreign);
      if (sameDoc(project, after)) return project;
      project = { ...after, version: baseVersion + 1 };
      ops.push(...materialized);
      return project;
    },
  };

  const unsupported = (what: string) => (): never => { throw new OperationError(`${what} ${NOT_HERE}`); };
  const ctx: ToolContext = {
    projectId: project.id,
    ...(userId ? { userId } : {}),
    projects,
    assets: {
      get: (id) => assets.get(id),
      getInProject: (_projectId, id) => assets.get(id),
      listForProject: () => [...assets.values()],
      // Every snapshot asset already belongs to the project.
      link: () => undefined,
      getByOriginalName: unsupported('The media library'),
      upsert: unsupported('The media library'),
    },
    styleDoc: request.snapshot.styleDoc ?? null,
    currentVersion: project.version,
    transcripts: {
      get: transcriptOf,
      // Nothing to promote: the phone's analysis is the only transcriber here.
      getForTimeline: transcriptOf,
      // Never Whisper: the phone transcribes, and sends the words when it has them.
      transcribe: async () => { throw new Error(`Transcription ${NOT_HERE}; the phone sends the words once its analysis finishes`); },
      ensureEnergy: async (asset) => {
        const energy = readyPart(analysisOf(asset.id)?.energy);
        if (!energy) throw new Error(`The phone has not sent a loudness analysis for asset ${asset.id} yet`);
        return energy;
      },
    },
    energyOf: (assetId) => readyPart(analysisOf(assetId)?.energy),
    insights: { getOrCreate: unsupported('Insight analysis') },
    faces: { tryGet: async (asset) => (asset ? readyPart(analysisOf(asset.id)?.faces) : undefined) },
    syncs: {
      // The phone measured the pair (AudioSync.swift); only the planning runs here.
      plan: async (current, syncRequest) => {
        const resolved = resolveSyncPair(current, syncRequest, (assetId) => assets.get(assetId));
        if (!resolved.ok) return resolved;
        const { videoAsset, memoAsset } = resolved.pair;
        const measured = bundle?.syncs.find((sync) => sync.videoAssetId === videoAsset.id
          && sync.memoAssetId === memoAsset.id && sync.status === 'ready')?.measurement;
        if (!measured) return { ok: false, error: 'The phone has not measured how this memo lines up with that video yet' };
        const { driftSec, ...measurement } = measured;
        return planSyncOps(current, resolved.pair, { ...measurement, ...(driftSec !== undefined ? { driftSec } : {}) });
      },
    },
  };

  return { ctx, available: availableNeeds(bundle), ops, deviceCommands, project: () => project };
}

/** undo and redo, re-worded for a turn where they are proposed to the phone rather than run. */
function asDeviceCommandTool(tool: ToolDef): ToolDef {
  const type = tool.name as 'undo' | 'redo';
  return {
    ...tool,
    description: `${tool.description} Here it is proposed to the user's phone, which keeps the edit history and runs it if the user agrees; it cannot be combined with edits in the same turn.`,
    execute: async (ctx, input) => {
      try {
        tool.schema.parse(input);
        ctx.projects.applyOperations(ctx.projectId, [{ type, params: {} }], ctx.currentVersion);
        return { ok: true, deviceCommand: type, notes: [`Proposed ${type} to the phone. Nothing changed here; say so in your reply.`] };
      } catch (error) {
        if (error instanceof OperationError) return { ok: false, error: error.message };
        throw error;
      }
    },
  };
}

/** One stateless turn: the model over the snapshot, returning what the phone may commit. */
export async function runSnapshotTurn(
  provider: ToolProvider,
  request: AgentTurnRequest,
  bundle: AnalysisBundle | undefined,
  userId?: string,
): Promise<Proposal> {
  const turn = createSnapshotContext(request, bundle, userId);
  const toolRegistry = toolsFor(turn.available)
    .map((tool) => (tool.name === 'undo' || tool.name === 'redo' ? asDeviceCommandTool(tool) : tool));
  const response = await runAgentLoop(provider, turn.ctx, request.message, { toolRegistry });
  return proposalSchema.parse({
    id: request.proposalId,
    projectId: request.snapshot.project.id,
    baseRevision: request.snapshot.project.version,
    ops: turn.ops,
    deviceCommands: turn.deviceCommands,
    expectedHash: projectHash(turn.project()),
    status: 'proposed',
    reply: response.reply,
    trace: response.trace,
  });
}
