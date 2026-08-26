import { assetDissectionSchema, type AssetDissection } from '@editify/shared';
import type { StoredAsset } from '../db/asset-store.js';
import type { EditifyDatabase } from '../db/database.js';
import { analyzeEnergy } from '../media/audio-analysis.js';
import { analyzeLoudness, runProcess } from '../media/process.js';

/** Sampling rate for the overlay-zone edge scan; 4 fps is enough for captions. */
const OVERLAY_FPS = 4;
/** Downsample the 50ms energy cells to this for transport and sparklines. */
const ENERGY_CELL_SECONDS = 0.25;

/**
 * ffmpeg-only dissection of one source video: when it cuts, how the audio
 * moves, an estimated tempo, and where burned-in text/graphics live. This is
 * the measurable half of "watch the reference video"; the agent reads it to
 * mirror a style, the UI draws it so the human can too.
 */
export class DissectService {
  private readonly inFlight = new Map<string, Promise<AssetDissection>>();

  constructor(private readonly database: EditifyDatabase) {}

  get(assetId: string): AssetDissection | undefined {
    const row = this.database.prepare('SELECT dissection_json FROM dissections WHERE asset_id = ?')
      .get(assetId) as { dissection_json: string } | undefined;
    return row ? assetDissectionSchema.parse(JSON.parse(row.dissection_json)) : undefined;
  }

  /** Compute-on-miss with in-flight sharing, so a burst runs one analysis. */
  async getOrCreate(asset: StoredAsset, force = false): Promise<AssetDissection> {
    if (!force) {
      const existing = this.get(asset.id);
      if (existing) return existing;
    }
    const pending = this.inFlight.get(asset.id) ?? this.dissect(asset)
      .then((dissection) => {
        this.database.prepare(`
          INSERT INTO dissections (asset_id, dissection_json, created_at) VALUES (?, ?, ?)
          ON CONFLICT(asset_id) DO UPDATE SET dissection_json = excluded.dissection_json, created_at = excluded.created_at
        `).run(asset.id, JSON.stringify(dissection), dissection.generatedAt);
        return dissection;
      })
      .finally(() => this.inFlight.delete(asset.id));
    this.inFlight.set(asset.id, pending);
    return await pending;
  }

  private async dissect(asset: StoredAsset): Promise<AssetDissection> {
    const duration = Math.max(asset.duration, 0.01);
    const hasVideo = asset.width > 0 && asset.height > 0;
    const [cuts, rawEnergy, loudnessLufs, topActivity, bottomActivity] = await Promise.all([
      hasVideo ? sceneCutTimes(asset.originalPath) : Promise.resolve([]),
      asset.hasAudio ? analyzeEnergy(asset.originalPath) : Promise.resolve(undefined),
      asset.hasAudio ? analyzeLoudness(asset.originalPath) : Promise.resolve(null),
      hasVideo ? overlayZoneActivity(asset.originalPath, 'top') : Promise.resolve([]),
      hasVideo ? overlayZoneActivity(asset.originalPath, 'bottom') : Promise.resolve([]),
    ]);

    const energy = rawEnergy ? downsampleEnergy(rawEnergy.rmsDb, rawEnergy.cellSeconds) : { cellSeconds: ENERGY_CELL_SECONDS, rmsDb: [] };
    const energyPeaks = rawEnergy ? onsetPeaks(rawEnergy.rmsDb, rawEnergy.cellSeconds) : [];
    const tempoBpm = rawEnergy ? estimateTempo(rawEnergy.rmsDb, rawEnergy.cellSeconds) : null;
    const shotCount = cuts.length + 1;
    const averageShotLength = duration / shotCount;
    const overlayActivity = [
      ...topActivity.map((span) => ({ ...span, zone: 'top' as const })),
      ...bottomActivity.map((span) => ({ ...span, zone: 'bottom' as const })),
    ].sort((left, right) => left.start - right.start);

    return assetDissectionSchema.parse({
      assetId: asset.id,
      duration,
      cuts,
      averageShotLength,
      cutDensity: cuts.length / duration,
      tempoBpm,
      loudnessLufs,
      energy,
      energyPeaks,
      overlayActivity,
      summary: summarize(duration, cuts.length, averageShotLength, tempoBpm, loudnessLufs, overlayActivity.length),
      generatedAt: new Date().toISOString(),
    });
  }
}

/** Scene-change timestamps, the same 0.3 threshold the style profile uses. */
async function sceneCutTimes(path: string): Promise<number[]> {
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-i', path, '-vf', "select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-',
  ]);
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

/**
 * Edge-density scan of one horizontal band. Burned-in captions and graphic
 * overlays carry far more hard edges than natural footage, so the mean
 * luminance of the edge image spikes while they are on screen.
 * ponytail: heuristic with a known ceiling — busy natural texture in the band
 * can false-positive; a text detector would be the upgrade path.
 */
