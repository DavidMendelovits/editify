import { describe, expect, it } from 'vitest';
import type { EngineCapabilities } from '../../modules/editify-engine';
import { lineOf, secondsSince, superProperties } from './analytics-properties';
import { createCapabilityCache, readCapabilities, tierOf, type Capabilities } from './engine-capabilities';

const legacy: EngineCapabilities = {
  os: '18.0.0',
  adapterSet: 'legacy',
  transcriber: { order: ['sfspeech'], lastRan: 'sfspeech', best: 'w-sf1', versions: { sfspeech: 'w-sf1' }, trigger: 'os=18.0;sa=0' },
  speechAuthorization: 'authorized',
  backgroundExport: 'foreground',
  backgroundGPU: false,
  composition: 'mutable',
  tier: 'low',
};

describe('PostHog super-properties (C12)', () => {
  it('tags line, os, tier, transcriber and background export from the capabilities and the build', () => {
    expect(superProperties(legacy, { appVersion: '1.1.0', platformVersion: '18.0' })).toEqual({
      line: '1.1', os: '18.0.0', tier: 'low', transcriber: 'sfspeech', bgExport: 'foreground',
    });
  });

  it('falls back to the platform version and nulls without an engine (web, older binaries)', () => {
    expect(superProperties({}, { appVersion: '1.0.3', platformVersion: 17 })).toEqual({ line: '1.0', os: '17', tier: null, transcriber: null, bgExport: null });
    expect(superProperties({ ...legacy, tier: null, transcriber: { ...legacy.transcriber, lastRan: null } }, { appVersion: null })).toMatchObject({
      line: 'dev', tier: null, transcriber: null,
    });
  });

  it('reads the line as major.minor', () => {
    expect(lineOf('1.1.0')).toBe('1.1');
    expect(lineOf('1.10.2')).toBe('1.10');
    expect(lineOf('v1')).toBe('dev');
    expect(lineOf(undefined)).toBe('dev');
  });

  it('times exports to a tenth of a second, never negative', () => {
    expect(secondsSince(1_000, 13_349)).toBe(12.3);
    expect(secondsSince(5_000, 4_000)).toBe(0);
  });
});

describe('engine capabilities', () => {
  it('reads capabilities, falls back to exportCapabilities, and answers {} without an engine or on a throw', () => {
    expect(readCapabilities(null)).toEqual({});
    expect(readCapabilities({ exportCapabilities: () => ({ backgroundGPU: false }) })).toEqual({ backgroundGPU: false });
    expect(readCapabilities({ exportCapabilities: () => { throw new Error('gone'); } })).toEqual({});
    expect(readCapabilities({ exportCapabilities: () => ({ backgroundGPU: false }), capabilities: () => legacy }).tier).toBe('low');
  });

  it('reads the tier, null for anything unknown', () => {
    expect(tierOf({ tier: 'low' })).toBe('low');
    expect(tierOf({ tier: 'standard' })).toBe('standard');
    expect(tierOf({ tier: null })).toBeNull();
    expect(tierOf({})).toBeNull();
    expect(tierOf({ tier: 'huge' } as unknown as Capabilities)).toBeNull();
  });

  it('reads once at startup, again on refresh, telling listeners', () => {
    let reads = 0;
    const cache = createCapabilityCache({ exportCapabilities: () => ({ backgroundGPU: false }), capabilities: () => { reads += 1; return legacy; } });
    const heard: Capabilities[] = [];
    cache.subscribe((value) => heard.push(value));
    cache.current();
    cache.current();
    expect(reads).toBe(1);
    cache.refresh();
    expect(reads).toBe(2);
    expect(heard).toHaveLength(2);
  });
});
