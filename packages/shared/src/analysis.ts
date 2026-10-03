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