async function overlayZoneActivity(path: string, zone: 'top' | 'bottom'): Promise<Array<{ start: number; end: number }>> {
  const crop = zone === 'top' ? 'iw:ih*0.22:0:0' : 'iw:ih*0.3:0:ih*0.7';
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-nostats', '-i', path,
    '-vf', `fps=${OVERLAY_FPS},crop=${crop},scale=200:-2,edgedetect,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-an', '-f', 'null', '-',
  ]);
  const levels = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (levels.length < OVERLAY_FPS) return [];
  const sorted = [...levels].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const threshold = Math.max(12, median * 1.6);
  const spans: Array<{ start: number; end: number }> = [];
  for (const [index, level] of levels.entries()) {
    const time = index / OVERLAY_FPS;
    const active = level >= threshold;
    const current = spans.at(-1);
    if (active && current && time - current.end <= 1 / OVERLAY_FPS + 1e-6) current.end = time + 1 / OVERLAY_FPS;
    else if (active) spans.push({ start: time, end: time + 1 / OVERLAY_FPS });
  }
  return spans.filter((span) => span.end - span.start >= 0.5)
    .map((span) => ({ start: round2(span.start), end: round2(span.end) }));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function downsampleEnergy(rmsDb: number[], cellSeconds: number): { cellSeconds: number; rmsDb: number[] } {
  const stride = Math.max(1, Math.round(ENERGY_CELL_SECONDS / cellSeconds));
  const cells: number[] = [];
  for (let index = 0; index < rmsDb.length; index += stride) {
    const window = rmsDb.slice(index, index + stride);
    cells.push(round2(window.reduce((total, value) => total + value, 0) / window.length));
  }
  return { cellSeconds: stride * cellSeconds, rmsDb: cells };
}

/** Local maxima of linear energy above the 85th percentile, ≥0.25s apart. */
function onsetPeaks(rmsDb: number[], cellSeconds: number): number[] {
  const linear = rmsDb.map((db) => 10 ** (db / 20));
  const sorted = [...linear].sort((left, right) => left - right);
  const floor = sorted[Math.floor(sorted.length * 0.85)] ?? 0;
  const minGapCells = Math.ceil(0.25 / cellSeconds);
  const peaks: number[] = [];
  let lastPeakIndex = -minGapCells;
  for (let index = 1; index + 1 < linear.length; index += 1) {
    const value = linear[index] as number;
    if (value < floor) continue;
    if (value < (linear[index - 1] as number) || value <= (linear[index + 1] as number)) continue;
    if (index - lastPeakIndex < minGapCells) continue;
    peaks.push(round2(index * cellSeconds));
    lastPeakIndex = index;
  }
  return peaks;
}

/**
 * Tempo from energy periodicity: normalized autocorrelation of the linear
 * energy curve over lags spanning 60–180 BPM; a weak best peak means "no
 * discernible tempo" rather than a made-up number.
 */
function estimateTempo(rmsDb: number[], cellSeconds: number): number | null {
  const linear = rmsDb.map((db) => 10 ** (db / 20));
  if (linear.length < Math.ceil(4 / cellSeconds)) return null; // need a few seconds
  const mean = linear.reduce((total, value) => total + value, 0) / linear.length;
  const centered = linear.map((value) => value - mean);
  const variance = centered.reduce((total, value) => total + value * value, 0);
  if (variance <= 0) return null;
  const minLag = Math.max(1, Math.round((60 / 180) / cellSeconds));
  const maxLag = Math.min(centered.length - 1, Math.round((60 / 60) / cellSeconds));
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index + lag < centered.length; index += 1) {
      sum += (centered[index] as number) * (centered[index + lag] as number);
    }
    const score = sum / variance;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestScore < 0.25) return null;
  return Math.round(60 / (bestLag * cellSeconds));
}

function summarize(
  duration: number,
  cutCount: number,
  averageShotLength: number,
  tempoBpm: number | null,
  loudnessLufs: number | null,
  overlaySpans: number,
): string {
  const pacing = averageShotLength < 2 ? 'fast-cut' : averageShotLength < 4 ? 'balanced' : 'slow-burn';
  const parts = [
    `${duration.toFixed(1)}s, ${cutCount} cuts (${pacing}, ~${averageShotLength.toFixed(1)}s/shot)`,
    tempoBpm ? `audio pulses near ${tempoBpm} BPM` : 'no steady audio pulse',
    loudnessLufs !== null ? `${loudnessLufs.toFixed(1)} LUFS` : 'no audio',
    overlaySpans > 0 ? `${overlaySpans} on-screen text/graphic span(s)` : 'no burned-in graphics detected',
  ];
  return parts.join(' · ');
}
