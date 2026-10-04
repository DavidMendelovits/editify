/*
 * What on-device or server analysis produces about a recording, as plain
 * data: words, loudness, face boxes. The edit logic reads only these shapes,
 * so it runs the same wherever the analysis came from.
 */
import { z } from 'zod';

export const transcriptWordSchema = z.object({
  w: z.string(),
  s: z.number().min(0),
  e: z.number().min(0),
});

export const transcriptSegmentSchema = z.object({
  text: z.string(),
  s: z.number().min(0),
  e: z.number().min(0),
});

export const transcriptResultSchema = z.object({
  language: z.string(),
  durationProcessedSeconds: z.number().min(0),
  words: z.array(transcriptWordSchema),
  segments: z.array(transcriptSegmentSchema),
});

export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type TranscriptResult = z.infer<typeof transcriptResultSchema>;

export const energyAnalysisSchema = z.object({
  cellSeconds: z.literal(0.05),
  rmsDb: z.array(z.number()),
});
export type EnergyAnalysis = z.infer<typeof energyAnalysisSchema>;

/**
 * One face box per sample, normalized to the decoded source frame:
 * `[t, top, bottom, left, right]`, or `[t, null]` when no face was found.
 */
export const faceTrackSchema = z.object({
  fps: z.number().positive(),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  samples: z.array(z.union([
    z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.null()]),
  ])),
});
export type FaceTrack = z.infer<typeof faceTrackSchema>;

export interface FaceBox { top: number; bottom: number; left: number; right: number }

/** Misses shorter than this hold the last seen face; longer means the speaker left. */
const HOLD_SECONDS = 1;

/** The face at source second `t`: the nearest sample, holding across short misses. */
export function faceAt(track: FaceTrack, t: number): FaceBox | undefined {
  let best: FaceBox | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const sample of track.samples) {
    if (sample[1] === null) continue;
    const distance = Math.abs(sample[0] - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      const [, top, bottom, left, right] = sample;
      best = { top, bottom, left, right };
    }
    if (sample[0] > t + HOLD_SECONDS) break;
  }
  return bestDistance <= HOLD_SECONDS ? best : undefined;
}

/** The shape of `SyncMeasurement` (sync.ts) as data, for a measurement made on the phone. */
export const syncMeasurementSchema = z.object({
  lag: z.number(),
  anchor: z.number(),
  rate: z.number().positive(),
  coarseRatio: z.number(),
  fineScore: z.number(),
  confident: z.boolean(),
  driftSec: z.number().optional(),
  overlapSec: z.number().min(0),
  windows: z.array(z.object({ at: z.number(), lag: z.number(), score: z.number() })).max(1000),
});

/**
 * Where one analysis part stands (decision 6A). Only `ready` counts as present:
 * a tool that needs a part that is pending, failed or unavailable is not
 * offered, rather than run on nothing.
 */
export const analysisPartStatusSchema = z.enum(['pending', 'ready', 'failed', 'unavailable']);
export type AnalysisPartStatus = z.infer<typeof analysisPartStatusSchema>;

function analysisPart<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    status: analysisPartStatusSchema,
    /** Which analyzer produced it, so a result from an older model can be told apart and redone. */
    analyzerVersion: z.string().min(1).max(100),
    data: data.optional(),
  }).refine((part) => part.status !== 'ready' || part.data !== undefined, { message: 'A ready part carries its data', path: ['data'] });
}

/**
 * Caps on what one recording's analysis may carry, sized for a 3-hour set
 * (the longest recording sync takes): ~150 words a minute, one loudness cell
 * per 50 ms, faces at up to 4 fps.
 */
const MAX_BUNDLE_WORDS = 30_000;
const MAX_BUNDLE_SEGMENTS = 10_000;
const MAX_BUNDLE_ENERGY_CELLS = 216_000;
const MAX_BUNDLE_FACE_SAMPLES = 43_200;
const MAX_BUNDLE_ASSETS = 200;

/** Everything analyzed about one recording. An absent part has not been started. */
export const assetAnalysisSchema = z.object({
  transcript: analysisPart(transcriptResultSchema.extend({
    words: z.array(transcriptWordSchema).max(MAX_BUNDLE_WORDS),
    segments: z.array(transcriptSegmentSchema).max(MAX_BUNDLE_SEGMENTS),
  })).optional(),
  energy: analysisPart(energyAnalysisSchema.extend({ rmsDb: z.array(z.number()).max(MAX_BUNDLE_ENERGY_CELLS) })).optional(),
  faces: analysisPart(faceTrackSchema.extend({ samples: faceTrackSchema.shape.samples.max(MAX_BUNDLE_FACE_SAMPLES) })).optional(),
});
export type AssetAnalysis = z.infer<typeof assetAnalysisSchema>;

/**
 * What the phone knows about a project's media, sent with an agent turn in
 * place of the media itself: per-asset parts keyed by asset id, plus one sync
 * result per memo/video pair (sync is a property of the pair, not of either file).
 */
export const analysisBundleSchema = z.object({
  assets: z.record(z.string().min(1), assetAnalysisSchema)
    .refine((assets) => Object.keys(assets).length <= MAX_BUNDLE_ASSETS, { message: `At most ${MAX_BUNDLE_ASSETS} assets per bundle` }),
  syncs: z.array(z.object({
    videoAssetId: z.string().min(1),
    memoAssetId: z.string().min(1),
    status: analysisPartStatusSchema,
    analyzerVersion: z.string().min(1).max(100),
    measurement: syncMeasurementSchema.optional(),
  }).refine((sync) => sync.status !== 'ready' || sync.measurement !== undefined, { message: 'A ready sync carries its measurement', path: ['measurement'] }))
    .max(200).default([]),
});
export type AnalysisBundle = z.infer<typeof analysisBundleSchema>;

/** A part's data when it is ready; anything else reads as absent. */
export function readyPart<T>(part: { status: AnalysisPartStatus; data?: T } | undefined): T | undefined {
  return part?.status === 'ready' ? part.data : undefined;
}
