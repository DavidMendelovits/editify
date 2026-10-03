import type { FastifyInstance } from 'fastify';
import {
  assetAvailabilityRequestSchema, newProjectSchema, operationBatchSchema, projectHash, renderRequestSchema, syncAudioRequestSchema,
  type AssetAvailabilityResponse, type RenderSnapshot,
} from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import { assetIds, type ProjectStore } from '../db/project-store.js';
import { assetAvailability, idsWith } from '../services/asset-availability.js';
import { OperationError } from '../operations/apply.js';
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
  app.post<{ Params: { id: string } }>('/projects/:id/assets/availability', async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const { assetIds: ids } = assetAvailabilityRequestSchema.parse(request.body);
    const availability = await assetAvailability(assets, ids, request.userId);
    const response: AssetAvailabilityResponse = { assets: [...availability].map(([id, status]) => ({ id, status })) };
    return response;
  });

  /**
   * Checks a snapshot before it is queued: the document is this project's at `revision`,
   * hashes to `hash`, and every asset it names is this user's (or the sound library) with
   * its original on the server. An owned asset the project never linked is linked here,
   * so the render's project scoping (RenderPlan MEDIA) resolves it. Answers the refusal,
   * or null when the snapshot can be rendered.
   */
  async function refuseSnapshot(projectId: string, snapshot: RenderSnapshot, userId: string | undefined): Promise<{ status: number; body: Record<string, unknown> } | null> {
    if (snapshot.project.id !== projectId) return { status: 400, body: { error: 'The snapshot is of another project', code: 'project' } };
    if (snapshot.project.version !== snapshot.revision) {
      return { status: 400, body: { error: 'The snapshot revision does not match its document', code: 'revision' } };
    }
    if (projectHash(snapshot.project) !== snapshot.hash) {
      return { status: 400, body: { error: 'The snapshot does not match its hash', code: 'hash' } };
    }
    const availability = await assetAvailability(assets, assetIds(snapshot.project), userId);
    const forbidden = idsWith(availability, 'forbidden');
    if (forbidden.length) return { status: 403, body: { error: 'The snapshot uses media from another account', code: 'forbidden', assetIds: forbidden } };
    const missing = idsWith(availability, 'missing');
    if (missing.length) return { status: 409, body: { error: 'Some originals are not on the server', code: 'missing', assetIds: missing } };
    for (const id of availability.keys()) if (!assets.linkedOrSound(projectId, id)) assets.link(projectId, id);
    return null;
  }

  app.post<{ Params: { id: string } }>('/projects/:id/render', { bodyLimit: RENDER_BODY_LIMIT }, async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const { resolution: requested, hdr, loudness, snapshot } = renderRequestSchema.parse(request.body ?? {});
    if (snapshot) {
      const refused = await refuseSnapshot(project.id, snapshot, request.userId);
      if (refused) return await reply.code(refused.status).send(refused.body);
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
