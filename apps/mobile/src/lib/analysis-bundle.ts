/**
 * Device analysis → AnalysisBundle (decision 6A). The native scheduler reports
 * each part as `{status, analyzerVersion, data?, error?}`; this keeps those per
 * asset, plus one sync result per video/memo pair (OV6), and turns them into
 * the zod-valid bundle an agent turn carries.
 *
 *   analysisStatus event ─▶ applyStatusEvent ─┬─ pending / failed / unavailable / removed: applied
 *                                             └─ ready: { refetch } (events carry no data)
 *   getAnalysis(assetId) ─▶ applyAssetAnalysis ──┐  (the asset's parts become exactly what it returns)
 *   syncPair ─▶ applySync ───────────────────────┴─▶ DeviceAnalysisState
 *        markStale(current versions) ─┤  (a bumped analyzer sends its parts back to pending)
 *                                     └─▶ buildAnalysisBundle ─▶ { bundle, extras }
 *
 * Parts the shared schema has no slot for yet (laughter spans, onset peaks)
 * travel in `extras` with the same status/version shape.
 */
import { assetAnalysisSchema, analysisBundleSchema, syncMeasurementSchema, type AnalysisBundle, type AnalysisPartStatus } from '@editify/shared';
import type { AnalysisStatusEvent, NativeAnalysisPart, NativeAssetAnalysis, NativeEnergy, NativeLaughter, NativePartResult, NativeSync } from '../../modules/editify-engine';

export interface PartState<T = unknown> {
  status: AnalysisPartStatus;
  analyzerVersion: string;
  data?: T;
  error?: string;
}

export interface SyncState {
  videoAssetId: string;
  memoAssetId: string;
  status: AnalysisPartStatus;
  analyzerVersion: string;
  measurement?: NativeSync;
  error?: string;
}

export interface DeviceAnalysisState {
  assets: Record<string, Partial<Record<NativeAnalysisPart, PartState>>>;
  syncs: SyncState[];
}

export interface AnalysisExtras {
  laughter: Record<string, PartState<NativeLaughter>>;
  /** Seconds the energy curve peaks at (cut_to_beats), for assets whose energy is ready. */
  onsetPeaks: Record<string, number[]>;
}

export const emptyAnalysisState = (): DeviceAnalysisState => ({ assets: {}, syncs: [] });

/**
 * For results that are supposed to carry data (getAnalysis, direct analyzer calls,
 * syncPair): a ready result without data is a failure, not a silent empty part.
 * Status events never carry data; they go through `applyStatusEvent` instead.
 */
function normalize<T>(result: NativePartResult<T>): PartState<T> {
  if (result.status === 'ready' && result.data === undefined) {
    return { status: 'failed', analyzerVersion: result.analyzerVersion, error: 'The analyzer reported ready without data' };
  }
  const next: PartState<T> = { status: result.status, analyzerVersion: result.analyzerVersion };
  if (result.status === 'ready') next.data = result.data as T;
  if (result.error !== undefined) next.error = result.error;
  return next;
}

/**
 * One part's new state. A `pending` for a part already ready from the same
 * analyzer version (a re-queue that will be skipped) keeps the ready data;
 * anything else replaces it.
 */
export function nextPartState(previous: PartState | undefined, incoming: NativePartResult): PartState {
  if (incoming.status === 'pending' && previous?.status === 'ready' && previous.analyzerVersion === incoming.analyzerVersion) return previous;
  return normalize(incoming);
}

export function applyPartResult(state: DeviceAnalysisState, assetId: string, part: NativeAnalysisPart, result: NativePartResult): DeviceAnalysisState {
  const parts = state.assets[assetId] ?? {};
  return { ...state, assets: { ...state.assets, [assetId]: { ...parts, [part]: nextPartState(parts[part], result) } } };
}

/**
 * Folds a whole `getAnalysis` answer in. The native side is the source of truth:
 * parts it no longer returns (cancelled while pending) are dropped here too.
 */
export function applyAssetAnalysis(state: DeviceAnalysisState, analysis: NativeAssetAnalysis): DeviceAnalysisState {
  const previous = state.assets[analysis.assetId] ?? {};
  const parts: Partial<Record<NativeAnalysisPart, PartState>> = {};
  for (const [part, result] of Object.entries(analysis.parts) as Array<[NativeAnalysisPart, NativePartResult]>) {
    parts[part] = nextPartState(previous[part], result);
  }
  return { ...state, assets: { ...state.assets, [analysis.assetId]: parts } };
}

/**
 * One `analysisStatus` event. Events carry no data, so a `ready` event changes
 * nothing here and answers `refetch: true`: call `getAnalysis(assetId)` and fold
 * the answer in with `applyAssetAnalysis`. A `removed` event drops the part.
 */
export function applyStatusEvent(state: DeviceAnalysisState, event: AnalysisStatusEvent): { state: DeviceAnalysisState; refetch: boolean } {
  if (event.removed) {
    const { [event.part]: _dropped, ...rest } = state.assets[event.assetId] ?? {};
    return { state: { ...state, assets: { ...state.assets, [event.assetId]: rest } }, refetch: false };
  }
  if (event.status === 'ready') return { state, refetch: true };
  const result: NativePartResult = { status: event.status, analyzerVersion: event.analyzerVersion };
  if (event.error !== undefined) result.error = event.error;
  return { state: applyPartResult(state, event.assetId, event.part, result), refetch: false };
}

