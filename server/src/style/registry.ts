import type { SettingsStore } from '../db/settings-store.js';
import type { VideoAnalyzer } from './analyzer.js';
import { ffmpegAnalyzer } from './analyzers/ffmpeg.js';
import { GeminiVideoAnalyzer } from './analyzers/gemini.js';
import { WebhookVideoAnalyzer } from './analyzers/webhook.js';

export const ANALYZER_SETTING_KEY = 'style.analyzer';

export interface AnalyzerOption {
  id: string;
  label: string;
  available: boolean;
  detail: string;
  watches: boolean;
}

export interface AnalyzerStatus {
  active: string;
  /** Set when the stored choice is unavailable and something else is running instead. */
  requested?: string;
  options: AnalyzerOption[];
}

/** The analyzers the environment can offer, most capable first. */
export function builtInAnalyzers(env: NodeJS.ProcessEnv = process.env): VideoAnalyzer[] {
  const analyzers: VideoAnalyzer[] = [];
  analyzers.push(new GeminiVideoAnalyzer({
    apiKey: env.GEMINI_API_KEY ?? '',
    ...(env.GEMINI_MODEL ? { model: env.GEMINI_MODEL } : {}),
  }));
  analyzers.push(new WebhookVideoAnalyzer({
    url: env.EDITIFY_STYLE_ANALYZER_URL ?? '',
    ...(env.EDITIFY_STYLE_ANALYZER_TOKEN ? { token: env.EDITIFY_STYLE_ANALYZER_TOKEN } : {}),
  }));
  analyzers.push(ffmpegAnalyzer);
  return analyzers;
}

/**
 * Which analyzer the next "learn my style" run uses: the stored UI choice when
 * it is still usable, otherwise EDITIFY_STYLE_ANALYZER, otherwise the first
 * available one (Gemini when keyed, then an external service, then ffmpeg).
 * Custom analyzers built with `composeAnalyzer` or any other `VideoAnalyzer`
 * are added with `register` and become selectable like the built-ins.
 */
export class StyleAnalyzerRegistry {
  private readonly analyzers = new Map<string, VideoAnalyzer>();

  constructor(
    private readonly settings: SettingsStore,
    analyzers: VideoAnalyzer[] = builtInAnalyzers(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const analyzer of analyzers) this.register(analyzer);
  }

  register(analyzer: VideoAnalyzer): this {
    this.analyzers.set(analyzer.id, analyzer);
    return this;
  }

  get(id: string): VideoAnalyzer | undefined {
    return this.analyzers.get(id);
  }

  async options(): Promise<AnalyzerOption[]> {
    return await Promise.all([...this.analyzers.values()].map(async (analyzer) => ({
      id: analyzer.id, label: analyzer.label, watches: analyzer.watches, ...await analyzer.availability(),
    })));
  }

  /** The choice is per user, falling back to the global one (no user reads and writes the global). */
  async status(userId?: string): Promise<AnalyzerStatus> {
    const options = await this.options();
    const usable = (id: string | undefined) => id !== undefined && options.some((option) => option.id === id && option.available);
    const requested = this.settings.getFor(ANALYZER_SETTING_KEY, userId);
    const envChoice = this.env.EDITIFY_STYLE_ANALYZER;
    const active = usable(requested) ? requested as string
      : usable(envChoice) ? envChoice as string
        : options.find((option) => option.available)?.id ?? ffmpegAnalyzer.id;
    return { active, ...(requested && !usable(requested) ? { requested } : {}), options };
  }

  async select(id: string, userId?: string): Promise<AnalyzerStatus> {
    const options = await this.options();
    const chosen = options.find((option) => option.id === id);
    if (!chosen?.available) throw new Error(`${id} is not available: ${chosen?.detail ?? 'unknown analyzer'}`);
    this.settings.setFor(ANALYZER_SETTING_KEY, id, userId);
    return await this.status(userId);
  }

  async resolve(userId?: string): Promise<VideoAnalyzer> {
    const { active } = await this.status(userId);
    return this.analyzers.get(active) ?? ffmpegAnalyzer;
  }
}
