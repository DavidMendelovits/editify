import type { FastifyInstance } from 'fastify';
import {
  assetAvailabilityRequestSchema, newProjectSchema, operationBatchSchema, PLAN_LIMITS, projectHash, renderRequestSchema, syncAudioRequestSchema,
  type AssetAvailabilityResponse, type Project, type RenderSnapshot,
} from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import { assetIds, type ProjectStore } from '../db/project-store.js';
import { assetAvailability, idsWith } from '../services/asset-availability.js';
import { OperationError, applyBatch, assertNoNewVideoOverlap } from '../operations/apply.js';
import {
  SILENCE_DEFAULTS,
  audibleWindows,
  buildTimelineTranscript,
  planFillerRanges,
  planSilenceRanges,
  silenceSources,
  totalRangeSeconds,
  unionRanges,
  type CleanupRange,
} from '../services/cleanup.js';
import type { RenderQueue } from '../services/render-queue.js';
import type { SyncService } from '../services/sync-service.js';
import type { TranscriptService } from '../services/transcript-service.js';
import { SYNC_BODY_LIMIT } from './sync.js';

/** A render request carries at most one project document, capped like a sync push. */
export const RENDER_BODY_LIMIT = SYNC_BODY_LIMIT;
/** 1000 ids of up to 128 characters, with room to spare. */
const AVAILABILITY_BODY_LIMIT = 256 * 1024;
/** A snapshot is replayed with no ops; nothing may mint an id. */
const noNewIds = { newId: (): string => { throw new OperationError('A snapshot carries every id'); } };

