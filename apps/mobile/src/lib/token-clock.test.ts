import { afterEach, describe, expect, it } from 'vitest';
import { jwtClaims, noteAuthEvent, offsetAtIssue, resetTokenClock, tokenClockOffset } from './token-clock';

/** An unsigned JWT with these claims (only the payload is read). */
const jwt = (claims: Record<string, unknown>): string => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJFUzI1NiJ9.${payload}.sig`;
};

describe('the media token clock', () => {
  afterEach(resetTokenClock);

  it('reads iat and exp from a JWT, and nothing from a shared token', () => {
    expect(jwtClaims(jwt({ iat: 1_700_000_000, exp: 1_700_003_600, sub: 'u' }))).toEqual({ iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(jwtClaims('a-shared-password')).toBeNull();
    expect(jwtClaims('a.%%%.c')).toBeNull();
  });

  it('measures device minus server when a refreshed token arrives', () => {
    const token = jwt({ iat: 1_700_000_000, exp: 1_700_003_600 });
    // The device clock reads 20 s behind the server's (plus a 0.3 s trip).
    expect(offsetAtIssue(token, (1_700_000_000 - 20 + 0.3) * 1000)).toBeCloseTo(-19.7, 3);
    noteAuthEvent('TOKEN_REFRESHED', token, (1_700_000_000 + 45) * 1000);
    expect(tokenClockOffset()).toBe(45);
  });

  it('keeps the smallest recent sample, and takes a jump only when the next sample agrees', () => {
    const at = (iat: number, deviceSeconds: number): void => noteAuthEvent('TOKEN_REFRESHED', jwt({ iat, exp: iat + 3600 }), deviceSeconds * 1000);
    at(1_700_000_000, 1_700_000_000 - 20 + 0.4);
    at(1_700_003_600, 1_700_003_600 - 20 + 2.5); // a slow refresh
    at(1_700_007_200, 1_700_007_200 - 20 + 0.1);
    expect(tokenClockOffset()).toBeCloseTo(-19.9, 3);
    // One reading 90 s off: held back.
    at(1_700_010_800, 1_700_010_800 + 70);
    expect(tokenClockOffset()).toBeCloseTo(-19.9, 3);
    // Back in line: the stray one is dropped.
    at(1_700_014_400, 1_700_014_400 - 19.5);
    expect(tokenClockOffset()).toBeCloseTo(-19.9, 3);
    // The device clock really moved 2 minutes: two samples in a row agree, and they win.
    at(1_700_018_000, 1_700_018_000 + 100.3);
    expect(tokenClockOffset()).toBeCloseTo(-19.9, 3);
    at(1_700_021_600, 1_700_021_600 + 100.1);
    expect(tokenClockOffset()).toBeCloseTo(100.1, 3);
  });

  it('ignores replayed sessions, absurd offsets and tokens without iat', () => {
    const issuedLongAgo = jwt({ iat: 1_700_000_000, exp: 1_700_003_600 });
    noteAuthEvent('SIGNED_IN', issuedLongAgo, (1_700_000_000 + 2_000) * 1000);
    noteAuthEvent('INITIAL_SESSION', issuedLongAgo, (1_700_000_000 + 2_000) * 1000);
    expect(tokenClockOffset()).toBeUndefined();
    noteAuthEvent('TOKEN_REFRESHED', issuedLongAgo, (1_700_000_000 + 2_000) * 1000);
    expect(tokenClockOffset()).toBeUndefined();
    noteAuthEvent('TOKEN_REFRESHED', jwt({ exp: 1_700_003_600 }), 1_700_000_000 * 1000);
    noteAuthEvent('TOKEN_REFRESHED', 'shared', 1_700_000_000 * 1000);
    expect(tokenClockOffset()).toBeUndefined();
  });
});
