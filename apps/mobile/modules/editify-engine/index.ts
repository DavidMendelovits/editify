import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import type { AnalysisPartStatus } from '@editify/shared';
import type { LabRow, SpikeId } from '../../src/lab/evaluate';

/** Parts the device scheduler runs per asset (decision 8A order). Sync is per pair, outside the queue. */
export type NativeAnalysisPart = 'decode' | 'words' | 'laughter' | 'energy' | 'faces';

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
}

export interface NativeAssetAnalysis {
  assetId: string;
  parts: Partial<Record<NativeAnalysisPart, NativePartResult>>;
}

export interface AnalyzeOptions { facesFps?: number; locale?: string; allowModelDownload?: boolean; force?: boolean }

/** `phase: 'download'` is the iCloud original being fetched before the analyzer starts. */
export type ProgressEvent =
  | { spike: SpikeId; run: number; fraction: number }
  | { part: NativeAnalysisPart | 'proxy'; assetId?: string; ref?: string; fraction: number; phase?: 'download' };
/**
 * A part's status changed. Carries no data: on `ready`, read it with `getAnalysis`.
 * `removed` means `cancelAnalysis` dropped a part that was still pending.
 */
export type AnalysisStatusEvent =
  | { assetId: string; part: NativeAnalysisPart; status: AnalysisPartStatus; analyzerVersion: string; error?: string; removed?: undefined }
  | { assetId: string; part: NativeAnalysisPart; removed: true };
export interface AnalysisStateEvent { playbackActive: boolean; thermal: string; heavyPaused: boolean }

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
  analyze(assetId: string, ref: string, parts?: NativeAnalysisPart[] | null, options?: AnalyzeOptions | null): Promise<void>;
  /** True while the user plays or scrubs: words and faces hold until it is false again. */
  setPlaybackActive(active: boolean): Promise<void>;
  /** The asset on screen: its queued parts go first. */
  setFocusAsset(assetId: string | null): Promise<void>;
  cancelAnalysis(assetId: string): Promise<void>;
  getAnalysis(assetId: string): Promise<NativeAssetAnalysis>;
  schedulerState(): Promise<{ playbackActive: boolean; thermal: string; heavyPaused: boolean; queued: unknown[]; running: unknown[]; focus: string | null }>;

  addListener(event: 'progress', listener: (event: ProgressEvent) => void): EventSubscription;
  addListener(event: 'analysisStatus', listener: (event: AnalysisStatusEvent) => void): EventSubscription;
  addListener(event: 'analysisState', listener: (event: AnalysisStateEvent) => void): EventSubscription;
}

/** iOS-only native engine (null on web and in builds without it): the capability lab and the device analyzers. */
export const EditifyEngine = requireOptionalNativeModule<EditifyEngineNative>('EditifyEngine');