export function registerProjectRoutes(
  app: FastifyInstance,
  projects: ProjectStore,
  renderQueue: RenderQueue,
  assets: AssetStore,
  transcripts: TranscriptService,
  syncs: SyncService,
): void {
  app.post('/projects', async (request, reply) => {
    const input = newProjectSchema.parse(request.body ?? {});
    return await reply.code(201).send(projects.create(input, request.userId));
  });

  app.get('/projects', async (request) => projects.list(request.userId));

  app.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    return project ?? await reply.code(404).send({ error: 'Project not found' });
  });

  app.delete<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    if (!await projects.delete(request.params.id, request.userId)) {
      return await reply.code(404).send({ error: 'Project not found' });
    }
    return await reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/projects/:id/ops', async (request, reply) => {
    const batch = operationBatchSchema.parse(request.body);
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    return projects.applyOperations(project.id, batch.ops, batch.baseVersion);
  });

  /** Undo one whole agent turn — the Revert under a chat reply. */
  app.post<{ Params: { id: string; runId: string } }>('/projects/:id/runs/:runId/revert', async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    try {
      return projects.applyOperations(
        project.id,
        [{ type: 'revert_run', params: { runId: request.params.runId } }],
        project.version,
      );
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return await reply.code(409).send({ error: error.message });
    }
  });

  /** Drives the editor's undo/redo buttons: cheap enough to refetch after every edit. */
  app.get<{ Params: { id: string } }>('/projects/:id/history', async (request, reply) => {
    if (!projects.get(request.params.id, request.userId)) return await reply.code(404).send({ error: 'Project not found' });
    return projects.history(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/projects/:id/oplog', async (request, reply) => {
    if (!projects.get(request.params.id, request.userId)) return await reply.code(404).send({ error: 'Project not found' });
    return projects.operationLog(request.params.id);
  });

  // Read-only measurement for one-tap cleanup: it never mutates the project.
  // The client applies whichever ranges it wants as a ripple_delete_ranges op.
  app.get<{ Params: { id: string } }>('/projects/:id/cleanup', async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const track = project.tracks.find((candidate) => candidate.kind === 'video');
    if (!track) return await reply.code(404).send({ error: 'Project has no video track' });
    const timeline = buildTimelineTranscript(project, (assetId) => transcripts.getForTimeline(assetId));
    const transcribed = audibleWindows(project, (assetId) => Boolean(transcripts.getForTimeline(assetId))).length > 0;
    const fillers = planFillerRanges(project, timeline.words);
    // Measuring must never fail the whole answer: an asset whose energy has not
    // been analysed yet needs ffmpeg, and filler counts are still useful without it.
    const silences = await planSilenceRanges(project, timeline.words, silenceSources(assets, transcripts), SILENCE_DEFAULTS)
      .catch(() => ({ rangesByTrack: new Map<string, CleanupRange[]>() }));
    // One ripple on the video track removes the time from every track, memo included.
    const fillerRanges = unionRanges(fillers.rangesByTrack);
    const silenceRanges = unionRanges(silences.rangesByTrack);
    return {
      transcribed,
      fillers: { ranges: fillerRanges, words: fillers.matched, seconds: totalRangeSeconds(fillerRanges) },
      silences: { ranges: silenceRanges, seconds: totalRangeSeconds(silenceRanges) },
      trackId: track.id,
    };
  });

  // Read-only like /cleanup: it measures and returns the edit, and the client
  // applies it through its own op chain so undo and version checks stay theirs.
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/projects/:id/sync', async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    // Not strict here: the query also carries `?k=` when a client authenticates that way.
    const input = syncAudioRequestSchema.strip().parse(request.query);
    return await syncs.plan(project, input, request.userId);
  });

  /**
   * Whether the server holds each original the phone's document names (plan OV1), so the
   * phone offers a server render only when it can succeed, or names the clips to upload.
   * Only answers for this user: another account's asset is `forbidden`, never described.
   */
  app.post<{ Params: { id: string } }>('/projects/:id/assets/availability', { bodyLimit: AVAILABILITY_BODY_LIMIT }, async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const { assetIds: ids } = assetAvailabilityRequestSchema.parse(request.body);
    const availability = await assetAvailability(assets, ids, request.userId);
    const response: AssetAvailabilityResponse = { assets: [...availability].map(([id, status]) => ({ id, status })) };
    return response;
  });

  type SnapshotCheck = { ok: true; snapshot: RenderSnapshot } | { ok: false; status: number; body: Record<string, unknown> };

  /**
   * Checks a snapshot before it is queued, and answers the document to render:
   * - normalized the way a sync create is (applyBatch with no ops: schema defaults, the
   *   duration derived from the clips, never the client's), then hashed: `hash` must match
   *   (renderSnapshot on the phone normalizes the same way);
   * - this project's, at `revision`, no longer than PLAN_LIMITS.durationSec, and adding no
   *   video overlap the stored project doesn't already have;
   * - naming only this user's assets (or the sound library) with their originals here.
   * An owned asset the project never linked is linked, so the render's project scoping
   * (RenderPlan MEDIA) resolves it.
   */
  async function checkSnapshot(stored: Project, sent: RenderSnapshot, userId: string | undefined): Promise<SnapshotCheck> {
    const refuse = (status: number, error: string, code: string, extra: Record<string, unknown> = {}): SnapshotCheck => (
      { ok: false, status, body: { error, code, ...extra } }
    );
    if (sent.project.id !== stored.id) return refuse(400, 'The snapshot is of another project', 'project');
    if (sent.project.version !== sent.revision) return refuse(400, 'The snapshot revision does not match its document', 'revision');
    let project: Project;
    try {
      project = { ...applyBatch(sent.project, [], noNewIds), version: sent.revision };
      assertNoNewVideoOverlap(stored, project);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return refuse(400, error.message, 'invalid');
    }
    if (projectHash(project) !== sent.hash) return refuse(400, 'The snapshot does not match its hash', 'hash');
    if (project.duration > PLAN_LIMITS.durationSec) return refuse(400, 'The timeline is longer than 4 hours', 'too_long');
    const availability = await assetAvailability(assets, assetIds(project), userId);
    const forbidden = idsWith(availability, 'forbidden');
    if (forbidden.length) return refuse(403, 'The snapshot uses media from another account', 'forbidden', { assetIds: forbidden });
    // Absent first: no upload can fix those, so the phone shouldn't be offered one.
    const absent = idsWith(availability, 'absent');
    if (absent.length) return refuse(409, 'Some media is not on the server; import it again', 'absent', { assetIds: absent });
    const missing = idsWith(availability, 'missing');
    if (missing.length) return refuse(409, 'Some originals are not on the server', 'missing', { assetIds: missing });
    for (const id of availability.keys()) if (!assets.linkedOrSound(stored.id, id)) assets.link(stored.id, id);
    return { ok: true, snapshot: { ...sent, project } };
  }

  app.post<{ Params: { id: string } }>('/projects/:id/render', { bodyLimit: RENDER_BODY_LIMIT }, async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const { resolution: requested, hdr, loudness, snapshot: sent } = renderRequestSchema.parse(request.body ?? {});
    let snapshot: RenderSnapshot | undefined;
    if (sent) {
      const checked = await checkSnapshot(project, sent, request.userId);
      if (!checked.ok) return await reply.code(checked.status).send(checked.body);
      snapshot = checked.snapshot;
    }
    // A 4K encode can run the single 4 GB server out of memory, but shipped app
    // builds still offer 4K, so rejecting it would surface as an error. Export
    // 1080p instead and record that on the render row, which is what the
    // client reads back from GET /renders/:id.
    const resolution = requested === '4k' ? '1080p' : requested;
    if (resolution !== requested) {
      request.log.info({ projectId: project.id, requested, resolution }, 'Clamped render resolution');
    }
    return await reply.code(202).send(renderQueue.enqueue(project.id, resolution, hdr, loudness, snapshot));
  });
}
