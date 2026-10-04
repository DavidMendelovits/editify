/**
 * The update gate's decisions, free of React Native so they run under vitest.
 *
 * The server's `GET /client-config` names the oldest app version it still
 * serves. Below it the app shows a full-screen gate: "Update Editify" with a
 * store button, or, when this phone's iOS is too old for the version the store
 * offers, a sunset screen that saves the user's videos to Photos instead.
 *
 * Every failure here fails open. A server that is down, slow, or answering
 * with something unexpected must never lock anyone out of the app.
 */

export interface ClientConfig {
  minVersion: string;
  latestVersion: string;
  storeUrl: string;
  /** The iOS floor of `latestVersion`. Servers always send it now; absent (an older server) means the 1.1 floor below. */
  minOs?: string;
  /** True only on a pre-cutover test server (editify-v11 before launch): TestFlight builds show the test banner. */
  testServer?: true;
  /**
   * The native preview's remote kill switch: `false` (server NATIVE_PREVIEW=0) turns it off on
   * builds whose profile turned it on. Absent means the build decides.
   */
  nativePreview?: false;
}

/** Editify 1.1 needs iOS 18; a server that does not say otherwise means that. */
export const DEFAULT_MIN_OS = '18.0';
const FETCH_TIMEOUT_MS = 5000;

export type Gate =
  | { kind: 'none' }
  | { kind: 'update'; storeUrl: string; latestVersion: string }
  | { kind: 'sunset'; latestVersion: string; minOs: string };

const VERSION = /^\d+(\.\d+)*$/;

function parts(version: string): number[] | null {
  const trimmed = version.trim().replace(/^v/i, '');
  if (!VERSION.test(trimmed)) return null;
  return trimmed.split('.').map(Number);
}

/**
 * Numeric, part by part, missing parts read as 0: 1.0.9 < 1.1.0, 1.10.0 > 1.9.0,
 * 18 == 18.0. Returns null when either side is not a version, so a caller can
 * fail open instead of guessing.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return null;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** The response, or null for anything that is not one. */
export function parseClientConfig(value: unknown): ClientConfig | null {
  if (!value || typeof value !== 'object') return null;
  const { minVersion, latestVersion, storeUrl, minOs, testServer, nativePreview } = value as Record<string, unknown>;
  if (typeof minVersion !== 'string' || !parts(minVersion)) return null;
  if (typeof storeUrl !== 'string' || !/^https?:\/\//.test(storeUrl)) return null;
  const latest = typeof latestVersion === 'string' && parts(latestVersion) ? latestVersion : minVersion;
  return {
    minVersion,
    latestVersion: latest,
    storeUrl,
    ...(typeof minOs === 'string' && parts(minOs) ? { minOs } : {}),
    ...(testServer === true ? { testServer: true as const } : {}),
    ...(nativePreview === false ? { nativePreview: false as const } : {}),
  };
}

/**
 * Whether this screen may use the native preview: the build's flag (EXPO_PUBLIC_NATIVE_PREVIEW,
 * on in the preview-1.1 profile only), unless the server's config says `nativePreview: false`.
 * No config yet, or a failed fetch, leaves the build's flag in charge: only an explicit false
 * turns it off.
 */
export function nativePreviewEnabled(buildFlag: boolean, config: ClientConfig | null | undefined): boolean {
  return buildFlag && config?.nativePreview !== false;
}

// The last config the launch/foreground check (use-client-gate) read, for screens that need a
// server switch without fetching again. A failed fetch keeps the previous answer.
let latest: ClientConfig | null = null;
const listeners = new Set<() => void>();

export function rememberClientConfig(config: ClientConfig | null): void {
  if (!config || config === latest) return;
  latest = config;
  for (const listener of listeners) listener();
}

export function latestClientConfig(): ClientConfig | null {
  return latest;
}

/** For useSyncExternalStore. */
export function subscribeClientConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface Device {
  /** `nativeApplicationVersion`; null on web, where the server serves the current client. */
  appVersion: string | null;
  platform: string;
  /** `Platform.Version`: a string like "17.5" on iOS. */
  osVersion: string | number | null;
}

export function decideGate(config: ClientConfig | null, device: Device): Gate {
  if (!config || device.platform === 'web' || !device.appVersion) return { kind: 'none' };
  // An unreadable app version is a bug on our side, not the user's: let them in.
  if (compareVersions(device.appVersion, config.minVersion) !== -1) return { kind: 'none' };
  const minOs = config.minOs ?? DEFAULT_MIN_OS;
  if (device.platform === 'ios' && device.osVersion !== null
    && compareVersions(String(device.osVersion), minOs) === -1) {
    return { kind: 'sunset', latestVersion: config.latestVersion, minOs };
  }
  return { kind: 'update', storeUrl: config.storeUrl, latestVersion: config.latestVersion };
}

/** "18.0" reads as "iOS 18", "17.4" as "iOS 17.4". */
export function osLabel(version: string): string {
  return version.replace(/(\.0)+$/, '');
}

/**
 * Fetches and parses the config. Null on any failure, logged through `log`:
 * the caller treats null as "no gate".
 */
export async function fetchClientConfig(
  apiUrl: string,
  log: (detail: string) => void,
  fetcher: typeof fetch = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<ClientConfig | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${apiUrl}/client-config`, { signal: controller.signal });
    if (!response.ok) {
      log(`GET /client-config → ${response.status}; not gating`);
      return null;
    }
    const config = parseClientConfig(await response.json());
    if (!config) log('GET /client-config returned a malformed body; not gating');
    return config;
  } catch (error) {
    log(`GET /client-config failed: ${error instanceof Error ? error.message : String(error)}; not gating`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Accessibility props for the app behind the gate. The gate is drawn over the
 * navigator, so without these VoiceOver could still swipe into the screens it
 * covers (iOS reads `accessibilityElementsHidden`, Android the other).
 */
export function behindGate(blocking: boolean): {
  accessibilityElementsHidden: boolean;
  importantForAccessibility: 'auto' | 'no-hide-descendants';
} {
  return blocking
    ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }
    : { accessibilityElementsHidden: false, importantForAccessibility: 'auto' };
}
