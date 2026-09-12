import { randomUUID } from 'node:crypto';
import type { Project } from '@editify/shared';
import type { AgentService } from '../agent/service.js';
import type { AssetStore } from '../db/asset-store.js';
import type { EditifyDatabase } from '../db/database.js';
import { SettingsStore } from '../db/settings-store.js';
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
  name: string;
  assetIds: string[];
  metrics: StyleMetric[];
  styleDoc: string;
  createdAt: string;
}

/** Run state of the background analysis; `error` is set only when status is 'error'. */
export interface StyleRunState { status: 'idle' | 'processing' | 'error'; error?: string }

/** Settings key holding the id of the profile every edit conversation uses. */
const SELECTED_KEY = 'selected_style_profile';

const selectColumns = 'id, name, asset_ids_json, metrics_json, style_doc, created_at';

interface StyleRow { id: string; name: string | null; asset_ids_json: string; metrics_json: string; style_doc: string; created_at: string }

const emptyProject: Project = {
  id: 'style-analysis', title: 'Style analysis', format: '9:16', fps: 30,
  duration: 0, version: 0, tracks: [],
};

export class StyleService {
  // ponytail: in-memory job state, lost on restart — client just re-triggers
  private run: StyleRunState = { status: 'idle' };
  private inFlight: Promise<void> | null = null;
  private readonly settings: SettingsStore;

  constructor(
    private readonly database: EditifyDatabase,
    private readonly assets: AssetStore,
    private readonly agent: AgentService,
  ) { this.settings = new SettingsStore(database); }

  /** The first unknown id, so a route can 4xx before any ffmpeg work starts. */
  missingAsset(assetIds: string[]): string | undefined {
    return assetIds.find((assetId) => !this.assets.get(assetId));
  }

  state(): StyleRunState {
    return this.run;
  }

  /**
   * Starts an analysis in the background and reports the run state right away.
   * A second call while one is running joins the live run instead of starting a
   * rival scan — the client is polling anyway, so it just keeps waiting (the
   * newly requested assetIds are ignored; re-trigger once the run settles).
   * Validate ids with `missingAsset` first: unknown ones fail the run, not the call.
   */
  start(assetIds: string[], name?: string): StyleRunState {
    if (!this.inFlight) {
      this.run = { status: 'processing' };
      this.inFlight = this.analyze(assetIds, name)
        .then(() => { this.run = { status: 'idle' }; })
        .catch((error: unknown) => {
          this.run = { status: 'error', error: error instanceof Error ? error.message : String(error) };
        })
        .finally(() => { this.inFlight = null; });
    }
    return this.run;
  }

  /** The new profile becomes the selected one; an unnamed run gets `Style N`. */
  async analyze(assetIds: string[], name?: string): Promise<StyleProfile> {
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
    const profile: StyleProfile = {
      id: randomUUID(), name: name ?? this.nextName(), assetIds, metrics, styleDoc,
      createdAt: new Date().toISOString(),
    };
    this.database.prepare(`
      INSERT INTO style_profiles (id, name, asset_ids_json, metrics_json, style_doc, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(profile.id, profile.name, JSON.stringify(assetIds), JSON.stringify(metrics), styleDoc, profile.createdAt);
    this.settings.set(SELECTED_KEY, profile.id);
    return profile;
  }

  /** Every saved profile, newest first. */
  list(): StyleProfile[] {
    const rows = this.database.prepare(`SELECT ${selectColumns} FROM style_profiles ORDER BY created_at DESC, rowid DESC`).all() as StyleRow[];
    return rows.map(toProfile);
  }

  selectedId(): string | undefined {
    return this.selected()?.id;
  }

  /** The pointed-at profile, falling back to the newest when the pointer is stale. */
  selected(): StyleProfile | undefined {
    const id = this.settings.get(SELECTED_KEY);
    return (id ? this.get(id) : undefined) ?? this.newest();
  }

  /** Kept for the chat route, which only ever wants the profile in force. */
  latest(): StyleProfile | undefined {
    return this.selected();
  }

  get(id: string): StyleProfile | undefined {
    const row = this.database.prepare(`SELECT ${selectColumns} FROM style_profiles WHERE id = ?`).get(id) as StyleRow | undefined;
    return row ? toProfile(row) : undefined;
  }

  select(id: string): StyleProfile | undefined {
    const profile = this.get(id);
    if (profile) this.settings.set(SELECTED_KEY, id);
    return profile;
  }

  rename(id: string, name: string): StyleProfile | undefined {
    if (!this.get(id)) return undefined;
    this.database.prepare('UPDATE style_profiles SET name = ? WHERE id = ?').run(name, id);
    return this.get(id);
  }

  /** A copy of the measurements under a new id; the original stays selected. */
  duplicate(id: string): StyleProfile | undefined {
    const source = this.get(id);
    if (!source) return undefined;
    const copy: StyleProfile = { ...source, id: randomUUID(), name: `${source.name} copy`, createdAt: new Date().toISOString() };
    this.database.prepare(`
      INSERT INTO style_profiles (id, name, asset_ids_json, metrics_json, style_doc, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(copy.id, copy.name, JSON.stringify(copy.assetIds), JSON.stringify(copy.metrics), copy.styleDoc, copy.createdAt);
    return copy;
  }

  /** Deleting the selected profile repoints the setting at whatever is left. */
  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.database.prepare('DELETE FROM style_profiles WHERE id = ?').run(id);
    if (this.settings.get(SELECTED_KEY) === id) this.settings.set(SELECTED_KEY, this.newest()?.id ?? '');
    return true;
  }

  private newest(): StyleProfile | undefined {
    const row = this.database.prepare(`SELECT ${selectColumns} FROM style_profiles ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as StyleRow | undefined;
    return row ? toProfile(row) : undefined;
  }

  private nextName(): string {
    const { count } = this.database.prepare('SELECT COUNT(*) AS count FROM style_profiles').get() as { count: number };
    return `Style ${count + 1}`;
  }
}

function toProfile(row: StyleRow): StyleProfile {
  return {
    id: row.id,
    name: row.name ?? `Style ${row.created_at.slice(0, 10)}`,
    assetIds: JSON.parse(row.asset_ids_json) as string[],
    metrics: JSON.parse(row.metrics_json) as StyleMetric[],
    styleDoc: row.style_doc,
    createdAt: row.created_at,
  };
}

function summarizeLocally(metrics: StyleMetric[]): string {
  const averageShot = metrics.reduce((sum, metric) => sum + metric.averageShotLength, 0) / metrics.length;
  const loudness = metrics.filter((metric) => metric.loudnessLufs !== null).map((metric) => metric.loudnessLufs as number);
  const averageLoudness = loudness.length ? loudness.reduce((sum, value) => sum + value, 0) / loudness.length : null;
  const pacing = averageShot < 2 ? 'fast-punch' : averageShot < 4 ? 'balanced' : 'slow-burn';
  return `${pacing} pacing, about ${averageShot.toFixed(1)}s per shot, ${averageLoudness !== null && averageLoudness > -16 ? 'loud, present audio' : 'controlled audio'}, and bold readable captions.`;
}
