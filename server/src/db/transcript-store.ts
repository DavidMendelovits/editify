import { z } from 'zod';
import type { EditifyDatabase } from './database.js';

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

export interface StoredTranscript extends TranscriptResult {
  assetId: string;
  createdAt: string;
}

interface TranscriptRow {
  asset_id: string;
  language: string;
  words: string;
  segments: string;
  created_at: string;
}

export class TranscriptStore {
  constructor(private readonly database: EditifyDatabase) {}

  get(assetId: string): StoredTranscript | undefined {
    const row = this.database.prepare('SELECT * FROM transcripts WHERE asset_id = ?')
      .get(assetId) as TranscriptRow | undefined;
    if (!row) return undefined;
    const words = JSON.parse(row.words) as TranscriptWord[];
    const segments = JSON.parse(row.segments) as TranscriptSegment[];
    const parsed = transcriptResultSchema.parse({
      language: row.language,
      durationProcessedSeconds: Math.max(
        0,
        ...segments.map((segment) => segment.e),
        ...words.map((word) => word.e),
      ),
      words,
      segments,
    });
    return { assetId: row.asset_id, ...parsed, createdAt: row.created_at };
  }

  put(assetId: string, transcript: TranscriptResult): StoredTranscript {
    const parsed = transcriptResultSchema.parse(transcript);
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO transcripts (asset_id, language, words, segments, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        language = excluded.language,
        words = excluded.words,
        segments = excluded.segments,
        created_at = excluded.created_at
    `).run(assetId, parsed.language, JSON.stringify(parsed.words), JSON.stringify(parsed.segments), createdAt);
    return { assetId, ...parsed, createdAt };
  }
}
