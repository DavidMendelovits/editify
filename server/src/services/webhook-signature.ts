import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIMESTAMP_HEADER = 'x-editify-webhook-timestamp';
export const SIGNATURE_HEADER = 'x-editify-webhook-signature';

/** How old a delivery may be before it is treated as a replay. */
export const MAX_AGE_SECONDS = 5 * 60;
/** Clock skew allowed in the other direction, between Postgres and this machine. */
export const MAX_FUTURE_SKEW_SECONDS = 30;

/**
 * `v1=` + hex HMAC-SHA256 over `<timestamp>.<raw body>`. The timestamp is inside
 * the MAC, so an old body cannot be replayed under a fresh timestamp. The SQL
 * sender (supabase/migrations) computes exactly this with pgcrypto.
 */
export function signWebhook(secret: string, timestamp: string, rawBody: string | Buffer): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

export type WebhookVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing-headers' | 'bad-timestamp' | 'stale' | 'future' | 'bad-signature' };

export function verifyWebhook(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
  nowSeconds?: number;
}): WebhookVerdict {
  const { secret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return { ok: false, reason: 'missing-headers' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = now - Number(timestamp);
  if (age > MAX_AGE_SECONDS) return { ok: false, reason: 'stale' };
  if (age < -MAX_FUTURE_SKEW_SECONDS) return { ok: false, reason: 'future' };
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const offered = Buffer.from(signature);
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true };
}
