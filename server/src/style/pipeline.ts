import type { StoredAsset } from '../db/asset-store.js';
import { analyzeLoudness, analyzeScenes } from '../media/process.js';
import type { VideoAnalyzer, VideoAnalysisInput } from './analyzer.js';
import { formatFor, type StyleMetric, type StyleTemplate, type VideoObservation } from './observation.js';
import type { ObservationCache } from './observation-cache.js';
import { buildStyleTemplate, describeTemplate } from './template.js';

export type PipelineStage = 'measuring' | 'watching' | 'aggregating' | 'distilling';

export interface PipelineProgress { stage: PipelineStage; done: number; total: number }

export interface StylePipelineOptions {
  videos: StoredAsset[];
  analyzer: VideoAnalyzer;
  cache?: ObservationCache;
  /** Skip the cache and watch every video again. */
  refresh?: boolean;
  /** Turns the template plus observations into the brief; null means use the local fallback. */
  distill?: (template: StyleTemplate, observations: VideoObservation[]) => Promise<string>;
  onProgress?: (progress: PipelineProgress) => void;
  /** Called when a stage degraded without failing the run — today, a failed distillation. */
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
}

export interface StylePipelineResult {
  analyzer: string;
  metrics: StyleMetric[];
  observations: VideoObservation[];
  template: StyleTemplate;
  styleDoc: string;
  /** False when the chat provider failed or was absent and styleDoc is the local template summary. */
  distilled: boolean;
  /** Why distillation fell back, when it did. */
  distillError?: string;
}

/**
 * The learn-my-style workflow as one function with the doc's steps in order:
 * measure every video with ffmpeg, hand each one to the analyzer (the pluggable
 * "watch" step), fold the observations into a template, and distill a brief.
 * Sourcing the videos (an upload, a scrape) and storing the result are the
 * caller's business, which keeps this runnable from a test or a script.
 */
export async function runStylePipeline(options: StylePipelineOptions): Promise<StylePipelineResult> {
  const { videos, analyzer, cache, signal } = options;
  const total = videos.length;
  const report = (stage: PipelineStage, done: number) => options.onProgress?.({ stage, done, total });

  report('measuring', 0);
  const inputs: VideoAnalysisInput[] = [];
  for (const [index, asset] of videos.entries()) {
    signal?.throwIfAborted();
    inputs.push({ ...await measure(asset) });
    report('measuring', index + 1);
  }

  report('watching', 0);
  const observations: VideoObservation[] = [];
  for (const [index, input] of inputs.entries()) {
    signal?.throwIfAborted();
    const cached = options.refresh ? undefined : cache?.get(input.assetId, analyzer.id, analyzer.version);
    if (cached) {
      observations.push(cached);
    } else {
      const output = await analyzer.analyzeVideo(input, signal);
      const observation: VideoObservation = {
        assetId: input.assetId,
        analyzer: analyzer.id,
        durationSeconds: input.durationSeconds,
        format: formatFor(input.width, input.height),
        watched: output.watched ?? analyzer.watches,
        summary: output.summary ?? '',
        tags: output.tags ?? [],
        ...(output.pacing !== undefined ? { pacing: output.pacing } : {}),
        ...(output.hook !== undefined ? { hook: output.hook } : {}),
        ...(output.captions !== undefined ? { captions: output.captions } : {}),
        ...(output.transitions !== undefined ? { transitions: output.transitions } : {}),
        ...(output.audio !== undefined ? { audio: output.audio } : {}),
        ...(output.visuals !== undefined ? { visuals: output.visuals } : {}),
        ...(output.text !== undefined ? { text: output.text } : {}),
        ...(output.raw !== undefined ? { raw: output.raw } : {}),
      };
      // The metrics are ground truth for what ffmpeg can measure; a model that
      // left those blank gets them filled in rather than the template going null.
      observation.pacing = {
        averageShotSeconds: input.metrics.averageShotLength, cutCount: input.metrics.cutCount, ...(observation.pacing ?? {}),
      };
      observation.audio = { loudnessLufs: input.metrics.loudnessLufs, ...(observation.audio ?? {}) };
      cache?.put(observation, analyzer.version);
      observations.push(observation);
    }
    report('watching', index + 1);
  }

  report('aggregating', total);
  const template = buildStyleTemplate(observations);

  report('distilling', total);
  const fallback = describeTemplate(template);
  let styleDoc = fallback;
  let distilled = false;
  let distillError: string | undefined;
  if (options.distill) {
    try {
      const written = (await options.distill(template, observations)).trim();
      styleDoc = written || fallback;
      distilled = written.length > 0;
      if (!written) distillError = 'The chat provider returned nothing';
    } catch (error) {
      distillError = error instanceof Error ? error.message : String(error);
    }
  } else {
    distillError = 'No chat provider was given';
  }
  if (distillError) options.onWarning?.(`Style brief fell back to the template summary: ${distillError}`);

  return {
    analyzer: analyzer.id, metrics: inputs.map((input) => input.metrics), observations, template, styleDoc,
    distilled, ...(distillError ? { distillError } : {}),
  };
}

async function measure(asset: StoredAsset): Promise<VideoAnalysisInput> {
  const scenes = await analyzeScenes(asset.originalPath, asset.duration);
  const loudnessLufs = asset.hasAudio ? await analyzeLoudness(asset.originalPath) : null;
  const metrics: StyleMetric = {
    assetId: asset.id,
    duration: asset.duration,
    ...scenes,
    loudnessLufs,
    width: asset.width,
    height: asset.height,
    format: formatFor(asset.width, asset.height),
  };
  return {
    assetId: asset.id, path: asset.originalPath, mimeType: asset.mimeType, durationSeconds: asset.duration,
    width: asset.width, height: asset.height, hasAudio: asset.hasAudio, metrics,
  };
}
