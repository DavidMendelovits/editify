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

/** Settings key holding the id of the profile every edit conversation uses (per user). */
export const SELECTED_KEY = 'selected_style_profile';

const selectColumns = 'id, name, asset_ids_json, metrics_json, style_doc, created_at, analyzer, observations_json, template_json';
const insertColumns = 'id, name, asset_ids_json, metrics_json, style_doc, created_at, analyzer, observations_json, template_json';

interface StyleRow {
  id: string; name: string | null; asset_ids_json: string; metrics_json: string; style_doc: string; created_at: string;
  analyzer: string | null; observations_json: string | null; template_json: string | null;
}

/** Owner-only, like projects; `undefined` (shared token, local dev) sees every row. */
function owner(userId?: string): { sql: string; params: string[] } {
  return userId === undefined ? { sql: '1', params: [] } : { sql: 'user_id = ?', params: [userId] };
}

const emptyProject: Project = {
  id: 'style-analysis', title: 'Style analysis', format: '9:16', fps: 30,
  duration: 0, version: 0, tracks: [],
};

export class StyleService {
  // ponytail: in-memory job state per user (`userId ?? ''`), lost on restart — client just re-triggers
  private readonly runs = new Map<string, StyleRunState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Bumped by `forget`: a run started before it must not commit. */
  private readonly epochs = new Map<string, number>();
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

  /** The first unknown (or someone else's) id, so a route can 4xx before any ffmpeg work starts. */
  missingAsset(assetIds: string[], userId?: string): string | undefined {
    return assetIds.find((assetId) => !this.assets.get(assetId, userId));
  }

  state(userId?: string): StyleRunState {
    return this.runs.get(userId ?? '') ?? { status: 'idle' };
  }

  /** Account deletion: drop the user's run state, and let an in-flight run finish without saving. */
  forget(userId: string): void {
    this.epochs.set(userId, (this.epochs.get(userId) ?? 0) + 1);
    this.runs.delete(userId);
    this.inFlight.delete(userId);
  }

