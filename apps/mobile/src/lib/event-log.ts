import type { TelemetryEvent } from '@editify/shared';

/**
 * The session's rolling event log. It lives in its own module, free of imports,
 * because everything that has something to log (the API client included) needs
 * `track`, and routing that through `telemetry.ts` would make the API client and
 * the reporter import each other.
 */

/** Newest events win — the buffer is a tail, never a growing log. */
const MAX_EVENTS = 60;
/**
 * How much of the log survives a send. The periodic flush used to clear the
 * buffer outright, so a report written a minute into a quiet stretch arrived
 * with "no events" and a triager had nothing to reconstruct. Keeping a tail
 * costs a few repeated lines across reports and buys every report a history.
 */
const RETAINED_EVENTS = 25;

let events: TelemetryEvent[] = [];
/** Events tracked since the last send. The retained tail must not re-flush on its own. */
let unsent = 0;

export function track(type: string, detail?: string): void {
  events.push({ at: new Date().toISOString(), type, ...(detail ? { detail: detail.slice(0, 400) } : {}) });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  unsent += 1;
}

export function currentEvents(): TelemetryEvent[] {
  return events;
}

export function hasUnsentEvents(): boolean {
  return unsent > 0;
}

/** Called once a report is on its way: keep the tail, forget that it is pending. */
export function markSent(): void {
  events = events.slice(-RETAINED_EVENTS);
  unsent = 0;
}
