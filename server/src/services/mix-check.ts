import { clipTimelineDuration, type Clip, type Project } from '@editify/shared';
import type { AssetStore, StoredAsset } from '../db/asset-store.js';
import type { EnergyAnalysis } from '../db/transcript-store.js';
import { analyzeEnergy } from '../media/audio-analysis.js';
import type { TranscriptService } from './transcript-service.js';

/**
 * Sound effects levelled against THIS speaker's measured voice, not guessed.
 * Each hit's loudest 50ms is compared with the voice's 95th-percentile 50ms
 * level; a whoosh wants to sit about 12 dB under it, an impact 8, a click 14.
 * A bed wants its average about 20 dB under the voice's average.
 * Adapted from kurbaitaev/ghost-editor's build.mjs and qa.py mixing rules (MIT).
 */
export const SFX_TARGET_DB: Record<string, number> = {
  ui: -14, pop: -12, whoosh: -12, riser: -12, impact: -8, other: -10,
};
export const MUSIC_TARGET_DB = -20;
/** Off by more than this and a hit reads as too loud. */
const LOUD_TOLERANCE_DB = 4;
/** Under target by more than this and nobody hears it. */
const QUIET_TOLERANCE_DB = 10;
const MUSIC_TOLERANCE_DB = 6;
/** Structural hits (whoosh + impact) per minute before the edit sounds busy. */
export const MAX_HITS_PER_MINUTE = 14;
/** Layered hits this close together land as one. */
const LAYER_WINDOW_SEC = 0.15;
/** Cells quieter than this are room tone, not speech or sound. */
const SILENCE_FLOOR_DB = -45;
/** Audio-track clips at least this long are beds, not hits. */
const BED_MIN_SEC = 6;

export interface MixHit {
  clipId: string;
  at: number;
  assetId: string;
  category: string;
  levelDb: number;
  targetDb: number;
  verdict: 'ok' | 'loud' | 'quiet';
  volume: number;
  suggestedVolume?: number;
}

export interface MixReport {
  voiceReferenceDb: number | null;
  hits: MixHit[];
  beds: MixHit[];
  hitsPerMinute: number;
  warnings: string[];
}

export type EnergyLookup = (assetId: string) => EnergyAnalysis | undefined;

function gainDb(volume: number | undefined): number {
  return 20 * Math.log10(Math.max(volume ?? 1, 1e-4));
}

function percentile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** The RMS cells a clip actually plays, from its source range. */
function cellsFor(energy: EnergyAnalysis, clip: Clip): number[] {
  const first = Math.max(0, Math.floor(clip.in / energy.cellSeconds));
  const last = Math.min(energy.rmsDb.length, Math.ceil(clip.out / energy.cellSeconds));
  return energy.rmsDb.slice(first, last);
}

/** Library sounds are `sound-<category>-<name>`; anything else is judged by length. */
export function soundCategory(clip: Clip): string {
  const match = clip.assetId?.match(/^sound-(whoosh|impact|pop|ui|riser|music)-/);
  if (match?.[1]) return match[1];
  return clipTimelineDuration(clip) >= BED_MIN_SEC ? 'music' : 'other';
}

function suggestVolume(volume: number, levelDb: number, targetDb: number): number {
  return Math.round(Math.min(1, Math.max(0.02, volume * 10 ** ((targetDb - levelDb) / 20))) * 100) / 100;
}

