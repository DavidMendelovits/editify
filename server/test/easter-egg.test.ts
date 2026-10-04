import { describe, expect, it } from 'vitest';
// Straight from source: `@editify/shared` resolves to the package's build
// output, which lags the module this file exercises.
import { isOwnerEmail } from '../../packages/shared/src/easterEgg.js';

describe('isOwnerEmail', () => {
  it('accepts every gmail-family alias of the owner', () => {
    expect(isOwnerEmail('david.mendelovits@gmail.com')).toBe(true);
    expect(isOwnerEmail('david.mendelovits+editify-qa2@gmail.com')).toBe(true);
    expect(isOwnerEmail('DavidMendelovits@googlemail.com')).toBe(true);
  });

  it('rejects everyone else', () => {
    expect(isOwnerEmail('')).toBe(false);
    expect(isOwnerEmail(null)).toBe(false);
    expect(isOwnerEmail('someone.else@gmail.com')).toBe(false);
    expect(isOwnerEmail('david.mendelovits@example.com')).toBe(false);
  });
});
