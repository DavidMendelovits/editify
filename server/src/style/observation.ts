import { z } from 'zod';

/** What ffmpeg alone can measure about one video; always collected, model or not. */
export interface StyleMetric {
  assetId: string;
  duration: number;
  cutCount: number;
  cutDensity: number;
  averageShotLength: number;
  loudnessLufs: number | null;
  width: number;
  height: number;
  format: string;
}

/**
 * What one pass over one video yields: structured, comparable editing data,
 * the "spreadsheet row" of the pattern-recognition workflow. Every section is
 * optional so an analyzer can fill in only what it can actually see: ffmpeg
 * alone knows cut cadence and loudness, a video model can also describe the
 * hook, captions, transitions, and grade.
 */
export const videoObservationSchema = z.object({
  assetId: z.string().min(1),
  /** Id of the analyzer that produced this row. */
  analyzer: z.string().min(1),
  /** True when the analyzer saw the pixels/audio, false for metric-only rows. */
  watched: z.boolean(),
  durationSeconds: z.number().nonnegative(),
  format: z.enum(['9:16', '16:9', '1:1']),
  /** One or two sentences a person could read. */
  summary: z.string().default(''),
  pacing: z.object({
    averageShotSeconds: z.number().nonnegative().nullish(),
    cutCount: z.number().int().nonnegative().nullish(),
    rhythm: z.enum(['fast-punch', 'balanced', 'slow-burn']).nullish(),
    notes: z.string().nullish(),
  }).nullish(),
  hook: z.object({
    durationSeconds: z.number().nonnegative().nullish(),
    technique: z.string().nullish(),
    notes: z.string().nullish(),
  }).nullish(),
  captions: z.object({
    present: z.boolean().nullish(),
    position: z.enum(['top', 'center', 'bottom']).nullish(),
    style: z.string().nullish(),
    animation: z.string().nullish(),
    notes: z.string().nullish(),
  }).nullish(),
  transitions: z.object({
    dominant: z.string().nullish(),
    frequency: z.enum(['rare', 'occasional', 'constant']).nullish(),
    notes: z.string().nullish(),
  }).nullish(),
  audio: z.object({
    loudnessLufs: z.number().nullish(),
    music: z.string().nullish(),
    soundEffects: z.string().nullish(),
    voice: z.string().nullish(),
    notes: z.string().nullish(),
  }).nullish(),
  visuals: z.object({
    colorGrade: z.string().nullish(),
    framing: z.string().nullish(),
    punchIns: z.boolean().nullish(),
    bRoll: z.string().nullish(),
    notes: z.string().nullish(),
  }).nullish(),
  text: z.object({
    overlays: z.string().nullish(),
    emoji: z.boolean().nullish(),
    notes: z.string().nullish(),
  }).nullish(),
  /** Short free-form labels ("meme captions", "whip pans") for cross-video tallies. */
  tags: z.array(z.string().min(1)).default([]),
  /** Whatever the analyzer returned verbatim, kept for debugging and re-parsing. */
  raw: z.unknown().optional(),
});

export type VideoObservation = z.infer<typeof videoObservationSchema>;

/**
 * The parts of an observation an analyzer is responsible for. `assetId`,
 * `durationSeconds`, and `format` are known before any model runs, so the
 * pipeline fills them in and an analyzer never has to repeat them.
 */
export const analyzerOutputSchema = videoObservationSchema.omit({
  assetId: true, analyzer: true, durationSeconds: true, format: true,
}).partial();

export type AnalyzerOutput = z.infer<typeof analyzerOutputSchema>;

/**
 * Several observations folded into one reusable style template: the numbers
 * are medians, the labels are the most common answer, and the tags are ranked
 * by how many videos carried them. This is what a rendering step or a chat
 * brief consumes; the per-video rows stay alongside for inspection.
 */
export interface StyleTemplate {
  videoCount: number;
  /** How many of the videos were actually watched rather than only measured. */
  watchedCount: number;
  analyzers: string[];
  format: '9:16' | '16:9' | '1:1';
  durationSeconds: { median: number; min: number; max: number };
  pacing: { averageShotSeconds: number | null; cutDensity: number | null; rhythm: 'fast-punch' | 'balanced' | 'slow-burn' | null };
  hook: { durationSeconds: number | null; technique: string | null };
  captions: { presentRatio: number | null; position: 'top' | 'center' | 'bottom' | null; style: string | null; animation: string | null };
  transitions: { dominant: string | null; frequency: 'rare' | 'occasional' | 'constant' | null };
  audio: { loudnessLufs: number | null; music: string | null; soundEffects: string | null; voice: string | null };
  visuals: { colorGrade: string | null; framing: string | null; punchIns: boolean | null; bRoll: string | null };
  text: { overlays: string | null; emoji: boolean | null };
  /** Tag plus the number of videos it appeared in, most common first. */
  tags: Array<{ tag: string; count: number }>;
}

export function formatFor(width: number, height: number): VideoObservation['format'] {
  return width === height ? '1:1' : height > width ? '9:16' : '16:9';
}

export function rhythmFor(averageShotSeconds: number): NonNullable<NonNullable<VideoObservation['pacing']>['rhythm']> {
  return averageShotSeconds < 2 ? 'fast-punch' : averageShotSeconds < 4 ? 'balanced' : 'slow-burn';
}