export function checkMix(project: Project, energyOf: EnergyLookup): MixReport {
  const warnings: string[] = [];
  const voiceCells: number[] = [];
  for (const track of project.tracks.filter((candidate) => candidate.kind === 'video')) {
    for (const clip of track.clips) {
      const energy = clip.assetId ? energyOf(clip.assetId) : undefined;
      if (!energy) continue;
      const gain = gainDb(clip.volume);
      voiceCells.push(...cellsFor(energy, clip).filter((db) => db > SILENCE_FLOOR_DB).map((db) => db + gain));
    }
  }
  const voiceReference = percentile(voiceCells, 0.95);
  const voiceMean = voiceCells.length ? voiceCells.reduce((total, db) => total + db, 0) / voiceCells.length : undefined;
  if (voiceReference === undefined) warnings.push('No measurable voice on the video track, so sound levels could not be judged against it.');

  const hits: MixHit[] = [];
  const beds: MixHit[] = [];
  for (const track of project.tracks.filter((candidate) => candidate.kind === 'audio')) {
    for (const clip of track.clips) {
      if (!clip.assetId) continue;
      const energy = energyOf(clip.assetId);
      const cells = energy ? cellsFor(energy, clip).filter((db) => db > SILENCE_FLOOR_DB) : [];
      const category = soundCategory(clip);
      const volume = clip.volume ?? 1;
      if (category === 'music') {
        if (!cells.length || voiceMean === undefined) continue;
        const levelDb = round1(cells.reduce((total, db) => total + db, 0) / cells.length + gainDb(volume) - voiceMean);
        const off = Math.abs(levelDb - MUSIC_TARGET_DB) > MUSIC_TOLERANCE_DB;
        beds.push({
          clipId: clip.id, at: clip.start, assetId: clip.assetId, category, levelDb, targetDb: MUSIC_TARGET_DB,
          verdict: !off ? 'ok' : levelDb > MUSIC_TARGET_DB ? 'loud' : 'quiet', volume,
          ...(off ? { suggestedVolume: suggestVolume(volume, levelDb, MUSIC_TARGET_DB) } : {}),
        });
        continue;
      }
      if (!cells.length || voiceReference === undefined) continue;
      const targetDb = SFX_TARGET_DB[category] ?? SFX_TARGET_DB.other as number;
      const levelDb = round1(Math.max(...cells) + gainDb(volume) - voiceReference);
      const verdict: MixHit['verdict'] = levelDb > targetDb + LOUD_TOLERANCE_DB || levelDb > -1 ? 'loud'
        : levelDb < targetDb - QUIET_TOLERANCE_DB ? 'quiet' : 'ok';
      hits.push({
        clipId: clip.id, at: clip.start, assetId: clip.assetId, category, levelDb, targetDb, verdict, volume,
        ...(verdict === 'ok' ? {} : { suggestedVolume: suggestVolume(volume, levelDb, targetDb) }),
      });
    }
  }
  hits.sort((left, right) => left.at - right.at);

  for (const hit of hits.filter((candidate) => candidate.verdict !== 'ok')) {
    const direction = hit.verdict === 'loud' ? (hit.levelDb > -1 ? 'louder than the voice' : 'too loud') : 'too quiet to hear';
    const fix = hit.suggestedVolume === 1 && hit.verdict === 'quiet' ? ' even at full volume' : `; volume ${hit.suggestedVolume} lands it`;
    warnings.push(`${hit.clipId} at ${hit.at.toFixed(1)}s (${hit.category}) is ${direction}: ${hit.levelDb} dB vs voice, target ${hit.targetDb}${fix}.`);
  }
  for (const bed of beds.filter((candidate) => candidate.verdict !== 'ok')) {
    warnings.push(`Music ${bed.clipId} sits ${bed.levelDb} dB vs the voice (target ${bed.targetDb}); volume ${bed.suggestedVolume} lands it.`);
  }

  // Density: layered whoosh+impact on one moment counts once.
  const structural = hits.filter((hit) => hit.category === 'whoosh' || hit.category === 'impact').map((hit) => hit.at);
  let moments = 0;
  let lastMoment = Number.NEGATIVE_INFINITY;
  for (const at of structural) {
    if (at - lastMoment <= LAYER_WINDOW_SEC) continue;
    moments += 1;
    lastMoment = at;
  }
  const minutes = Math.max(project.duration, 1) / 60;
  const hitsPerMinute = round1(moments / minutes);
  if (project.duration >= 15 && hitsPerMinute > MAX_HITS_PER_MINUTE) {
    warnings.push(`${hitsPerMinute} whoosh/impact hits per minute (limit ${MAX_HITS_PER_MINUTE}): the edit will sound busy. Keep hits on the structural moments.`);
  }
  return {
    voiceReferenceDb: voiceReference === undefined ? null : round1(voiceReference),
    hits,
    beds,
    hitsPerMinute,
    warnings,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const ENERGY_CACHE_LIMIT = 500;
const energyCache = new Map<string, Promise<EnergyAnalysis | undefined>>();

/**
 * Measure every audio source the project plays. A transcript already carries
 * the energy curve for speech; library sounds and music are measured once per
 * process (a file's levels never change) and cached by asset id.
 */
export async function loadProjectEnergy(
  project: Project,
  assets: Pick<AssetStore, 'get'>,
  transcripts?: Pick<TranscriptService, 'get'>,
): Promise<EnergyLookup> {
  const ids = new Set(project.tracks.filter((track) => track.kind === 'video' || track.kind === 'audio')
    .flatMap((track) => track.clips.map((clip) => clip.assetId).filter((id): id is string => Boolean(id))));
  const resolved = new Map<string, EnergyAnalysis>();
  await Promise.all([...ids].map(async (id) => {
    const fromTranscript = transcripts?.get(id)?.energy;
    if (fromTranscript) {
      resolved.set(id, fromTranscript);
      return;
    }
    const asset = assets.get(id);
    if (!asset?.hasAudio) return;
    const energy = await measure(asset);
    if (energy) resolved.set(id, energy);
  }));
  return (assetId) => resolved.get(assetId);
}

function measure(asset: StoredAsset): Promise<EnergyAnalysis | undefined> {
  const cached = energyCache.get(asset.id);
  if (cached) return cached;
  const pending = analyzeEnergy(asset.originalPath).catch(() => {
    energyCache.delete(asset.id);
    return undefined;
  });
  energyCache.set(asset.id, pending);
  if (energyCache.size > ENERGY_CACHE_LIMIT) energyCache.delete(energyCache.keys().next().value as string);
  return pending;
}
