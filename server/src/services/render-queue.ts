import type { AssetStore } from '../db/asset-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { RenderRecord, RenderStore } from '../db/render-store.js';
import { renderProject } from '../media/render.js';

export class RenderQueue {
  private readonly pending: string[] = [];
  private working = false;

  constructor(
    private readonly renders: RenderStore,
    private readonly projects: ProjectStore,
    private readonly assets: AssetStore,
  ) {}

  enqueue(projectId: string, resolution: RenderRecord['resolution']): RenderRecord {
    const render = this.renders.create(projectId, resolution);
    this.pending.push(render.id);
    void this.drain();
    return render;
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
        this.renders.update(id, 'processing');
        try {
          const outputPath = await renderProject(project, record.resolution, id, this.assets);
          this.renders.update(id, 'done', { outputPath });
        } catch (error) {
          this.renders.update(id, 'error', { error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      this.working = false;
    }
  }
}
