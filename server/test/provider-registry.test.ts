import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { SettingsStore } from '../src/db/settings-store.js';
import { createProvider } from '../src/agent/providers.js';
import { ffmpegAnalyzer } from '../src/style/analyzers/ffmpeg.js';
import { StyleAnalyzerRegistry } from '../src/style/registry.js';

describe('agent provider', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('runs on the Anthropic API when the key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(createProvider().name).toBe('anthropic');
  });

  it('falls back to the mock only when there is no key', () => {
    expect(createProvider().name).toBe('mock');
  });

  it('refuses an explicit anthropic provider without the key instead of downgrading', () => {
    expect(() => createProvider('anthropic')).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('analyzer registry', () => {
  let database: EditifyDatabase;
  let settings: SettingsStore;

  beforeEach(() => {
    database = createDatabase(':memory:');
    settings = new SettingsStore(database);
  });

  afterEach(() => { database.close(); });

  it('keeps an analyzer choice per user', async () => {
    const analyzers = new StyleAnalyzerRegistry(settings, [ffmpegAnalyzer, { ...ffmpegAnalyzer, id: 'local', label: 'Local' }], {});
    await analyzers.select('local', 'alice');
    expect((await analyzers.status('alice')).active).toBe('local');
    expect((await analyzers.status('bob')).active).toBe('ffmpeg');
    expect((await analyzers.resolve('alice')).id).toBe('local');
    await analyzers.select('local');
    expect((await analyzers.status('bob')).active).toBe('local');
  });
});
