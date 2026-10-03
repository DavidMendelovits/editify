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
