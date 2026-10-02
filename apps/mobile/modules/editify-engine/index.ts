import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import type { LabRow, SpikeId } from '../../src/lab/evaluate';

interface EditifyEngineNative {
  runSpike(spike: SpikeId, variant: string, run: number, params: Record<string, unknown>): Promise<LabRow>;
  readResults(): string;
  resultsPath(): string;
  clearResults(): void;
  addListener(event: 'progress', listener: (event: { spike: SpikeId; run: number; fraction: number }) => void): EventSubscription;
}

/** iOS-only native engine (null on web and in builds without it); the capability lab is its only caller for now. */
export const EditifyEngine = requireOptionalNativeModule<EditifyEngineNative>('EditifyEngine');
