import {
  energyAnalysisSchema,
  transcriptResultSchema,
  transcriptSegmentSchema,
  transcriptWordSchema,
  type EnergyAnalysis,
  type TranscriptResult,
  type TranscriptSegment,
  type TranscriptWord,
} from '@editify/shared';
import type { EditifyDatabase } from './database.js';

export {
  energyAnalysisSchema,
  transcriptResultSchema,
  transcriptSegmentSchema,
  transcriptWordSchema,
  type EnergyAnalysis,
  type TranscriptResult,
  type TranscriptSegment,
  type TranscriptWord,
};

export interface StoredTranscript extends TranscriptResult {
  assetId: string;
  createdAt: string;
  energy?: EnergyAnalysis;
}

interface TranscriptRow {
  asset_id: string;
  language: string;
  words: string;
  segments: string;
  created_at: string;
  energy_json: string | null;
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
    const energy = row.energy_json ? energyAnalysisSchema.parse(JSON.parse(row.energy_json)) : undefined;
    return { assetId: row.asset_id, ...parsed, createdAt: row.created_at, ...(energy ? { energy } : {}) };
  }

  put(assetId: string, transcript: TranscriptResult, energy?: EnergyAnalysis): StoredTranscript {
    const parsed = transcriptResultSchema.parse(transcript);
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO transcripts (asset_id, language, words, segments, energy_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        language = excluded.language,
        words = excluded.words,
        segments = excluded.segments,
        energy_json = COALESCE(excluded.energy_json, transcripts.energy_json),
        created_at = excluded.created_at
    `).run(assetId, parsed.language, JSON.stringify(parsed.words), JSON.stringify(parsed.segments), energy ? JSON.stringify(energyAnalysisSchema.parse(energy)) : null, createdAt);
    return { assetId, ...parsed, createdAt, ...(energy ? { energy } : {}) };
  }

  putEnergy(assetId: string, energy: EnergyAnalysis): StoredTranscript {
    const parsed = energyAnalysisSchema.parse(energy);
    const result = this.database.prepare('UPDATE transcripts SET energy_json = ? WHERE asset_id = ?')
      .run(JSON.stringify(parsed), assetId);
    if (result.changes === 0) throw new Error(`No transcript for asset ${assetId}`);
    const stored = this.get(assetId);
    if (!stored) throw new Error(`No transcript for asset ${assetId}`);
    return stored;
  }
}
