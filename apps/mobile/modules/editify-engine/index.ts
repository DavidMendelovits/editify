import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import type { AnalysisPartStatus } from '@editify/shared';
import type { LabRow, SpikeId } from '../../src/lab/evaluate';

/**
 * Parts the device scheduler runs per asset (decision 8A order). Sync is per pair, outside the queue.
 * `proxy` is the 1080p preview proxy (10B): queued only by `ensureProxy` or by naming it.
 */
export type NativeAnalysisPart = 'decode' | 'words' | 'proxy' | 'laughter' | 'energy' | 'faces';

/**
 * What every analyzer call returns: the 6A status and analyzer version, data
 * when ready, and the reason when failed or unavailable. Never thrown: a missing
 * speech model or a clip without audio is a result, not an exception.
 */
export interface NativePartResult<T = unknown> {
  status: AnalysisPartStatus;
  analyzerVersion: string;
  data?: T;
  error?: string;
}

export interface NativeTranscript {
  language: string;
  durationProcessedSeconds: number;
  words: Array<{ w: string; s: number; e: number }>;
  segments: Array<{ text: string; s: number; e: number }>;
}
export interface NativeLaughter {
  minConfidence: number;
  /** `confidence` is the peak classifier window's, `meanConfidence` the average over `windows`. */
  spans: Array<{ s: number; e: number; confidence: number; meanConfidence: number; windows: number }>;
}
export interface NativeEnergy { cellSeconds: number; rmsDb: number[]; onsetPeaks: number[] }
/** A ready `proxy` part's data. `path` is relative to `mediaRoot()`; `reused` means it was already on disk. */
export interface NativeProxy {
  path: string;
  bytes: number;
  reused?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  color?: 'hlg' | 'pq' | 'log' | 'sdr';
  codec?: 'hevc-main10' | 'h264-high';
  audio?: 'passthrough' | 'aac' | 'none';
  exportMs?: number;
}

/** What identifies a source in the local media registry (OV2). `audio` is null without an audio track, `color` without video. */
export interface NativeFingerprint {
  duration: number;
  bytes: number;
  audio: string | null;
  color: 'hlg' | 'pq' | 'log' | 'sdr' | null;
}

export type PhotosAccess = 'all' | 'limited' | 'denied' | 'undetermined';

/** `probeMedia` / `downloadMedia`: where a PHAsset id or file:// URI stands right now. */
export type NativeProbe =
  | { status: 'ok'; fingerprint: NativeFingerprint }
  | { status: 'icloud' }
  | { status: 'unreachable'; error: string }
  | { status: 'missing'; access: PhotosAccess }
  | { status: 'failed'; error: string };

export interface NativeFaces {
  fps: number;
  width: number;
  height: number;
  samples: Array<[number, number, number, number, number] | [number, null]>;
}
export interface NativeSync {
  lag: number;
  anchor: number;
  rate: number;
  coarseRatio: number;
  fineScore: number;
  confident: boolean;
  driftSec?: number;
  overlapSec: number;
  windows: Array<{ at: number; lag: number; score: number }>;
  /** Whether the fine stage replaced the 10 ms coarse lag (device-only; not in the shared schema). */
  fineLocked?: boolean;
}

export interface NativeAssetAnalysis {
  assetId: string;
  parts: Partial<Record<NativeAnalysisPart, NativePartResult>>;
  /** The asset's change counter this snapshot reflects (matches `analysisStatus` events). */
  revision?: number;
}

export interface AnalyzeOptions { facesFps?: number; locale?: string; allowModelDownload?: boolean; force?: boolean }

/** `phase: 'download'` is the iCloud original being fetched before the analyzer starts. */
export type ProgressEvent =
  | { spike: SpikeId; run: number; fraction: number }
  | { part: NativeAnalysisPart; assetId?: string; ref?: string; fraction: number; phase?: 'download' }
  | { part: 'download'; ref: string; requestId: string; fraction: number; phase: 'download' };
/**
 * A part's status changed. Carries no data: on `ready`, read it with `getAnalysis`.
 * `removed` means `cancelAnalysis` dropped a part that was still pending. `revision`
 * counts changes per asset, so a `getAnalysis` snapshot older than an applied event can be dropped.
 */
export type AnalysisStatusEvent =
  | { assetId: string; part: NativeAnalysisPart; revision?: number; status: AnalysisPartStatus; analyzerVersion: string; error?: string; removed?: undefined }
  | { assetId: string; part: NativeAnalysisPart; revision?: number; removed: true };
export interface AnalysisStateEvent { playbackActive: boolean; exportActive: boolean; thermal: string; heavyPaused: boolean }

interface EditifyEngineNative {
  runSpike(spike: SpikeId, variant: string, run: number, params: Record<string, unknown>): Promise<LabRow>;
  readResults(): string;
  resultsPath(): string;
  clearResults(): void;

