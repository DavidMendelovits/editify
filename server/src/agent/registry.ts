import { spawn } from 'node:child_process';
import type { ToolProvider } from './providers.js';
import { createProvider, defaultProviderId, type AgentProviderId } from './providers.js';
import type { SettingsStore } from '../db/settings-store.js';

export const PROVIDER_SETTING_KEY = 'agent.provider';

export interface ProviderOption {
  id: AgentProviderId;
  label: string;
  /** Whether this provider can actually run right now. */
  available: boolean;
  /** One line for the UI: how it runs, or what is missing. */
  detail: string;
}

export interface ProviderStatus {
  active: AgentProviderId;
  /** Set when the stored choice is unavailable and something else is running instead. */
  requested?: AgentProviderId;
  options: ProviderOption[];
}

/** Probed once per boot: shelling out on every status poll would be silly. */
let cliProbe: Promise<Record<'claude' | 'codex', boolean>> | undefined;

function canRun(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 5000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function probeClis(): Promise<Record<'claude' | 'codex', boolean>> {
  cliProbe ??= (async () => {
    const [claude, codex] = await Promise.all([canRun('claude'), canRun('codex')]);
    return { claude, codex };
  })();
  return await cliProbe;
}

export async function listProviders(): Promise<ProviderOption[]> {
  const cli = await probeClis();
  return [
    {
      id: 'claude-cli',
      label: 'Claude Code CLI',
      available: cli.claude,
      detail: cli.claude ? 'Runs on your local claude login, no API key needed' : 'claude is not on PATH',
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      available: cli.codex,
      detail: cli.codex ? 'Runs on your local codex login, no API key needed' : 'codex is not on PATH',
    },
    {
      id: 'anthropic',
      label: 'Anthropic API',
      available: Boolean(process.env.ANTHROPIC_API_KEY),
      detail: process.env.ANTHROPIC_API_KEY ? 'Anthropic Messages API' : 'ANTHROPIC_API_KEY is not set',
    },
    {
      id: 'openai',
      label: 'OpenAI API',
      available: Boolean(process.env.OPENAI_API_KEY ?? process.env.OPENAI_BASE_URL),
      detail: process.env.OPENAI_BASE_URL
        ? `OpenAI-compatible endpoint at ${process.env.OPENAI_BASE_URL}`
        : process.env.OPENAI_API_KEY ? 'OpenAI Chat Completions' : 'OPENAI_API_KEY is not set',
    },
    { id: 'mock', label: 'Offline mock', available: true, detail: 'Deterministic keyword agent: free and instant' },
  ];
}

function isProviderId(value: string | undefined): value is AgentProviderId {
  return value === 'claude-cli' || value === 'codex-cli' || value === 'anthropic' || value === 'openai' || value === 'mock';
}

/**
 * Resolves the provider for one chat turn: the stored UI choice when it is still
 * usable, otherwise whatever the environment supports. Reading it per request is
 * what lets the picker take effect without a server restart. The choice is per
 * user, falling back to the global one (no user reads and writes the global).
 */
export class ProviderRegistry {
  constructor(private readonly settings: SettingsStore) {}

  private stored(userId?: string): AgentProviderId | undefined {
    const value = this.settings.getFor(PROVIDER_SETTING_KEY, userId);
    return isProviderId(value) ? value : undefined;
  }

  async status(userId?: string): Promise<ProviderStatus> {
    const options = await listProviders();
    const requested = this.stored(userId);
    const usable = requested && options.find((option) => option.id === requested)?.available;
    return {
      active: usable ? requested : defaultProviderId(),
      ...(requested && !usable ? { requested } : {}),
      options,
    };
  }

  async select(id: AgentProviderId, userId?: string): Promise<ProviderStatus> {
    const options = await listProviders();
    const chosen = options.find((option) => option.id === id);
    if (!chosen?.available) throw new Error(`${id} is not available: ${chosen?.detail ?? 'unknown provider'}`);
    this.settings.setFor(PROVIDER_SETTING_KEY, id, userId);
    return await this.status(userId);
  }

  /**
   * The provider a turn will actually run with. Mirrors `status().active` —
   * an unavailable stored choice falls back instead of dying in spawn.
   */
  async resolve(userId?: string): Promise<ToolProvider> {
    const { active } = await this.status(userId);
    return createProvider(active);
  }
}
