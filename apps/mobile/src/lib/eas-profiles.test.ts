import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Profile { extends?: string; env?: Record<string, string> }
const { build } = JSON.parse(readFileSync(decodeURIComponent(new URL('../../eas.json', import.meta.url).pathname), 'utf8')) as { build: Record<string, Profile> };

/**
 * A profile's env with its `extends` chain merged, the way EAS builds it and the way ci.yml's
 * "Give the update its build profile's env" step exports it for `eas update` (which reads no
 * build env itself). So a build and an OTA on the same profile see the same EXPO_PUBLIC_* values.
 */
function resolvedEnv(name: string): Record<string, string> {
  const profile = build[name];
  if (!profile) throw new Error(`eas.json has no build profile ${name}`);
  return { ...(profile.extends ? resolvedEnv(profile.extends) : {}), ...profile.env };
}

describe('eas.json: the native preview (decision D2)', () => {
  it('is on for preview-1.1 builds and their updates', () => {
    expect(resolvedEnv('preview-1.1').EXPO_PUBLIC_NATIVE_PREVIEW).toBe('1');
  });

  it('stays off for production-1.1 and the 1.0 profiles', () => {
    for (const name of ['base', 'development', 'preview', 'production', 'production-1.1']) {
      expect(resolvedEnv(name), name).not.toHaveProperty('EXPO_PUBLIC_NATIVE_PREVIEW');
    }
  });

  it('keeps each 1.1 profile on the 1.1 server', () => {
    expect(resolvedEnv('preview-1.1').EXPO_PUBLIC_API_URL).toBe('https://editify-v11.fly.dev');
    expect(resolvedEnv('production-1.1').EXPO_PUBLIC_API_URL).toBe('https://editify-v11.fly.dev');
  });
});
