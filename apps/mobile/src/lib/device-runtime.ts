/**
 * The app's one copy of the engine's capabilities and the device words flow, wired to the
 * real engine, the media registry and PostHog. Started once from the root layout; the logic
 * lives in engine-capabilities.ts, device-words.ts and analytics-properties.ts.
 */
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { AssetMetadata } from '@editify/shared';
import { EditifyEngine } from '../../modules/editify-engine';
import { superProperties, type ExportDone, type ExportFailed } from './analytics-properties';
import { createCapabilityCache, tierOf, type Capabilities } from './engine-capabilities';
import { createDeviceWords, wordsRefs, type DeviceWords } from './device-words';
import { analyzeMedia, mediaKindOf } from './local-media';
import { localMedia } from './local-media-native';
import { onImportCompleted } from './import-hooks';
import { posthog } from './posthog';

export const capabilities = createCapabilityCache(EditifyEngine);

/** The words flow, or null where there is no engine (web, Android, an older binary). */
export const deviceWords: DeviceWords | null = EditifyEngine
  ? createDeviceWords({
    native: EditifyEngine,
    capabilities,
    queue: async (ref) => {
      const deps = await localMedia();
      if (!deps) throw new Error('No media registry');
      const media = await analyzeMedia(ref, deps, ['words']);
      if (media.state !== 'local' && media.state !== 'file') throw new Error('Not on this iPhone');
    },
    onWordsDone: (event) => { posthog?.capture('words_done', event); },
  })
  : null;

function register(current: Capabilities): void {
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version;
  void posthog?.register({ ...superProperties(current, { appVersion: version, platformVersion: Platform.Version }) });
}

let started = false;

/**
 * Reads the capabilities once, tags PostHog with them, and listens for what changes them:
 * words status events (the transcriber that ran) and the speech permission. Idempotent.
 */
export function startDeviceRuntime(): void {
  if (started) return;
  started = true;
  capabilities.subscribe(register);
  register(capabilities.current());
  const engine = EditifyEngine;
  if (!engine || !deviceWords) return;
  const words = deviceWords;
  engine.addListener('analysisStatus', (event) => { void words.analysisStatus(event); });
  engine.addListener('speechAuthorization', (event) => { void words.speechAuthorizationChanged(event); });
  onImportCompleted((assets) => { importCompleted(assets); });
}

/** After an import: queue words for the clips with sound, and maybe offer the speech sheet (C15). */
function importCompleted(assets: readonly AssetMetadata[]): void {
  if (!deviceWords) return;
  const refs = wordsRefs(assets.map((asset) => ({ id: asset.id, kind: mediaKindOf(asset.mimeType, asset.originalName), hasAudio: asset.hasAudio })));
  void deviceWords.importCompleted(refs).catch(() => undefined);
}

/** The RAM tier for routeExport (null without an engine or before T7's binaries). */
export function deviceTier() {
  return tierOf(capabilities.current());
}

export function captureExportDone(event: ExportDone): void {
  posthog?.capture('export_done', { ...event });
}

export function captureExportFailed(event: ExportFailed): void {
  posthog?.capture('export_failed', { ...event });
}
