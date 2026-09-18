import { randomUUID } from 'node:crypto';
import type { Project } from '@editify/shared';
import type { AgentService } from '../agent/service.js';
import type { AssetStore } from '../db/asset-store.js';
import type { EditifyDatabase } from '../db/database.js';
import { SettingsStore } from '../db/settings-store.js';
import type { StyleMetric, StyleTemplate, VideoObservation } from '../style/observation.js';
import { ObservationCache } from '../style/observation-cache.js';
import { runStylePipeline, type PipelineProgress } from '../style/pipeline.js';
import { StyleAnalyzerRegistry } from '../style/registry.js';

export type { StyleMetric } from '../style/observation.js';

export interface StyleProfile {
  id: string;
  name: string;
  assetIds: string[];
  metrics: StyleMetric[];
  styleDoc: string;
  createdAt: string;
  /** Id of the analyzer that watched the videos; 'ffmpeg' for metric-only and legacy rows. */
  analyzer: string;
  /** One structured row per video, straight from the analyzer. */
  observations: VideoObservation[];
  /** The observations folded into one reusable template; null on legacy rows. */
  template: StyleTemplate | null;
}

/**
 * Run state of the background analysis; `error` is set only when status is
 * 'error', `progress` only while processing.
 */
export interface StyleRunState { status: 'idle' | 'processing' | 'error'; error?: string; progress?: PipelineProgress }

export interface StyleRunOptions { name?: string; analyzer?: string; refresh?: boolean }

/** Settings key holding the id of the profile every edit conversation uses. */
const SELECTED_KEY = 'selected_style_profile';

const selectColumns = 'id, name, asset_ids_json, metrics_json, style_doc, created_at, analyzer, observations_json, template_json';
const insertColumns = 'id, name, asset_ids_json, metrics_json, style_doc, created_at, analyzer, observations_json, template_json';

interface StyleRow {
  id: string; name: string | null; asset_ids_json: string; metrics_json: string; style_doc: string; created_at: string;
  analyzer: string | null; observations_json: string | null; template_json: string | null;
}

const emptyProject: Project = {
  id: 'style-analysis', title: 'Style analysis', format: '9:16', fps: 30,
  duration: 0, version: 0, tracks: [],
};

export class StyleService {
  // ponytail: in-memory job state, lost on restart — client just re-triggers
  private run: StyleRunState = { status: 'idle' };
  private inFlight: Promise<void> | null = null;
  private readonly settings: SettingsStore;
  private readonly cache: ObservationCache;
  /** The pluggable "watch" step; the route exposes it so the UI can pick one. */
  readonly analyzers: StyleAnalyzerRegistry;

  constructor(
    private readonly database: EditifyDatabase,
    private readonly assets: AssetStore,
    private readonly agent: AgentService,
    analyzers?: StyleAnalyzerRegistry,
  ) {
    this.settings = new SettingsStore(database);
    this.cache = new ObservationCache(database);
    this.analyzers = analyzers ?? new StyleAnalyzerRegistry(this.settings);
  }

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
  start(assetIds: string[], options: StyleRunOptions = {}): StyleRunState {
    if (!this.inFlight) {
      this.run = { status: 'processing' };
      this.inFlight = this.analyze(assetIds, options)
        .then(() => { this.run = { status: 'idle' }; })
        .catch((error: unknown) => {
          this.run = { status: 'error', error: error instanceof Error ? error.message : String(error) };
        })
        .finally(() => { this.inFlight = null; });
    }
    return this.run;
  }

  /**
   * The whole workflow for one profile: resolve the analyzer, run the pipeline
   * (measure, watch, aggregate, distill), store the result. The new profile
   * becomes the selected one; an unnamed run gets `Style N`.
   */
  async analyze(assetIds: string[], options: StyleRunOptions | string = {}): Promise<StyleProfile> {
    const { name, refresh, analyzer: analyzerId } = typeof options === 'string' ? { name: options } : options;
    const videos = assetIds.map((assetId) => {
      const asset = this.assets.get(assetId);
      if (!asset) throw new Error(`Asset ${assetId} was not found`);
      return asset;
    });
    const analyzer = analyzerId ? this.analyzers.get(analyzerId) : await this.analyzers.resolve();
    if (!analyzer) throw new Error(`Analyzer ${analyzerId} was not found`);
    const result = await runStylePipeline({
      videos,
      analyzer,
      cache: this.cache,
      ...(refresh ? { refresh } : {}),
      distill: async (template, observations) => await this.agent.distillStyle(emptyProject, template, observations, template.watchedCount > 0),
      onProgress: (progress) => { if (this.run.status === 'processing') this.run = { status: 'processing', progress }; },
    });
    const profile: StyleProfile = {
      id: randomUUID(), name: name ?? this.nextName(), assetIds, metrics: result.metrics, styleDoc: result.styleDoc,
      createdAt: new Date().toISOString(), analyzer: result.analyzer, observations: result.observations, template: result.template,
    };
    this.insert(profile);
    this.settings.set(SELECTED_KEY, profile.id);
    return profile;
  }

  private insert(profile: StyleProfile): void {
    this.database.prepare(`INSERT INTO style_profiles (${insertColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      profile.id, profile.name, JSON.stringify(profile.assetIds), JSON.stringify(profile.metrics), profile.styleDoc,
      profile.createdAt, profile.analyzer, JSON.stringify(profile.observations), profile.template ? JSON.stringify(profile.template) : null,
    );
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
    this.insert(copy);
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
    analyzer: row.analyzer ?? 'ffmpeg',
    observations: row.observations_json ? JSON.parse(row.observations_json) as VideoObservation[] : [],
    template: row.template_json ? JSON.parse(row.template_json) as StyleTemplate : null,
  };
}
