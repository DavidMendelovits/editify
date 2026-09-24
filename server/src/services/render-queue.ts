import type { AssetStore } from '../db/asset-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { RenderRecord, RenderStore } from '../db/render-store.js';
import type { HdrHandling } from '../media/color.js';
import { renderProject } from '../media/render.js';
import { withMediaSlot } from './media-slots.js';
import { runRenderQa, type LoudnessMode } from './render-qa.js';

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
  ): RenderRecord {
    const render = this.renders.create(projectId, resolution);
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
        const project = record ? this.projects.get(record.projectId) : undefined;
        if (!record || !project) {
          this.renders.update(id, 'error', { error: 'Project was not found' });
          continue;
        }
        // The project is read here, not at enqueue, so this is the version the file shows.
        this.renders.update(id, 'processing', { projectVersion: project.version });
        try {
          // Queued renders stay serial here; the shared pool additionally keeps
          // this one from stacking on top of two import encodes.
          const outputPath = await withMediaSlot(`render ${id}`, () =>
            renderProject(project, record.resolution, id, this.assets, this.hdrById.get(id) ?? 'sdr'));
          // QA runs before 'done' because normalizing rewrites the file a client would download.
          // A QA failure is reported on the record, never as a failed render.
          const qa = await runRenderQa(outputPath, project, this.assets, this.loudnessById.get(id) ?? 'normalize')
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
