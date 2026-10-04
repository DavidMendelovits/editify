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
 *        markStale(current versions) ─┤  (a bumped analyzer sends its parts back to pending;
 *                                     │   words follow the C25 trigger rule, see WordsFreshness)
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
  /** Why it is unavailable, for the UI: `speechRecognitionOff` gets a Settings link (D21). */
  code?: string;
  /** Words only: the re-run trigger the native chain stamped on it (C25, WordsFreshness). */
  trigger?: string;
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
  /**
   * Per asset, the newest native revision applied (events and getAnalysis snapshots).
   * Never persist these: native revisions restart at 0 in every app process, so a stored
   * value would make the next session's events look stale.
   */
  revisions: Record<string, number>;
}

export interface AnalysisExtras {
  laughter: Record<string, PartState<NativeLaughter>>;
  /** Seconds the energy curve peaks at (cut_to_beats), for assets whose energy is ready. */
  onsetPeaks: Record<string, number[]>;
}

export const emptyAnalysisState = (): DeviceAnalysisState => ({ assets: {}, syncs: [], revisions: {} });

/** True when `revision` is older than what the state already reflects (stale: drop it). */
function isStale(state: DeviceAnalysisState, assetId: string, revision: number | undefined, orEqual: boolean): boolean {
  if (revision === undefined) return false;
  const known = state.revisions[assetId];
  return known !== undefined && (orEqual ? revision <= known : revision < known);
}

function withRevision(state: DeviceAnalysisState, assetId: string, revision: number | undefined): DeviceAnalysisState {
  return revision === undefined ? state : { ...state, revisions: { ...state.revisions, [assetId]: revision } };
}

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
  if (result.code !== undefined) next.code = result.code;
  if (result.trigger !== undefined) next.trigger = result.trigger;
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
 * parts it no longer returns (cancelled while pending) are dropped here too. A
 * snapshot older than an event already applied for the asset is ignored.
 */
export function applyAssetAnalysis(state: DeviceAnalysisState, analysis: NativeAssetAnalysis): DeviceAnalysisState {
  if (isStale(state, analysis.assetId, analysis.revision, false)) return state;
  const previous = state.assets[analysis.assetId] ?? {};
  const parts: Partial<Record<NativeAnalysisPart, PartState>> = {};
  for (const [part, result] of Object.entries(analysis.parts) as Array<[NativeAnalysisPart, NativePartResult]>) {
    parts[part] = nextPartState(previous[part], result);
  }
  return withRevision({ ...state, assets: { ...state.assets, [analysis.assetId]: parts } }, analysis.assetId, analysis.revision);
}

/**
 * One `analysisStatus` event. Events carry no data, so a `ready` event changes
 * nothing here and answers `refetch: true`: call `getAnalysis(assetId)` and fold
 * the answer in with `applyAssetAnalysis`. A `removed` event drops the part.
 */
export function applyStatusEvent(state: DeviceAnalysisState, event: AnalysisStatusEvent): { state: DeviceAnalysisState; refetch: boolean } {
  if (isStale(state, event.assetId, event.revision, true)) return { state, refetch: false };
  const current = withRevision(state, event.assetId, event.revision);
  if (event.removed) {
    const { [event.part]: _dropped, ...rest } = current.assets[event.assetId] ?? {};
    return { state: { ...current, assets: { ...current.assets, [event.assetId]: rest } }, refetch: false };
  }
  if (event.status === 'ready') return { state: current, refetch: true };
  const result: NativePartResult = { status: event.status, analyzerVersion: event.analyzerVersion };
  if (event.error !== undefined) result.error = event.error;
  if (event.code !== undefined) result.code = event.code;
  if (event.trigger !== undefined) result.trigger = event.trigger;
  return { state: applyPartResult(current, event.assetId, event.part, result), refetch: false };
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
 * When a stored words part is current (C25, refining D12); the native chain's
 * `capabilities().transcriber` gives the three fields, and WordsFreshness in
 * TranscriberChain.swift is the same rule.
 *
 *   version unknown to this build (an older analyzer) ──────────────▶ stale (re-run)
 *   version of the best adapter (SpeechAnalyzer on 26, SFSpeech on 18) ▶ current
 *   a fallback's version: trigger it carries == the current trigger ──▶ current
 *                                               otherwise ───────────▶ stale, once: the re-run
 *                                               carries the new trigger, so falling back again
 *                                               (a model install that keeps failing) is current
 *
 * The trigger moves on an OS version change or a SpeechAnalyzer model install, never on a
 * failed one, so nothing re-runs in a loop.
 */
export interface WordsFreshness { best: string; versions: string[]; trigger: string }

export function wordsCurrent(policy: WordsFreshness, part: Pick<PartState, 'analyzerVersion' | 'trigger'>): boolean {
  if (!policy.versions.includes(part.analyzerVersion)) return false;
  return part.analyzerVersion === policy.best || part.trigger === policy.trigger;
}

/**
 * Parts made by an analyzer older than the one installed go back to `pending`
 * under the current version (their data dropped), and are listed so the caller
 * re-queues them with `analyze(..., { force: true })` or re-runs `syncPair`.
 * Parts with no current version (unknown to this build) are left alone.
 *
 * `words` is required on purpose: a binary with the Transcriber chain writes one version per
 * adapter, so an exact match against `versions.words` (the best adapter's) would mark every
 * fallback result stale, and on an iOS 26 phone whose SpeechAnalyzer can't run that re-runs
 * SFSpeech forever. Pass `wordsFreshness(capabilities)`; null only for a binary without the
 * chain (no `capabilities().transcriber`), where one version is the whole rule.
 */
export function markStale(
  state: DeviceAnalysisState,
  versions: Partial<Record<NativeAnalysisPart | 'sync', string>>,
  words: WordsFreshness | null,
): { state: DeviceAnalysisState; stale: StalePart[] } {
  const stale: StalePart[] = [];
  const assets: DeviceAnalysisState['assets'] = {};
  for (const [assetId, parts] of Object.entries(state.assets)) {
    const next: Partial<Record<NativeAnalysisPart, PartState>> = {};
    for (const [part, current] of Object.entries(parts) as Array<[NativeAnalysisPart, PartState]>) {
      if (part === 'words' && words) {
        if (wordsCurrent(words, current)) {
          next[part] = current;
        } else {
          next[part] = { status: 'pending', analyzerVersion: words.best };
          stale.push({ assetId, part });
        }
        continue;
      }
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
  return { state: { assets, syncs, revisions: state.revisions }, stale };
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
