import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { SettingsStore } from '../src/db/settings-store.js';
import { createProvider } from '../src/agent/providers.js';
import { PROVIDER_SETTING_KEY, ProviderRegistry } from '../src/agent/registry.js';
import { ffmpegAnalyzer } from '../src/style/analyzers/ffmpeg.js';
import { StyleAnalyzerRegistry } from '../src/style/registry.js';

describe('provider registry', () => {
  let database: EditifyDatabase;
  let settings: SettingsStore;
  let registry: ProviderRegistry;
  const savedKeys = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, cli: process.env.EDITIFY_AGENT_CLI };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EDITIFY_AGENT_CLI;
    database = createDatabase(':memory:');
    settings = new SettingsStore(database);
    registry = new ProviderRegistry(settings);
  });

  afterEach(() => {
    database.close();
    for (const [name, value] of [['ANTHROPIC_API_KEY', savedKeys.anthropic], ['OPENAI_API_KEY', savedKeys.openai], ['EDITIFY_AGENT_CLI', savedKeys.cli]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('defaults to the mock agent when nothing is configured', async () => {
    const status = await registry.status();
    expect(status.active).toBe('mock');
    expect(status.requested).toBeUndefined();
    expect(status.options.find((option) => option.id === 'mock')?.available).toBe(true);
  });

  it('persists a selection and reports it as active', async () => {
    await registry.select('mock');
    expect(settings.get(PROVIDER_SETTING_KEY)).toBe('mock');
    expect((await new ProviderRegistry(settings).status()).active).toBe('mock');
  });

  it('refuses a provider whose requirement is missing', async () => {
    await expect(registry.select('anthropic')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(settings.get(PROVIDER_SETTING_KEY)).toBeUndefined();
  });

  it('falls back and flags the request when a stored choice stops being usable', async () => {
    // Selected while a key was present; the key is gone by the time it is read back.
    settings.set(PROVIDER_SETTING_KEY, 'anthropic');
    const status = await registry.status();
    expect(status.active).toBe('mock');
    expect(status.requested).toBe('anthropic');
  });

  it('keeps a choice per user, falling back to the global one', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    await registry.select('openai');
    expect((await registry.status('alice')).active).toBe('openai');

    await registry.select('mock', 'alice');
    expect(settings.get(`${PROVIDER_SETTING_KEY}:alice`)).toBe('mock');
    expect((await registry.status('alice')).active).toBe('mock');
    // Alice's pick changes nobody else's, and never the global default.
    expect((await registry.status('bob')).active).toBe('openai');
    expect((await registry.status()).active).toBe('openai');
    expect((await registry.resolve('alice')).name).toBe(createProvider('mock').name);
  });

  it('keeps an analyzer choice per user too', async () => {
    const analyzers = new StyleAnalyzerRegistry(settings, [ffmpegAnalyzer, { ...ffmpegAnalyzer, id: 'local', label: 'Local' }], {});
    await analyzers.select('local', 'alice');
    expect((await analyzers.status('alice')).active).toBe('local');
    expect((await analyzers.status('bob')).active).toBe('ffmpeg');
    expect((await analyzers.resolve('alice')).id).toBe('local');
    await analyzers.select('local');
    expect((await analyzers.status('bob')).active).toBe('local');
  });

  it('ignores an unrecognised stored value', async () => {
    settings.set(PROVIDER_SETTING_KEY, 'gpt-9-ultra');
    const status = await registry.status();
    expect(status.active).toBe('mock');
    expect(status.requested).toBeUndefined();
  });
});