  /**
   * Starts an analysis in the background and reports the run state right away.
   * A second call from the same user while one is running joins the live run
   * instead of starting a rival scan — the client is polling anyway, so it just
   * keeps waiting (the newly requested assetIds are ignored; re-trigger once the
   * run settles). Another user's run is theirs alone.
   * Validate ids with `missingAsset` first: unknown ones fail the run, not the call.
   */
  start(assetIds: string[], options: StyleRunOptions = {}, userId?: string): StyleRunState {
    const key = userId ?? '';
    if (!this.inFlight.has(key)) {
      const epoch = this.epochs.get(key) ?? 0;
      // After `forget` the user is gone: nothing may write their state back.
      const current = () => (this.epochs.get(key) ?? 0) === epoch;
      this.runs.set(key, { status: 'processing' });
      this.inFlight.set(key, this.analyze(assetIds, options, userId)
        .then(() => { if (current()) this.runs.set(key, { status: 'idle' }); })
        .catch((error: unknown) => {
          if (current()) this.runs.set(key, { status: 'error', error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => { if (current()) this.inFlight.delete(key); }));
    }
    return this.state(userId);
  }

  /**
   * The whole workflow for one profile: resolve the analyzer, run the pipeline
   * (measure, watch, aggregate, distill), store the result. The new profile
   * becomes the selected one; an unnamed run gets `Style N`.
   */
  async analyze(assetIds: string[], options: StyleRunOptions | string = {}, userId?: string): Promise<StyleProfile> {
    const { name, refresh, analyzer: analyzerId } = typeof options === 'string' ? { name: options } : options;
    const key = userId ?? '';
    const epoch = this.epochs.get(key) ?? 0;
    const videos = assetIds.map((assetId) => {
      const asset = this.assets.get(assetId, userId);
      if (!asset) throw new Error(`Asset ${assetId} was not found`);
      return asset;
    });
    const analyzer = analyzerId ? this.analyzers.get(analyzerId) : await this.analyzers.resolve(userId);
    if (!analyzer) throw new Error(`Analyzer ${analyzerId} was not found`);
    const result = await runStylePipeline({
      videos,
      analyzer,
      cache: this.cache,
      ...(refresh ? { refresh } : {}),
      distill: async (template, observations) => await this.agent.distillStyle(emptyProject, template, observations, template.watchedCount > 0),
      onProgress: (progress) => { if (this.runs.get(key)?.status === 'processing') this.runs.set(key, { status: 'processing', progress }); },
      onWarning: (message) => console.warn('[style]', message),
    });
    const profile: StyleProfile = {
      id: randomUUID(), name: name ?? this.nextName(userId), assetIds, metrics: result.metrics, styleDoc: result.styleDoc,
      createdAt: new Date().toISOString(), analyzer: result.analyzer, observations: result.observations, template: result.template,
    };
    // An account deleted mid-run keeps nothing: `forget` moved the epoch on.
    if ((this.epochs.get(key) ?? 0) !== epoch) throw new Error('The account was deleted during the analysis');
    this.insert(profile, userId);
    this.settings.setFor(SELECTED_KEY, profile.id, userId);
    return profile;
  }

  private insert(profile: StyleProfile, userId?: string): void {
    this.database.prepare(`INSERT INTO style_profiles (${insertColumns}, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      profile.id, profile.name, JSON.stringify(profile.assetIds), JSON.stringify(profile.metrics), profile.styleDoc,
      profile.createdAt, profile.analyzer, JSON.stringify(profile.observations), profile.template ? JSON.stringify(profile.template) : null,
      userId ?? null,
    );
  }

  /** Every saved profile, newest first. */
  list(userId?: string): StyleProfile[] {
    const scope = owner(userId);
    const rows = this.database.prepare(`SELECT ${selectColumns} FROM style_profiles WHERE ${scope.sql} ORDER BY created_at DESC, rowid DESC`)
      .all(...scope.params) as StyleRow[];
    return rows.map(toProfile);
  }

  selectedId(userId?: string): string | undefined {
    return this.selected(userId)?.id;
  }

  /** The pointed-at profile, falling back to the newest when the pointer is stale. */
  selected(userId?: string): StyleProfile | undefined {
    const id = this.settings.getFor(SELECTED_KEY, userId);
    return (id ? this.get(id, userId) : undefined) ?? this.newest(userId);
  }

  get(id: string, userId?: string): StyleProfile | undefined {
    const scope = owner(userId);
    const row = this.database.prepare(`SELECT ${selectColumns} FROM style_profiles WHERE id = ? AND ${scope.sql}`)
      .get(id, ...scope.params) as StyleRow | undefined;
    return row ? toProfile(row) : undefined;
  }

  select(id: string, userId?: string): StyleProfile | undefined {
    const profile = this.get(id, userId);
    if (profile) this.settings.setFor(SELECTED_KEY, id, userId);
    return profile;
  }

  /** Re-analysis inserts a new profile, so a hand-edited styleDoc is never overwritten. */
  rename(id: string, { name, styleDoc }: { name?: string | undefined; styleDoc?: string | undefined }, userId?: string): StyleProfile | undefined {
    if (!this.get(id, userId)) return undefined;
    if (name !== undefined) this.database.prepare('UPDATE style_profiles SET name = ? WHERE id = ?').run(name, id);
    if (styleDoc !== undefined) this.database.prepare('UPDATE style_profiles SET style_doc = ? WHERE id = ?').run(styleDoc, id);
    return this.get(id, userId);
  }

  /** A copy of the measurements under a new id; the original stays selected. */
  duplicate(id: string, userId?: string): StyleProfile | undefined {
    const source = this.get(id, userId);
    if (!source) return undefined;
    const copy: StyleProfile = { ...source, id: randomUUID(), name: `${source.name} copy`, createdAt: new Date().toISOString() };
    this.insert(copy, userId);
    return copy;
  }

  /** Deleting the selected profile repoints the setting at whatever is left. */
  remove(id: string, userId?: string): boolean {
    if (!this.get(id, userId)) return false;
    this.database.prepare('DELETE FROM style_profiles WHERE id = ?').run(id);
    if (this.settings.getFor(SELECTED_KEY, userId) === id) this.settings.setFor(SELECTED_KEY, this.newest(userId)?.id ?? '', userId);
    return true;
  }

  private newest(userId?: string): StyleProfile | undefined {
    const scope = owner(userId);
    const row = this.database.prepare(`SELECT ${selectColumns} FROM style_profiles WHERE ${scope.sql} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(...scope.params) as StyleRow | undefined;
    return row ? toProfile(row) : undefined;
  }

  private nextName(userId?: string): string {
    const scope = owner(userId);
    const { count } = this.database.prepare(`SELECT COUNT(*) AS count FROM style_profiles WHERE ${scope.sql}`).get(...scope.params) as { count: number };
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
