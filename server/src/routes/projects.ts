import type { FastifyInstance } from 'fastify';
import { newProjectSchema, operationBatchSchema, renderRequestSchema, syncAudioRequestSchema } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import type { ProjectStore } from '../db/project-store.js';
import { OperationError } from '../operations/apply.js';
import {
  SILENCE_DEFAULTS,
  buildTimelineTranscript,
  planFillerRanges,
  planSilenceRanges,
  totalRangeSeconds,
  type CleanupRange,
} from '../services/cleanup.js';
import type { RenderQueue } from '../services/render-queue.js';
import type { SyncService } from '../services/sync-service.js';
import type { TranscriptService } from '../services/transcript-service.js';

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
    const timeline = buildTimelineTranscript(project, (assetId) => transcripts.get(assetId));
    const transcribed = track.clips.some((clip) => clip.assetId && transcripts.get(clip.assetId));
    const fillers = planFillerRanges(project, timeline.words);
    // Measuring must never fail the whole answer: an asset whose energy has not
    // been analysed yet needs ffmpeg, and filler counts are still useful without it.
    const silences = await planSilenceRanges(project, timeline.words, { assets, transcripts }, SILENCE_DEFAULTS)
      .catch(() => ({ rangesByTrack: new Map<string, CleanupRange[]>() }));
    const fillerRanges = fillers.rangesByTrack.get(track.id) ?? [];
    const silenceRanges = silences.rangesByTrack.get(track.id) ?? [];
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

  app.post<{ Params: { id: string } }>('/projects/:id/render', async (request, reply) => {
    const project = projects.get(request.params.id, request.userId);
    if (!project) return await reply.code(404).send({ error: 'Project not found' });
    const { resolution, hdr } = renderRequestSchema.parse(request.body ?? {});
    return await reply.code(202).send(renderQueue.enqueue(project.id, resolution, hdr));
  });
}
