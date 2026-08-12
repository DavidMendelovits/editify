import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { SettingsStore } from '../src/db/settings-store.js';
import { PROVIDER_SETTING_KEY, ProviderRegistry } from '../src/agent/registry.js';

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

  it('ignores an unrecognised stored value', async () => {
    settings.set(PROVIDER_SETTING_KEY, 'gpt-9-ultra');
    const status = await registry.status();
    expect(status.active).toBe('mock');
    expect(status.requested).toBeUndefined();
  });
});
