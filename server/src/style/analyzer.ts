import { analyzerOutputSchema, type AnalyzerOutput, type StyleMetric } from './observation.js';

/**
 * Everything the "watch" step gets handed for one video. The ffmpeg metrics are
 * always measured first (cheap, local, deterministic) so an analyzer can lean
 * on them, refine them, or ignore them.
 */
export interface VideoAnalysisInput {
  assetId: string;
  /** Absolute path of the original upload on disk. */
  path: string;
  mimeType: string;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  metrics: StyleMetric;
}

/**
 * The black box of the learn-my-style workflow: something that looks at one
 * video and reports its editing pattern. Gemini is one implementation; an
 * external service or a chain of local functions are others. The pipeline
 * only ever calls `analyzeVideo`, so swapping the implementation changes
 * nothing upstream or downstream.
 */
export interface VideoAnalyzer {
  readonly id: string;
  readonly label: string;
  /**
   * Bumped whenever the analyzer's output would change for the same input
   * (new prompt, new model). Cached observations are keyed on it.
   */
  readonly version: string;
  /** True when the analyzer actually watches the video rather than reading metrics. */
  readonly watches: boolean;
  /** Whether it can run right now, and one line saying how or what is missing. */
  availability(): Promise<{ available: boolean; detail: string }> | { available: boolean; detail: string };
  analyzeVideo(input: VideoAnalysisInput, signal?: AbortSignal): Promise<AnalyzerOutput>;
}

/** Parses whatever an analyzer (or external service) returned into a known shape. */
export function parseAnalyzerOutput(value: unknown): AnalyzerOutput {
  return analyzerOutputSchema.parse(value);
}

/**
 * One link of a function-chain analyzer: sees the input and everything the
 * earlier links produced, returns what it adds. Returning `{}` is fine.
 */
export type AnalyzerStep = (input: VideoAnalysisInput, draft: AnalyzerOutput, signal?: AbortSignal) => Promise<AnalyzerOutput> | AnalyzerOutput;

export interface ComposedAnalyzerOptions {
  id: string;
  label: string;
  version?: string;
  /** Set true when at least one step actually looks at the frames or audio. */
  watches?: boolean;
  steps: AnalyzerStep[];
  availability?: VideoAnalyzer['availability'];
}

/**
 * Builds an analyzer out of a series of functions: each step's result is
 * shallow-merged over the draft (sections replace, `tags` accumulate), so a
 * shot detector, a caption OCR pass, and a colour probe can be developed and
 * tested independently and then chained. Nothing here knows about any model.
 */
export function composeAnalyzer(options: ComposedAnalyzerOptions): VideoAnalyzer {
  return {
    id: options.id,
    label: options.label,
    version: options.version ?? '1',
    watches: options.watches ?? false,
    availability: options.availability ?? (() => ({ available: true, detail: `${options.steps.length} local step${options.steps.length === 1 ? '' : 's'}` })),
    async analyzeVideo(input, signal) {
      let draft: AnalyzerOutput = { tags: [] };
      for (const step of options.steps) {
        signal?.throwIfAborted();
        const next = parseAnalyzerOutput(await step(input, draft, signal));
        draft = mergeOutputs(draft, next);
      }
      return draft;
    },
  };
}

export function mergeOutputs(base: AnalyzerOutput, next: AnalyzerOutput): AnalyzerOutput {
  const merged: AnalyzerOutput = { ...base };
  for (const [key, value] of Object.entries(next) as Array<[keyof AnalyzerOutput, unknown]>) {
    if (value === undefined) continue;
    if (key === 'tags') {
      merged.tags = [...new Set([...(base.tags ?? []), ...(value as string[])])];
    } else if (key === 'summary') {
      merged.summary = [base.summary, value as string].filter(Boolean).join(' ');
    } else if (isSection(value) && isSection(merged[key])) {
      (merged as Record<string, unknown>)[key] = { ...(merged[key] as object), ...value };
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function isSection(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
