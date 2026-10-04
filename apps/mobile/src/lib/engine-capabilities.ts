/**
 * What the native composition root picked for this process (D5, D13), read once at startup and
 * again after analysis events (the transcriber that last ran, the C25 trigger) and speech
 * permission changes. Everything else reads the cached copy: the export route (tier), the speech
 * pre-prompt (transcriber, permission) and the PostHog super-properties.
 *
 *   startup ─▶ capabilities() ─▶ cache ─┬─ routeExport (tier: low ─▶ server, why 'device')
 *   analysisStatus words ready ─┐       ├─ speech pre-prompt (sfspeech first + notDetermined)
 *   speechAuthorization event ──┴─▶ refresh ─▶ listeners ─▶ PostHog super-properties
 *
 * Free of React Native: the engine is passed in, so it runs under vitest.
 */
import type { DeviceTier, EditifyEngineNative, EngineCapabilities } from '../../modules/editify-engine';

/** What the app knows about the engine: every field optional, for older binaries and no engine at all. */
export type Capabilities = Partial<EngineCapabilities>;

type CapabilitySource = Pick<EditifyEngineNative, 'exportCapabilities'> & Partial<Pick<EditifyEngineNative, 'capabilities'>>;

/** The engine's answer, or {} when there is no engine or the call throws. */
export function readCapabilities(engine: CapabilitySource | null | undefined): Capabilities {
  if (!engine) return {};
  try {
    return engine.capabilities?.() ?? engine.exportCapabilities();
  } catch {
    return {};
  }
}

/** The RAM tier, or null when the binary doesn't report one (no engine, before T7). */
export function tierOf(capabilities: Capabilities): DeviceTier | null {
  const tier = capabilities.tier;
  return tier === 'full' || tier === 'standard' || tier === 'low' ? tier : null;
}

export interface CapabilityCache {
  current(): Capabilities;
  /** Reads the engine again; listeners hear the new value. */
  refresh(): Capabilities;
  subscribe(listener: (capabilities: Capabilities) => void): () => void;
}

export function createCapabilityCache(engine: CapabilitySource | null | undefined): CapabilityCache {
  let cached: Capabilities | undefined;
  const listeners = new Set<(capabilities: Capabilities) => void>();
  const refresh = (): Capabilities => {
    cached = readCapabilities(engine);
    for (const listener of listeners) listener(cached);
    return cached;
  };
  return {
    current: () => cached ?? refresh(),
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