  // Analyzers, called directly. `ref` is a PHAsset localIdentifier or a file:// URI.
  analyzerVersions(): Record<NativeAnalysisPart | 'sync', string>;
  /** Mono Float32 LE PCM at 8000-48000 Hz (default 8000; anything else rejects) written to a temp file swept on next launch. */
  decodeMono(ref: string, sampleRate?: number | null): Promise<{ uri: string; sampleRate: number; sampleCount: number; seconds: number }>;
  /** One pair's SyncMeasurement (OV6). Asset ids let it reuse the scheduler's decoded audio. */
  syncPair(videoRef: string, memoRef: string, videoAssetId?: string | null, memoAssetId?: string | null): Promise<NativePartResult<NativeSync>>;
  words(ref: string, locale?: string | null, allowModelDownload?: boolean | null): Promise<NativePartResult<NativeTranscript>>;
  laughter(ref: string, minConfidence?: number | null): Promise<NativePartResult<NativeLaughter>>;
  energy(ref: string): Promise<NativePartResult<NativeEnergy>>;
  onsetPeaks(rmsDb: number[], cellSeconds: number): number[];
  faces(ref: string, fps?: number | null): Promise<NativePartResult<NativeFaces>>;
  /** An H.264 file at most `maxHeight` (clamped to 144-1080, default 360) tall for Gemini style analysis; width/height are as written. Uploading it is the caller's job. */
  makeProxy(ref: string, maxHeight?: number | null): Promise<{ uri: string; width: number; height: number; seconds: number; bytes: number; exportMs: number }>;

  // Scheduler (decision 8A). Status changes arrive as `analysisStatus` events.
  /**
   * `ref` must come from `resolveMedia` (an app copy, or a Photos original whose fingerprint
   * still matches): use `analyzeMedia` in src/lib/local-media.ts, never a raw PHAsset id.
   */
  analyze(assetId: string, ref: string, parts?: NativeAnalysisPart[] | null, options?: AnalyzeOptions | null): Promise<void>;
  /** True while the user plays or scrubs: words and faces hold until it is false again. */
  setPlaybackActive(active: boolean): Promise<void>;
  /** The asset on screen: its queued parts go first. */
  setFocusAsset(assetId: string | null): Promise<void>;
  cancelAnalysis(assetId: string): Promise<void>;
  getAnalysis(assetId: string): Promise<NativeAssetAnalysis>;
  schedulerState(): Promise<{ playbackActive: boolean; exportActive: boolean; thermal: string; heavyPaused: boolean; queued: unknown[]; running: unknown[]; focus: string | null }>;
  /** True while an export renders: a running proxy is cancelled (restarted after), words and faces pause. */
  setExportActive(active: boolean): Promise<void>;

  // Local media registry (decision 3A) and preview proxies (10B + OV9).
  /** Photos library access, read without prompting. */
  photosAccess(): PhotosAccess;
  /** Application Support/Editify/ as a file:// URL with a trailing slash; registry paths are relative to it. */
  mediaRoot(): string;
  /** Copies a file:// URI into media/ (durable, excluded from backup); `path` is relative to `mediaRoot()`. */
  durableCopy(uri: string, name: string): Promise<{ path: string; uri: string; bytes: number }>;
  /** Shows the system Photos prompt when it was never shown; answers the access afterwards. */
  requestPhotosAccess(): Promise<PhotosAccess>;
  /** Bytes iOS would make available for an import (0 when unknown). */
  availableBytes(): number;
  /** Every file under media/ with its size and modification time (ms), for the orphan sweep. */
  mediaFiles(): Array<{ path: string; bytes: number; modified: number }>;
  /** Deletes a file under the media root by its relative path. */
  removeMedia(path: string): void;
  /** Deletes an asset's preview proxy. */
  removeProxy(assetId: string): void;
  /** A PHAsset id (loaded as `.original`) or file:// URI: fingerprinted when on the device, never downloaded. */
  probeMedia(ref: string): Promise<NativeProbe>;
  /** `probeMedia`, downloading an iCloud original first; `progress` events carry `requestId`. Rejects when cancelled. */
  downloadMedia(ref: string, requestId: string): Promise<NativeProbe>;
  cancelDownload(requestId: string): void;
  /** Queues the asset's 1080p preview proxy; `analysisStatus` / `progress` events with part 'proxy' follow. */
  ensureProxy(assetId: string, ref: string): Promise<void>;
  /** The preview opened this proxy (least recently opened is evicted first). False when there is none. */
  touchProxy(assetId: string): boolean;
  /** The proxy store's byte budget (default 4 GB), clamped to 256 MB-1 TB and applied at once; false for a non-number. */
  setProxyBudget(bytes: number): Promise<boolean>;

  addListener(event: 'progress', listener: (event: ProgressEvent) => void): EventSubscription;
  addListener(event: 'analysisStatus', listener: (event: AnalysisStatusEvent) => void): EventSubscription;
  addListener(event: 'analysisState', listener: (event: AnalysisStateEvent) => void): EventSubscription;
}

/** iOS-only native engine (null on web and in builds without it): the capability lab and the device analyzers. */
export const EditifyEngine = requireOptionalNativeModule<EditifyEngineNative>('EditifyEngine');
