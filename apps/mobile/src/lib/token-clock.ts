/**
 * How far this device's clock runs ahead of the auth server's (negative: behind), for the native
 * preview's media-token deadlines: a token's `exp` is server time, the player's timers run on
 * device time.
 *
 * Measured when a token is issued: on a refresh, `iat` is the server's "now" and the moment it
 * arrives is the device's, so the offset is device − server plus the trip (late by the latency,
 * which the native lead of 30 s absorbs). Not from `session.expires_at`: auth-js computes that on
 * the device only when the server leaves it out, and GoTrue's token response includes it, so it
 * is server time too and their difference is ~0. Only TOKEN_REFRESHED counts: a SIGNED_IN can
 * replay a stored session issued long ago, and an offset over 10 minutes is taken as that kind
 * of misreading, not a clock.
 *
 * Latency only ever adds to a sample, so the offset is the smallest of the last few. A sample
 * more than 60 s from it (a slow refresh, a stray reading) is held back, and taken (starting the
 * samples over) only when the next one agrees with it within 5 s: the device clock really moved.
 *
 * Before the first refresh the offset is unknown and native uses 0: a deadline off by the skew.
 * Its 30 s lead covers a skew under 30 s; past that, the starvation watch (the clock running
 * past the compositor) is the backstop once reads are refused.
 */

const MAX_OFFSET_S = 600;

const KEEP = 5;
const JUMP_S = 60;
const AGREE_S = 5;

/** Recent accepted samples (device − server, seconds), newest last. */
let samples: number[] = [];
/** A sample that jumped: taken if the next one agrees with it. */
let held: number | undefined;

/** A JWT's claims, or null for anything that isn't one (a shared token). */
export function jwtClaims(token: string): { iat?: number; exp?: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(globalThis.atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='))) as Record<string, unknown>;
    return {
      ...(typeof json.iat === 'number' ? { iat: json.iat } : {}),
      ...(typeof json.exp === 'number' ? { exp: json.exp } : {}),
    };
  } catch {
    return null;
  }
}

/** device − server seconds, from a token received at `receivedAtMs` (device clock) just after it was issued. */
export function offsetAtIssue(token: string, receivedAtMs: number): number | undefined {
  const iat = jwtClaims(token)?.iat;
  if (iat === undefined) return undefined;
  const value = receivedAtMs / 1000 - iat;
  return Math.abs(value) <= MAX_OFFSET_S ? Math.round(value * 1000) / 1000 : undefined;
}

/** Called for every auth event (supabase.ts). */
export function noteAuthEvent(event: string, accessToken: string | undefined, nowMs: number = Date.now()): void {
  if (event !== 'TOKEN_REFRESHED' || !accessToken) return;
  const measured = offsetAtIssue(accessToken, nowMs);
  if (measured === undefined) return;
  const current = tokenClockOffset();
  if (current === undefined || Math.abs(measured - current) <= JUMP_S) {
    held = undefined;
    samples = [...samples, measured].slice(-KEEP);
    return;
  }
  if (held !== undefined && Math.abs(measured - held) <= AGREE_S) {
    samples = [held, measured];
    held = undefined;
    return;
  }
  held = measured;
}

/** The smallest recent sample (latency only inflates them), or undefined before the first refresh. */
export function tokenClockOffset(): number | undefined {
  return samples.length > 0 ? Math.min(...samples) : undefined;
}

/** Tests only. */
export function resetTokenClock(): void {
  samples = [];
  held = undefined;
}
