import type { AssetMetadata } from '@editify/shared';

/**
 * What runs after an import lands (the device words flow, C15), kept free of React Native so
 * the pickers stay testable: pick.ts announces, device-runtime.ts listens.
 */
const listeners = new Set<(assets: readonly AssetMetadata[]) => void>();

export function onImportCompleted(listener: (assets: readonly AssetMetadata[]) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function importCompleted(assets: readonly AssetMetadata[]): void {
  if (assets.length === 0) return;
  for (const listener of listeners) {
    try { listener(assets); } catch { /* an import never fails on a listener */ }
  }
}