export function applySync(state: DeviceAnalysisState, videoAssetId: string, memoAssetId: string, result: NativePartResult<NativeSync>): DeviceAnalysisState {
  const part = normalize(result);
  const entry: SyncState = { videoAssetId, memoAssetId, status: part.status, analyzerVersion: part.analyzerVersion };
  if (part.data) entry.measurement = part.data;
  if (part.error !== undefined) entry.error = part.error;
  const others = state.syncs.filter((sync) => sync.videoAssetId !== videoAssetId || sync.memoAssetId !== memoAssetId);
  return { ...state, syncs: [...others, entry] };
}

export interface StalePart { assetId: string; part: NativeAnalysisPart | 'sync'; memoAssetId?: string }

/**
 * Parts made by an analyzer older than the one installed go back to `pending`
 * under the current version (their data dropped), and are listed so the caller
 * re-queues them with `analyze(..., { force: true })` or re-runs `syncPair`.
 * Parts with no current version (unknown to this build) are left alone.
 */
export function markStale(state: DeviceAnalysisState, versions: Partial<Record<NativeAnalysisPart | 'sync', string>>): { state: DeviceAnalysisState; stale: StalePart[] } {
  const stale: StalePart[] = [];
  const assets: DeviceAnalysisState['assets'] = {};
  for (const [assetId, parts] of Object.entries(state.assets)) {
    const next: Partial<Record<NativeAnalysisPart, PartState>> = {};
    for (const [part, current] of Object.entries(parts) as Array<[NativeAnalysisPart, PartState]>) {
      const version = versions[part];
      if (version && current.analyzerVersion !== version) {
        next[part] = { status: 'pending', analyzerVersion: version };
        stale.push({ assetId, part });
      } else {
        next[part] = current;
      }
    }
    assets[assetId] = next;
  }
  const syncs = state.syncs.map((sync) => {
    if (!versions.sync || sync.analyzerVersion === versions.sync) return sync;
    stale.push({ assetId: sync.videoAssetId, part: 'sync', memoAssetId: sync.memoAssetId });
    return { videoAssetId: sync.videoAssetId, memoAssetId: sync.memoAssetId, status: 'pending' as const, analyzerVersion: versions.sync };
  });
  return { state: { assets, syncs }, stale };
}

type BundleAsset = AnalysisBundle['assets'][string];

/** The bundle's view of a part: data only when ready, and only data its schema accepts. */
function bundlePart<K extends 'transcript' | 'energy' | 'faces'>(key: K, part: PartState | undefined, data: unknown): BundleAsset[K] | undefined {
  if (!part) return undefined;
  const candidate = part.status === 'ready'
    ? { status: part.status, analyzerVersion: part.analyzerVersion, data }
    : { status: part.status, analyzerVersion: part.analyzerVersion };
  const parsed = assetAnalysisSchema.shape[key].safeParse(candidate);
  if (parsed.success) return parsed.data as BundleAsset[K];
  // Malformed data from the device fails that one part instead of the whole bundle.
  return { status: 'failed', analyzerVersion: part.analyzerVersion } as BundleAsset[K];
}

export function buildAnalysisBundle(state: DeviceAnalysisState): { bundle: AnalysisBundle; extras: AnalysisExtras } {
  const assets: AnalysisBundle['assets'] = {};
  const extras: AnalysisExtras = { laughter: {}, onsetPeaks: {} };
  for (const [assetId, parts] of Object.entries(state.assets)) {
    const asset: BundleAsset = {};
    const transcript = bundlePart('transcript', parts.words, parts.words?.data);
    const energyData = parts.energy?.data as NativeEnergy | undefined;
    const energy = bundlePart('energy', parts.energy, energyData && { cellSeconds: energyData.cellSeconds, rmsDb: energyData.rmsDb });
    const faces = bundlePart('faces', parts.faces, parts.faces?.data);
    if (transcript) asset.transcript = transcript;
    if (energy) asset.energy = energy;
    if (faces) asset.faces = faces;
    assets[assetId] = asset;
    if (parts.laughter) extras.laughter[assetId] = parts.laughter as PartState<NativeLaughter>;
    if (energy?.status === 'ready' && energyData) extras.onsetPeaks[assetId] = energyData.onsetPeaks;
  }
  const syncs = state.syncs.map((sync) => {
    const base = { videoAssetId: sync.videoAssetId, memoAssetId: sync.memoAssetId, analyzerVersion: sync.analyzerVersion };
    if (sync.status !== 'ready') return { ...base, status: sync.status };
    const measurement = syncMeasurementSchema.safeParse(sync.measurement);
    return measurement.success ? { ...base, status: sync.status, measurement: measurement.data } : { ...base, status: 'failed' as const };
  });
  return { bundle: analysisBundleSchema.parse({ assets, syncs }), extras };
}
