import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Project, RenderQa } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import { runProcess } from '../media/process.js';
import { checkMix, loadProjectEnergy } from './mix-check.js';

/**
 * Checks a finished master the way a careful editor would before handing it
 * over: integrated loudness and true peak, dead air left inside the speech,
 * a contact sheet of frames, and the sound-effect levels against the voice.
 * With `normalize`, a master off the -16 LUFS target gets one gain stage and
 * a limiter on its audio (the picture is copied, not re-encoded).
 * Adapted from kurbaitaev/ghost-editor scripts/qa.py (MIT).
 */
export const TARGET_LUFS = -16;
const LOUDNESS_TOLERANCE_LU = 1.5;
/** Platforms transcode; a true peak above this can clip after they do. */
const MAX_TRUE_PEAK_DB = -1;
/** The limiter ceiling, a little under the true-peak limit to leave inter-sample headroom. */
const LIMITER_CEILING_DB = -1.5;
/** Pauses longer than this inside the speech read as dead air. */
const DEAD_AIR_SEC = 0.8;
/** Below this there is no programme audio to normalize. */
const SILENT_MASTER_LUFS = -60;
const CONTACT_TILES = { columns: 6, rows: 3 };

export type LoudnessMode = 'normalize' | 'off';

interface Loudness { integrated: number | null; truePeak: number | null }

export async function measureLoudness(path: string): Promise<Loudness> {
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-nostats', '-i', path, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-',
  ]);
  return parseLoudness(stderr);
}

export function parseLoudness(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const integrated = summary.match(/\bI:\s*(-?[0-9.]+|-inf)\s*LUFS/);
  const peak = summary.match(/\bPeak:\s*(-?[0-9.]+|-inf)\s*dBFS/);
  const value = (match: RegExpMatchArray | null): number | null => {
    if (!match?.[1] || match[1] === '-inf') return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return { integrated: value(integrated), truePeak: value(peak) };
}

/** Silent spans strictly inside the programme: leading and trailing air is the edit's business. */
export function parseSilences(stderr: string, duration: number): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let open: number | undefined;
  for (const line of stderr.split('\n')) {
    const start = line.match(/silence_start:\s*(-?[0-9.]+)/);
    if (start?.[1]) open = Math.max(0, Number(start[1]));
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end?.[1] && open !== undefined) {
      spans.push({ start: open, end: Number(end[1]) });
      open = undefined;
    }
  }
  return spans
    .filter((span) => span.start > 0.3 && span.end < duration - 0.3 && span.end - span.start >= DEAD_AIR_SEC)
    .map((span) => ({ start: round2(span.start), end: round2(span.end) }));
}

async function findDeadAir(path: string, duration: number, integrated: number | null): Promise<Array<{ start: number; end: number }>> {
  // Relative to the programme: a quiet master's pauses are quieter too.
  const threshold = integrated === null ? -50 : Math.min(-35, Math.max(-60, integrated - 20));
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-nostats', '-i', path, '-vn', '-af', `silencedetect=noise=${threshold}dB:d=${DEAD_AIR_SEC}`, '-f', 'null', '-',
  ]);
  return parseSilences(stderr, duration);
}

async function normalizeAudio(path: string, gainDb: number): Promise<void> {
  const pending = join(dirname(path), 'normalized.tmp.mp4');
  const ceiling = (10 ** (LIMITER_CEILING_DB / 20)).toFixed(4);
  try {
    await runProcess('ffmpeg', [
      '-y', '-i', path, '-map', '0:v?', '-map', '0:a',
      '-c:v', 'copy', '-af', `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${ceiling}:level=disabled`,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', pending,
    ]);
    await rename(pending, path);
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  }
}

async function writeContactSheet(path: string, duration: number, project: Project): Promise<string> {
  const sheet = join(dirname(path), 'contact.jpg');
  const tiles = CONTACT_TILES.columns * CONTACT_TILES.rows;
  const [tileWidth, tileHeight] = project.format === '9:16' ? [180, 320] : project.format === '1:1' ? [240, 240] : [320, 180];
  await runProcess('ffmpeg', [
    '-y', '-i', path, '-an',
    '-vf', `fps=${(tiles / Math.max(duration, 0.1)).toFixed(5)},scale=${tileWidth}:${tileHeight},tile=${CONTACT_TILES.columns}x${CONTACT_TILES.rows}`,
    '-frames:v', '1', '-update', '1', '-q:v', '4', sheet,
  ]);
  return sheet;
}

export async function runRenderQa(
  outputPath: string,
  project: Project,
  assets: Pick<AssetStore, 'get'>,
  mode: LoudnessMode,
): Promise<RenderQa> {
  const duration = Math.max(project.duration, 0.1);
  const warnings: string[] = [];
  let loudness = await measureLoudness(outputPath);
  let normalized: RenderQa['normalized'] = null;
  if (mode === 'normalize' && loudness.integrated !== null && loudness.integrated > SILENT_MASTER_LUFS
    && Math.abs(loudness.integrated - TARGET_LUFS) > 0.5) {
    const gainDb = round1(TARGET_LUFS - loudness.integrated);
    await normalizeAudio(outputPath, gainDb);
    normalized = { fromLufs: loudness.integrated, gainDb };
    loudness = await measureLoudness(outputPath);
  }

  if (loudness.integrated === null || loudness.integrated <= SILENT_MASTER_LUFS) {
    warnings.push('The master is silent.');
  } else if (Math.abs(loudness.integrated - TARGET_LUFS) > LOUDNESS_TOLERANCE_LU) {
    warnings.push(`Loudness is ${loudness.integrated} LUFS; short-form platforms expect about ${TARGET_LUFS}.`);
  }
  if (loudness.truePeak !== null && loudness.truePeak > MAX_TRUE_PEAK_DB) {
    warnings.push(`True peak is ${loudness.truePeak} dBFS; above ${MAX_TRUE_PEAK_DB} it can clip after the platform transcodes it.`);
  }

  const [deadAir, contactSheet, mix] = await Promise.all([
    findDeadAir(outputPath, duration, loudness.integrated).catch(() => []),
    writeContactSheet(outputPath, duration, project).then(() => true, () => false),
    loadProjectEnergy(project, assets).then((energy) => checkMix(project, energy)).catch(() => undefined),
  ]);
  for (const span of deadAir) {
    warnings.push(`${(span.end - span.start).toFixed(1)}s of silence at ${span.start.toFixed(1)}s.`);
  }
  if (mix) warnings.push(...mix.warnings);

  return {
    targetLufs: TARGET_LUFS,
    loudnessLufs: loudness.integrated,
    truePeakDb: loudness.truePeak,
    normalized,
    deadAir,
    mix: mix ? {
      voiceReferenceDb: mix.voiceReferenceDb,
      hitsPerMinute: mix.hitsPerMinute,
      offTarget: [...mix.hits, ...mix.beds].filter((hit) => hit.verdict !== 'ok').length,
    } : null,
    contactSheet,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
