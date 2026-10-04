import type { StoredAsset } from '../db/asset-store.js';
import type { EditifyDatabase } from '../db/database.js';
import { energyAnalysisSchema, type EnergyAnalysis } from '../db/transcript-store.js';
import { analyzeEnergy } from '../media/audio-analysis.js';
import type { EnergyAnalyzer, TranscriptService } from './transcript-service.js';

/** What a silent (or video-only) asset gets: the client simply draws nothing. */
const SILENT: EnergyAnalysis = { cellSeconds: 0.05, rmsDb: [] };

/**
 * The 50ms RMS envelope a timeline clip draws as bars. Transcription already
 * measures this for anything with speech, so the transcript's energy is the
 * first source; only assets without one pay for an ffmpeg pass, and that
 * result is cached in SQLite so a lane full of clips computes it once.
 */
export class WaveformService {
  private readonly inFlight = new Map<string, Promise<EnergyAnalysis>>();

  constructor(
    private readonly database: EditifyDatabase,
    private readonly transcripts: TranscriptService,
    private readonly analyzer: EnergyAnalyzer = analyzeEnergy,
  ) {}

  get(assetId: string): EnergyAnalysis | undefined {
    const row = this.database.prepare('SELECT waveform_json FROM waveforms WHERE asset_id = ?')
      .get(assetId) as { waveform_json: string } | undefined;
    return row ? energyAnalysisSchema.parse(JSON.parse(row.waveform_json)) : undefined;
  }

  /** Compute-on-miss with in-flight sharing, so a burst runs one analysis. */
  async getOrCreate(asset: StoredAsset): Promise<EnergyAnalysis> {
    if (!asset.hasAudio) return SILENT;
    const transcribed = this.transcripts.get(asset.id)?.energy;
    if (transcribed) return transcribed;
    const cached = this.get(asset.id);
    if (cached) return cached;
    const pending = this.inFlight.get(asset.id) ?? this.analyzer(asset.originalPath)
      .then((energy) => {
        const parsed = energyAnalysisSchema.parse(energy);
        // Read-only (the cutover freeze): serve it, store nothing.
        if (this.database.readonly) return parsed;
        this.database.prepare(`
          INSERT INTO waveforms (asset_id, waveform_json, created_at) VALUES (?, ?, ?)
          ON CONFLICT(asset_id) DO UPDATE SET waveform_json = excluded.waveform_json, created_at = excluded.created_at
        `).run(asset.id, JSON.stringify(parsed), new Date().toISOString());
        return parsed;
      })
      .finally(() => this.inFlight.delete(asset.id));
    this.inFlight.set(asset.id, pending);
    return await pending;
  }
}
