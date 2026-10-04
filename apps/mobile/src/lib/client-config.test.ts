import { describe, expect, it, vi } from 'vitest';
import { behindGate, compareVersions, decideGate, fetchClientConfig, osLabel, parseClientConfig, type ClientConfig } from './client-config';

const STORE = 'https://apps.apple.com/app/id6814607865';
const config = (overrides: Partial<ClientConfig> = {}): ClientConfig => ({
  minVersion: '1.1.0', latestVersion: '1.1.0', storeUrl: STORE, ...overrides,
});
const iphone = (appVersion: string | null, osVersion: string | number | null = '18.2') => ({ appVersion, platform: 'ios', osVersion });

describe('compareVersions', () => {
  it('compares part by part as numbers, not strings', () => {
    expect(compareVersions('1.0.9', '1.1.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });

  it('reads missing parts as zero', () => {
    expect(compareVersions('18', '18.0')).toBe(0);
    expect(compareVersions('17.5', '18.0')).toBe(-1);
    expect(compareVersions('1.1', '1.0.9')).toBe(1);
  });

  it('refuses to guess at something that is not a version', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeNull();
    expect(compareVersions('', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', 'latest')).toBeNull();
  });
});

describe('decideGate', () => {
  it('lets a current or newer app straight in', () => {
    expect(decideGate(config(), iphone('1.1.0'))).toEqual({ kind: 'none' });
    expect(decideGate(config(), iphone('1.2.0'))).toEqual({ kind: 'none' });
    expect(decideGate(config({ minVersion: '1.0.0' }), iphone('1.0.0'))).toEqual({ kind: 'none' });
  });

  it('sends an old app on a supported iOS to the store', () => {
    expect(decideGate(config(), iphone('1.0.9', '18.0'))).toEqual({ kind: 'update', storeUrl: STORE, latestVersion: '1.1.0' });
    expect(decideGate(config(), iphone('1.0.0', '26.1'))).toMatchObject({ kind: 'update' });
  });

  it('shows the sunset export screen when iOS is below the new floor', () => {
    expect(decideGate(config(), iphone('1.0.0', '17.5'))).toEqual({ kind: 'sunset', latestVersion: '1.1.0', minOs: '18.0' });
    expect(decideGate(config({ minOs: '18.2' }), iphone('1.0.0', '18.1'))).toMatchObject({ kind: 'sunset', minOs: '18.2' });
    expect(decideGate(config({ minOs: '17.0' }), iphone('1.0.0', '17.5'))).toMatchObject({ kind: 'update' });
  });

  it('never sunsets off iOS: Android and an unknown OS get the store button', () => {
    expect(decideGate(config(), { appVersion: '1.0.0', platform: 'android', osVersion: 34 })).toMatchObject({ kind: 'update' });
    expect(decideGate(config(), iphone('1.0.0', null))).toMatchObject({ kind: 'update' });
  });

  it('fails open: no config, web, or an unreadable app version never gates', () => {
    expect(decideGate(null, iphone('0.1.0'))).toEqual({ kind: 'none' });
    expect(decideGate(config(), { appVersion: null, platform: 'web', osVersion: null })).toEqual({ kind: 'none' });
    expect(decideGate(config(), { appVersion: '1.0.0', platform: 'web', osVersion: null })).toEqual({ kind: 'none' });
    expect(decideGate(config(), iphone(null))).toEqual({ kind: 'none' });
    expect(decideGate(config(), iphone('banana'))).toEqual({ kind: 'none' });
  });
});

describe('parseClientConfig', () => {
  it('accepts the server shape and defaults latestVersion to the floor', () => {
    expect(parseClientConfig({ minVersion: '1.0.0', storeUrl: STORE })).toEqual({ minVersion: '1.0.0', latestVersion: '1.0.0', storeUrl: STORE });
    expect(parseClientConfig({ minVersion: '1.1.0', latestVersion: '1.1.2', storeUrl: STORE, minOs: '18.0' }))
      .toEqual({ minVersion: '1.1.0', latestVersion: '1.1.2', storeUrl: STORE, minOs: '18.0' });
    expect(parseClientConfig({ minVersion: '1.1.0', storeUrl: STORE, testServer: true })?.testServer).toBe(true);
    // Anything but a literal true (an older server, a typo) is not a test server.
    expect(parseClientConfig({ minVersion: '1.1.0', storeUrl: STORE, testServer: 'true' })).not.toHaveProperty('testServer');
  });

  it('rejects anything malformed', () => {
    expect(parseClientConfig(null)).toBeNull();
    expect(parseClientConfig('1.1.0')).toBeNull();
    expect(parseClientConfig({ minVersion: 110, storeUrl: STORE })).toBeNull();
    expect(parseClientConfig({ minVersion: '1.1.0' })).toBeNull();
    expect(parseClientConfig({ minVersion: '1.1.0', storeUrl: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('fetchClientConfig', () => {
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('returns the parsed config', async () => {
    const log = vi.fn();
    expect(await fetchClientConfig('https://api.test', log, ok({ minVersion: '1.1.0', storeUrl: STORE })))
      .toEqual({ minVersion: '1.1.0', latestVersion: '1.1.0', storeUrl: STORE });
    expect(log).not.toHaveBeenCalled();
  });

  it('fails open and logs on a network error, an error status, a bad body, or a timeout', async () => {
    const log = vi.fn();
    const offline = vi.fn(async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch;
    const down = vi.fn(async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    const html = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    const hangs = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;

    expect(await fetchClientConfig('https://api.test', log, offline)).toBeNull();
    expect(await fetchClientConfig('https://api.test', log, down)).toBeNull();
    expect(await fetchClientConfig('https://api.test', log, ok({ nope: true }))).toBeNull();
    expect(await fetchClientConfig('https://api.test', log, html)).toBeNull();
    expect(await fetchClientConfig('https://api.test', log, hangs, 10)).toBeNull();
    expect(log).toHaveBeenCalledTimes(5);
    // And a null config is no gate at all.
    expect(decideGate(null, iphone('1.0.0', '17.0'))).toEqual({ kind: 'none' });
  });
});

describe('osLabel', () => {
  it('drops trailing zero parts', () => {
    expect(osLabel('18.0')).toBe('18');
    expect(osLabel('17.4')).toBe('17.4');
  });
});

describe('behindGate', () => {
  it('hides the app from VoiceOver and TalkBack only while the gate blocks', () => {
    expect(behindGate(true)).toEqual({ accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' });
    expect(behindGate(false)).toEqual({ accessibilityElementsHidden: false, importantForAccessibility: 'auto' });
  });
});
