/**
 * PostHog's 1.1 tags (C12), free of React Native so they run under vitest. Every event carries
 * the super-properties; the three events say how the device-first pipeline did.
 *
 *   super-properties (posthog.register, again whenever capabilities change):
 *     line         "1.1" from the build's version (major.minor), "dev" without one
 *     os           capabilities().os ("18.0.0"), else the platform's version
 *     tier         RAM tier: full | standard | low (null on web / older binaries)
 *     transcriber  the words adapter that last ran: speech-analyzer | sfspeech (null before any)
 *     bgExport     the BackgroundExecution adapter: continued-processing | foreground
 *
 *   words_done     {adapter, secs}          a words part became ready on this iPhone
 *   export_done    {route, tier, secs}      device or server export finished
 *   export_failed  {reason, route}          backgrounded | error (device), server-error (server)
 *
 * No content goes in: no titles, names, transcripts or file paths.
 */
import type { DeviceTier } from '../../modules/editify-engine';
import { tierOf, type Capabilities } from './engine-capabilities';

export interface SuperProperties {
  line: string;
  os: string | null;
  tier: DeviceTier | null;
  transcriber: string | null;
  bgExport: string | null;
}

/** "1.1.0" ─▶ "1.1"; anything else ─▶ "dev". */
export function lineOf(version: string | null | undefined): string {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  return match ? `${match[1]}.${match[2]}` : 'dev';
}

export function superProperties(capabilities: Capabilities, build: { appVersion: string | null | undefined; platformVersion?: string | number | null }): SuperProperties {
  return {
    line: lineOf(build.appVersion),
    os: capabilities.os ?? (build.platformVersion === undefined || build.platformVersion === null ? null : String(build.platformVersion)),
    tier: tierOf(capabilities),
    transcriber: capabilities.transcriber?.lastRan ?? null,
    bgExport: capabilities.backgroundExport ?? null,
  };
}

export type ExportRouteName = 'device' | 'server';

export interface ExportDone { route: ExportRouteName; tier: DeviceTier | null; secs: number }
export interface ExportFailed { reason: string; route: ExportRouteName }

/** Seconds since `startedAt`, to a tenth. */
export function secondsSince(startedAt: number, now: number): number {
  return Math.max(0, Math.round((now - startedAt) / 100) / 10);
}
