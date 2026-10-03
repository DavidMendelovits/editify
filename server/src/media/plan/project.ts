import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildRenderPlan,
  exportPlanSize,
  type PlanAssetInfo,
  type PlanResolution,
  type Project,
  type RenderPlan,
} from '@editify/shared';
import type { AssetStore, StoredAsset } from '../../db/asset-store.js';
import { rendersRoot } from '../../config.js';
import type { HdrHandling } from '../color.js';
import { isHdrTransfer, transferKind } from './color.js';
import { probePlanMedia, type PlanMediaProbe } from './media.js';
import { renderPlan, type RenderPlanResult } from './render.js';

/**
 * The RENDER_PLAN export path for a stored project: build the RenderPlan the
 * phone would build (target export, the request's size, colour and
 * loudness), then render it with renderPlan.
 *
 * SECURITY (RenderPlan MEDIA): every asset id resolves only through the
 * project — linked to it (or a library sound) and visible to the project's
 * owner, the same scoping as the asset routes — never by bare id.
 */

export interface PlanRenderOptions {
  hdr: HdrHandling;
  loudness: 'normalize' | 'off';
  /** The project owner (ProjectStore.ownerId): null for an unowned project, which then sees only its own links. */
  ownerId: string | null | undefined;
}

export interface ProjectPlanRender extends RenderPlanResult {
  plan: RenderPlan;
}

function assetKind(asset: StoredAsset): PlanAssetInfo['kind'] {
  if (asset.mimeType.startsWith('video/')) return 'video';
  if (asset.mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

export async function renderProjectFromPlan(
  project: Project,
  resolution: PlanResolution,
  renderId: string,
  assets: Pick<AssetStore, 'getInProject'>,
  options: PlanRenderOptions,
): Promise<ProjectPlanRender> {
  const scoped = (id: string): StoredAsset | undefined => assets.getInProject(project.id, id, options.ownerId ?? undefined);
  const probes = new Map<string, PlanMediaProbe>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.assetId || probes.has(clip.assetId)) continue;
      const asset = scoped(clip.assetId);
      if (!asset) throw new Error(`Asset ${clip.assetId} referenced by clip ${clip.id} was not found`);
      probes.set(clip.assetId, await probePlanMedia(asset.originalPath, assetKind(asset)));
    }
  }
  // Legacy semantics for `hdr`: an HDR master only when some picture source is HDR.
  const anyHdr = [...probes.values()].some((probe) => probe.info.kind === 'video' && isHdrTransfer(transferKind(probe.color)));
  const plan = buildRenderPlan(project, {
    kind: 'export',
    size: exportPlanSize(project.format, resolution),
    // RenderPlan v1 has whole-number frame rates; a fractional project rate renders at the nearest one.
    fps: Math.max(1, Math.round(project.fps)),
    color: options.hdr === 'hdr' && anyHdr ? 'hlg' : 'sdr',
    loudness: options.loudness === 'normalize',
  }, {
    revision: project.version,
    buildSeq: 0,
    assetInfo: (id) => probes.get(id)?.info,
  });
  const directory = join(rendersRoot, renderId);
  await mkdir(directory, { recursive: true });
  const result = await renderPlan(plan, (ref) => scoped(ref.id)?.originalPath, {
    outputPath: join(directory, 'output.mp4'),
    workDir: join(directory, 'plan'),
  });
  return { ...result, plan };
}
