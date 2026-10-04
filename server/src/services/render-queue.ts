import type { Project, RenderSnapshot } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { RenderRecord, RenderStore } from '../db/render-store.js';
import type { HdrHandling } from '../media/color.js';
import { renderPlanEnabled } from '../config.js';
import { renderProjectFromPlan } from '../media/plan/project.js';
import { PlanRenderUnavailableError } from '../media/plan/render.js';
import { renderProject } from '../media/render.js';
import { slotMediaJob } from './media-jobs.js';
import { runRenderQa, type LoudnessMode, type PlannedQa } from './render-qa.js';

export class RenderQueue {
  private readonly pending: string[] = [];
  /** The colour target is not persisted, so a render recovered after a restart falls back to SDR. */
  private readonly hdrById = new Map<string, HdrHandling>();
  /** Not persisted either: a recovered render normalizes, the default. */
  private readonly loudnessById = new Map<string, LoudnessMode>();
  private working = false;

  constructor(
    private readonly renders: RenderStore,
    private readonly projects: ProjectStore,
    private readonly assets: AssetStore,
  ) {}

  enqueue(
    projectId: string,
    resolution: RenderRecord['resolution'],
    hdr: HdrHandling = 'sdr',
    loudness: LoudnessMode = 'normalize',
    snapshot?: RenderSnapshot,
  ): RenderRecord {
    // A snapshot (plan OV1) is validated by the route and stored with the render, so the
    // job renders exactly that document, even after a restart.
    const render = this.renders.create(projectId, resolution, snapshot);
    this.hdrById.set(render.id, hdr);
    this.loudnessById.set(render.id, loudness);
    this.pending.push(render.id);
    // A store failure outside drain's inner try must not become an unhandled
    // rejection (which kills the process); mark the head render failed instead.
    this.drain().catch((error: unknown) => {
      this.renders.update(render.id, 'error', { error: error instanceof Error ? error.message : String(error) });
    });
    return render;
  }

  // The queue only exists in memory, so a restart strands rows left at
  // 'queued'/'processing'. Re-running a 'processing' render is safe: output
  // paths are keyed by render id and overwriting is fine.
  recover(): void {
    const records = this.renders.unfinished();
    for (const record of records) {
      this.renders.update(record.id, 'queued');
      this.pending.push(record.id);
    }
    const head = records[0];
    if (!head) return;
    this.drain().catch((error: unknown) => {
      this.renders.update(head.id, 'error', { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.pending.length) {
        const id = this.pending.shift();
        if (!id) continue;
        const record = this.renders.get(id);
        let project: Project | undefined;
        try {
          // A snapshot render takes the document it was sent; otherwise the stored project is
          // read here, not at enqueue, so this is the version the file shows.
          project = record ? this.renders.snapshotProject(id) ?? this.projects.get(record.projectId) : undefined;
        } catch {
          this.renders.update(id, 'error', { error: 'The project snapshot could not be read' });
          continue;
        }
        if (!record || !project) {
          this.renders.update(id, 'error', { error: 'Project was not found' });
          continue;
        }
        this.renders.update(id, 'processing', { projectVersion: project.version });
        try {
          // Queued renders stay serial here; the shared pool additionally keeps
          // this one from stacking on top of two import encodes.
          const hdr = this.hdrById.get(id) ?? 'sdr';
          const loudness = this.loudnessById.get(id) ?? 'normalize';
          // RENDER_PLAN (plan P6): the shared RenderPlan drives the render, loudness included. Off: legacy
          // render.ts unchanged, the rollback path.
          // TODO(P6): delete transitions.ts, duck.ts and ass.ts's lane trimming once RENDER_PLAN defaults on.
          const usePlan = renderPlanEnabled();
          let planned: PlannedQa | undefined;
          // True when the plan render applied loudness itself (QA then only measures).
          let loudnessDone = false;
          const outputPath = await slotMediaJob('render', { projectId: project.id, renderId: id }, `render ${id}`, async () => {
            if (!usePlan) return await renderProject(project, record.resolution, id, this.assets, hdr);
            try {
              const result = await renderProjectFromPlan(project, record.resolution, id, this.assets, {
                hdr, loudness, ownerId: this.projects.ownerId(project.id),
              });
              const { decision, measuredLufs } = result.loudness;
              planned = {
                normalized: decision.gainDb !== 0 && measuredLufs !== null ? { fromLufs: measuredLufs, gainDb: decision.gainDb } : null,
                notes: result.notes,
              };
              loudnessDone = true;
              // The counterpart of the fallback's warning below: which path rendered this export shows in the logs.
              console.info('[render] rendered from the plan', { renderId: id, notes: result.notes.length });
              return result.outputPath;
            } catch (error) {
              // This server cannot run the plan render (an ffmpeg without a filter it needs, or a plan over the
              // memory budget): the legacy render is the export, and QA says why.
              if (!(error instanceof PlanRenderUnavailableError)) throw error;
              console.warn('[render] plan render unavailable, using legacy', { renderId: id, reason: error.message });
              planned = { normalized: null, notes: [`Rendered with the legacy renderer: ${error.message}`] };
              return await renderProject(project, record.resolution, id, this.assets, hdr);
            }
          });
          // QA runs before 'done' because legacy normalizing rewrites the file a client would download (the plan
          // path normalized inside the render, so QA only measures). A QA failure is reported on the record,
          // never as a failed render.
          const qa = await runRenderQa(outputPath, project, this.assets, loudnessDone ? 'off' : loudness, planned)
            .catch((error: unknown) => {
              console.warn('[render] QA failed', { renderId: id, error: error instanceof Error ? error.message : String(error) });
              return undefined;
            });
          if (qa) this.renders.setQa(id, qa);
          this.renders.update(id, 'done', { outputPath });
        } catch (error) {
          this.renders.update(id, 'error', { error: error instanceof Error ? error.message : String(error) });
        }
        this.hdrById.delete(id);
        this.loudnessById.delete(id);
      }
    } finally {
      this.working = false;
    }
  }
}
