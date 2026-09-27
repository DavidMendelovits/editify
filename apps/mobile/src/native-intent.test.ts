import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-share-intent', () => ({ getShareExtensionKey: () => 'editifyShareKey' }));

const { redirectSystemPath } = await import('../app/+native-intent');

describe('redirectSystemPath', () => {
  it('swallows the share extension wake-up so a running app stays where it is', () => {
    expect(redirectSystemPath({ path: 'editify://dataUrl=editifyShareKey#file', initial: false })).toBe('');
    expect(redirectSystemPath({ path: 'editify://dataUrl=editifyShareKey#media', initial: true })).toBe('');
  });

  it('passes every other link through untouched', () => {
    expect(redirectSystemPath({ path: 'editify://project/abc', initial: false })).toBe('editify://project/abc');
    expect(redirectSystemPath({ path: '/sign-in', initial: true })).toBe('/sign-in');
  });
});
