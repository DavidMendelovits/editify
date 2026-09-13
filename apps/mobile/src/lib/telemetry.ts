import { AppState, Dimensions, Platform } from 'react-native';
import type { TelemetryContext, TelemetryEnvironment, TelemetryEvent, TelemetryReceipt, TelemetryReport } from '@editify/shared';
import { apiFetch } from './api';

/** Newest events win — the buffer is a tail, never a growing log. */
const MAX_EVENTS = 60;
/**
 * How much of the log survives a send. The periodic flush used to clear the
 * buffer outright, so a report written a minute into a quiet stretch arrived
 * with "no events" and a triager had nothing to reconstruct. Keeping a tail
 * costs a few repeated lines across reports and buys every report a history.
 */
const RETAINED_EVENTS = 25;
const FLUSH_INTERVAL = 60_000;

const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const platform = Platform.OS;
const appVersion = process.env.EXPO_PUBLIC_APP_VERSION;
const sessionStart = Date.now();
let events: TelemetryEvent[] = [];
/** Set by the reporter UI; a captured error opens its modal instead of vanishing. */
let onError: ((error: { message: string; stack?: string }) => void) | undefined;
/** Registered by whichever screen is mounted; read at send time, never cached. */
let contextSource: (() => TelemetryContext) | undefined;
/** Events tracked since the last send. The retained tail must not re-flush on its own. */
let unsent = 0;

export function track(type: string, detail?: string): void {
  events.push({ at: new Date().toISOString(), type, ...(detail ? { detail: detail.slice(0, 400) } : {}) });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  unsent += 1;
}

/**
 * Lets the current screen describe itself to any report sent while it is up:
 * which project is open, how big the timeline is, what is selected. Returns the
 * teardown, so a screen unmounting takes its context with it rather than
 * attaching stale numbers to the next screen's report.
 */
export function setReportContext(source: () => TelemetryContext): () => void {
  contextSource = source;
  return () => { if (contextSource === source) contextSource = undefined; };
}

/** Never let a screen's snapshot throw on the path that sends a crash report. */
function collectContext(): TelemetryContext | undefined {
  try {
    const context = contextSource?.();
    return context && Object.keys(context).length ? context : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the browser or device can tell us about itself. Wrapped whole because
 * this runs while reporting a crash: a missing API here must not replace the
 * user's report with a second error.
 */
function collectEnvironment(): TelemetryEnvironment {
  const base: TelemetryEnvironment = { sessionSeconds: Math.round((Date.now() - sessionStart) / 1000) };
  try {
    const window = Dimensions.get('window');
    const screen = Dimensions.get('screen');
    base.viewport = `${Math.round(window.width)}x${Math.round(window.height)}`;
    base.screen = `${Math.round(screen.width)}x${Math.round(screen.height)}`;
    base.pixelRatio = Number(window.scale.toFixed(2));
    base.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Dimensions or Intl unavailable: the rest of the snapshot is still useful.
  }
  if (Platform.OS !== 'web') return base;
  try {
    const nav = globalThis.navigator as (Navigator & {
      connection?: { effectiveType?: string; downlink?: number };
      deviceMemory?: number;
    }) | undefined;
    base.userAgent = nav?.userAgent?.slice(0, 400);
    base.language = nav?.language;
    base.online = nav?.onLine;
    base.cpuCores = nav?.hardwareConcurrency;
    base.deviceMemoryGb = nav?.deviceMemory;
    base.touch = typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints > 0 : undefined;
    const connection = nav?.connection;
    if (connection?.effectiveType) {
      base.connection = connection.downlink
        ? `${connection.effectiveType}, ${connection.downlink}Mbps`
        : connection.effectiveType;
    }
    const media = globalThis.matchMedia?.bind(globalThis);
    if (media) {
      base.colorScheme = media('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      base.reducedMotion = media('(prefers-reduced-motion: reduce)').matches;
    }
    // Path only. A query string here can carry a recovery token or an email,
    // and none of it helps a triager more than the route already does.
    base.path = globalThis.location?.pathname;
  } catch {
    // A locked down or non standard browser: send what we already gathered.
  }
  return base;
}

/**
 * One line for the report sheet naming what the payload carries beyond the
 * user's own words. The reporter shows it before anything is sent.
 */
export function describeAttachments(): string {
  const context = collectContext();
  const parts = [
    `${platform} session`,
    ...(context?.screen ? [`the ${String(context.screen)} screen`] : []),
    ...(context?.projectId ? ['the open project'] : []),
    ...(events.length ? [`your last ${events.length} ${events.length === 1 ? 'action' : 'actions'}`] : []),
    'browser and screen details',
  ];
  return `${parts.join(', ')}.`;
}

/**
 * Posts the buffered events plus whatever the caller is reporting. A tail of the
 * log stays behind so the next report still has history to show.
 */
export async function sendReport(
  kind: TelemetryReport['kind'],
  extra: Partial<Pick<TelemetryReport, 'error' | 'feedback'>> = {},
): Promise<TelemetryReceipt> {
  const context = collectContext();
  const report: TelemetryReport = {
    sessionId,
    kind,
    events,
    platform,
    ...(appVersion ? { appVersion } : {}),
    environment: collectEnvironment(),
    ...(context ? { context } : {}),
    ...extra,
  };
  events = events.slice(-RETAINED_EVENTS);
  unsent = 0;
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
  if (!unsent) return;
  void sendReport('session').catch(() => undefined);
}

export function captureError(error: unknown): void {
  // Clamped to what telemetryReportSchema accepts — a bundled web stack runs
  // well past 8000 characters, and an empty message fails its min(1), either of
  // which would 400 the report the user just chose to send.
  const raw = error instanceof Error ? error.message : String(error);
  const message = (raw.trim() || 'Unknown error').slice(0, 2000);
  const stack = error instanceof Error ? error.stack?.slice(0, 8000) : undefined;
  track('error', message);
  // The preview <video> rejects play() for entirely routine reasons — a pause()
  // arriving mid-play, or autoplay before the first user gesture. Those are
  // worth logging but must not raise the "something broke" dialog: it is
  // fixed-position and full-bleed, so it swallows every click behind it
  // (including the header's "‹ PROJECTS"), with nothing on screen to explain why.
  if (/play\(\)|The fetching process for the media resource was aborted/.test(message)) return;
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
