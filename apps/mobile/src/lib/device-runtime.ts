/**
 * The app's one copy of the engine's capabilities, wired to the real engine and PostHog.
 * Started once from the root layout; the logic lives in engine-capabilities.ts and
 * analytics-properties.ts.
 */
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { EditifyEngine } from '../../modules/editify-engine';
import { superProperties, type ExportDone, type ExportFailed } from './analytics-properties';
import { createCapabilityCache, tierOf, type Capabilities } from './engine-capabilities';
import { posthog } from './posthog';

export const capabilities = createCapabilityCache(EditifyEngine);

function register(current: Capabilities): void {
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version;
  void posthog?.register({ ...superProperties(current, { appVersion: version, platformVersion: Platform.Version }) });
}

let started = false;

/**
 * Reads the capabilities once and tags PostHog with them, then again whenever something
 * changes them: a words part finishing (the transcriber that ran) or the speech permission.
 * Idempotent.
 */
export function startDeviceRuntime(): void {
  if (started) return;
  started = true;
  capabilities.subscribe(register);
  register(capabilities.current());
  const engine = EditifyEngine;
  if (!engine) return;
  engine.addListener('analysisStatus', (event) => {
    if (event.part === 'words' && !event.removed && event.status === 'ready') capabilities.refresh();
  });
  engine.addListener('speechAuthorization', () => { capabilities.refresh(); });
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
