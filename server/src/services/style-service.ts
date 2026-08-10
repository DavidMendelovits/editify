import { randomUUID } from 'node:crypto';
import type { Project } from '@editify/shared';
import type { AgentService } from '../agent/service.js';
import type { AssetStore } from '../db/asset-store.js';
import type { EditifyDatabase } from '../db/database.js';
import { analyzeLoudness, analyzeScenes } from '../media/process.js';

export interface StyleMetric {
  assetId: string;
  duration: number;
  cutCount: number;
  cutDensity: number;
  averageShotLength: number;
  loudnessLufs: number | null;
  width: number;
  height: number;
  format: string;
}

export interface StyleProfile {
  id: string;
  assetIds: string[];
  metrics: StyleMetric[];
  styleDoc: string;
  createdAt: string;
}

const emptyProject: Project = {
  id: 'style-analysis', title: 'Style analysis', format: '9:16', fps: 30,
  duration: 0, version: 0, tracks: [],
};

export class StyleService {
  constructor(
    private readonly database: EditifyDatabase,
    private readonly assets: AssetStore,
    private readonly agent: AgentService,
  ) {}

  async analyze(assetIds: string[]): Promise<StyleProfile> {
    const metrics: StyleMetric[] = [];
    for (const assetId of assetIds) {
      const asset = this.assets.get(assetId);
      if (!asset) throw new Error(`Asset ${assetId} was not found`);
      const scenes = await analyzeScenes(asset.originalPath, asset.duration);
      const loudnessLufs = asset.hasAudio ? await analyzeLoudness(asset.originalPath) : null;
      metrics.push({
        assetId,
        duration: asset.duration,
        ...scenes,
        loudnessLufs,
        width: asset.width,
        height: asset.height,
        format: asset.width === asset.height ? '1:1' : asset.height > asset.width ? '9:16' : '16:9',
      });
    }
    const fallback = summarizeLocally(metrics);
    let styleDoc = fallback;
    try {
      styleDoc = await this.agent.distillStyle(emptyProject, metrics) || fallback;
    } catch {
      styleDoc = fallback;
    }
    const profile: StyleProfile = { id: randomUUID(), assetIds, metrics, styleDoc, createdAt: new Date().toISOString() };
    this.database.prepare(`
      INSERT INTO style_profiles (id, asset_ids_json, metrics_json, style_doc, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(profile.id, JSON.stringify(assetIds), JSON.stringify(metrics), styleDoc, profile.createdAt);
    return profile;
  }

  latest(): StyleProfile | undefined {
    const row = this.database.prepare(`
      SELECT id, asset_ids_json, metrics_json, style_doc, created_at
      FROM style_profiles ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; asset_ids_json: string; metrics_json: string; style_doc: string; created_at: string } | undefined;
    return row ? {
      id: row.id,
      assetIds: JSON.parse(row.asset_ids_json) as string[],
      metrics: JSON.parse(row.metrics_json) as StyleMetric[],
      styleDoc: row.style_doc,
      createdAt: row.created_at,
    } : undefined;
  }
}

function summarizeLocally(metrics: StyleMetric[]): string {
  const averageShot = metrics.reduce((sum, metric) => sum + metric.averageShotLength, 0) / metrics.length;
  const loudness = metrics.filter((metric) => metric.loudnessLufs !== null).map((metric) => metric.loudnessLufs as number);
  const averageLoudness = loudness.length ? loudness.reduce((sum, value) => sum + value, 0) / loudness.length : null;
  const pacing = averageShot < 2 ? 'fast-punch' : averageShot < 4 ? 'balanced' : 'slow-burn';
  return `${pacing} pacing, about ${averageShot.toFixed(1)}s per shot, ${averageLoudness !== null && averageLoudness > -16 ? 'loud, present audio' : 'controlled audio'}, and bold readable captions.`;
}
