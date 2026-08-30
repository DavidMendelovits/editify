import { AppState, Platform } from 'react-native';
import type { TelemetryEvent, TelemetryReceipt, TelemetryReport } from '@editify/shared';
import { apiFetch } from './api';

/** Newest events win — the buffer is a tail, never a growing log. */
const MAX_EVENTS = 60;
const FLUSH_INTERVAL = 60_000;

const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const platform = Platform.OS;
const appVersion = process.env.EXPO_PUBLIC_APP_VERSION;
let events: TelemetryEvent[] = [];
/** Set by the reporter UI; a captured error opens its modal instead of vanishing. */
let onError: ((error: { message: string; stack?: string }) => void) | undefined;

export function track(type: string, detail?: string): void {
  events.push({ at: new Date().toISOString(), type, ...(detail ? { detail: detail.slice(0, 400) } : {}) });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
}

/** Posts the buffered events plus whatever the caller is reporting, then clears them. */
export async function sendReport(
  kind: TelemetryReport['kind'],
  extra: Partial<Pick<TelemetryReport, 'error' | 'feedback'>> = {},
): Promise<TelemetryReceipt> {
  const report: TelemetryReport = { sessionId, kind, events, platform, ...(appVersion ? { appVersion } : {}), ...extra };
  events = [];
  const response = await apiFetch('/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  });
  if (!response.ok) throw new Error(`Report failed with ${response.status}`);
  return await response.json() as TelemetryReceipt;
}

/** Session log, best effort — losing it must never surface as an error. */
function flush(): void {
  if (!events.length) return;
  void sendReport('session').catch(() => undefined);
}

export function captureError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  track('error', message);
  onError?.({ message, ...(stack ? { stack } : {}) });
}

/**
 * Starts the session: global error capture, a periodic flush, and one final
 * flush when the app goes to the background (or the tab hides on web). Returns
 * the teardown for the effect that called it.
 */
export function startTelemetry(handler: (error: { message: string; stack?: string }) => void): () => void {
  onError = handler;
  track('app_open');
  const timer = setInterval(flush, FLUSH_INTERVAL);
  const teardown: Array<() => void> = [];

  if (Platform.OS === 'web') {
    const onWindowError = (event: ErrorEvent) => captureError(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => captureError(event.reason);
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('pagehide', flush);
    teardown.push(() => {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('pagehide', flush);
    });
  } else {
    // Reached through globalThis rather than the ambient global so the web
    // bundle, where React Native's ErrorUtils does not exist, still type-checks.
    const errorUtils = (globalThis as {
      ErrorUtils?: {
        getGlobalHandler: () => (error: unknown, isFatal?: boolean) => void;
        setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void;
      };
    }).ErrorUtils;
    if (errorUtils) {
      const previous = errorUtils.getGlobalHandler();
      errorUtils.setGlobalHandler((error, isFatal) => {
        captureError(error);
        previous(error, isFatal);
      });
      teardown.push(() => errorUtils.setGlobalHandler(previous));
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flush();
    });
    teardown.push(() => subscription.remove());
  }

  return () => {
    clearInterval(timer);
    for (const undo of teardown) undo();
    onError = undefined;
  };
}
