import type { StyleTemplate, VideoObservation } from './observation.js';

/**
 * Folds per-video observations into one template. One video is one pattern;
 * several videos make a style, so medians and modes are used rather than the
 * first answer, and a section a single analyzer never filled stays null.
 */
export function buildStyleTemplate(observations: VideoObservation[]): StyleTemplate {
  if (observations.length === 0) throw new Error('A style template needs at least one observation');
  const durations = observations.map((observation) => observation.durationSeconds);
  const shots = numbers(observations.map((observation) => observation.pacing?.averageShotSeconds));
  const cuts = observations.map((observation) => observation.pacing?.cutCount ?? null);
  const cutDensities = observations.flatMap((observation, index) => {
    const count = cuts[index];
    return count === null || count === undefined || observation.durationSeconds <= 0 ? [] : [count / observation.durationSeconds];
  });
  const captionFlags = observations.map((observation) => observation.captions?.present).filter((flag): flag is boolean => typeof flag === 'boolean');
  return {
    videoCount: observations.length,
    watchedCount: observations.filter((observation) => observation.watched).length,
    analyzers: [...new Set(observations.map((observation) => observation.analyzer))],
    format: mode(observations.map((observation) => observation.format)) ?? '9:16',
    durationSeconds: { median: median(durations) ?? 0, min: Math.min(...durations), max: Math.max(...durations) },
    pacing: {
      averageShotSeconds: round(median(shots)),
      cutDensity: round(median(cutDensities), 3),
      rhythm: mode(observations.map((observation) => observation.pacing?.rhythm)),
    },
    hook: {
      durationSeconds: round(median(numbers(observations.map((observation) => observation.hook?.durationSeconds)))),
      technique: mode(observations.map((observation) => observation.hook?.technique)),
    },
    captions: {
      presentRatio: captionFlags.length ? round(captionFlags.filter(Boolean).length / captionFlags.length, 2) : null,
      position: mode(observations.map((observation) => observation.captions?.position)),
      style: mode(observations.map((observation) => observation.captions?.style)),
      animation: mode(observations.map((observation) => observation.captions?.animation)),
    },
    transitions: {
      dominant: mode(observations.map((observation) => observation.transitions?.dominant)),
      frequency: mode(observations.map((observation) => observation.transitions?.frequency)),
    },
    audio: {
      loudnessLufs: round(median(numbers(observations.map((observation) => observation.audio?.loudnessLufs)))),
      music: mode(observations.map((observation) => observation.audio?.music)),
      soundEffects: mode(observations.map((observation) => observation.audio?.soundEffects)),
      voice: mode(observations.map((observation) => observation.audio?.voice)),
    },
    visuals: {
      colorGrade: mode(observations.map((observation) => observation.visuals?.colorGrade)),
      framing: mode(observations.map((observation) => observation.visuals?.framing)),
      punchIns: mode(observations.map((observation) => observation.visuals?.punchIns)),
      bRoll: mode(observations.map((observation) => observation.visuals?.bRoll)),
    },
    text: {
      overlays: mode(observations.map((observation) => observation.text?.overlays)),
      emoji: mode(observations.map((observation) => observation.text?.emoji)),
    },
    tags: rankTags(observations),
  };
}

/** A readable fallback brief when no language model is reachable. */
export function describeTemplate(template: StyleTemplate): string {
  const parts: string[] = [];
  const shot = template.pacing.averageShotSeconds;
  parts.push(`${template.pacing.rhythm ?? 'balanced'} pacing${shot !== null ? ` at about ${shot.toFixed(1)}s per shot` : ''}`);
  if (template.hook.technique) parts.push(`opens with ${template.hook.technique}`);
  if (template.captions.presentRatio !== null && template.captions.presentRatio >= 0.5) {
    parts.push(`${template.captions.style ?? 'bold readable'} captions${template.captions.position ? ` at the ${template.captions.position}` : ''}`);
  } else if (template.captions.presentRatio === null) {
    parts.push('bold readable captions');
  }
  if (template.transitions.dominant) parts.push(`${template.transitions.dominant} transitions`);
  const loudness = template.audio.loudnessLufs;
  if (loudness !== null) parts.push(loudness > -16 ? 'loud, present audio' : 'controlled audio');
  if (template.audio.music) parts.push(`music: ${template.audio.music}`);
  if (template.visuals.colorGrade) parts.push(`${template.visuals.colorGrade} grade`);
  const watched = template.watchedCount > 0
    ? `Based on ${template.watchedCount} of ${template.videoCount} videos watched by ${template.analyzers.join(', ')}.`
    : 'Based on ffmpeg measurements only; no video was watched.';
  return `${capitalize(parts.join(', '))}. ${watched}`;
}

function rankTags(observations: VideoObservation[]): StyleTemplate['tags'] {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    for (const tag of new Set(observation.tags.map((value) => value.trim().toLowerCase()).filter(Boolean))) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
    .slice(0, 12);
}

function numbers(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Most frequent non-empty answer; ties go to the earliest seen. */
export function mode<T extends string | boolean>(values: Array<T | null | undefined>): T | null {
  const counts = new Map<T, number>();
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
