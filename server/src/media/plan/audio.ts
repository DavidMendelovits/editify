import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audioEntryEnd, type PlanAudioEntry, type PlanLoudness, type RenderPlan } from '@editify/shared';
import type { PlanMediaProbe } from './media.js';

/*
 * The plan's audio (RenderPlan audioEntry + loudness), rendered to one PCM
 * master before the picture so it can be measured:
 *
 * 1. Every entry: source [in, out) of the asset's first audio track,
 *    resampled to 48 kHz, mapped to stereo (mono to both sides at unity,
 *    more than two channels by ITU-R BS.775 with the LFE dropped),
 *    time-stretched by `speed` with pitch kept (atempo), cut to exactly
 *    (out - in) / speed, faded (linear = afade tri, halfSine = afade hsin;
 *    the two fades multiply where they overlap), multiplied by its gain keys
 *    per sample (aeval: linear between keys, held outside), and placed at
 *    `at` to the sample.
 * 2. All entries summed with no normalization (amix normalize=0) over a
 *    silent bed exactly round(duration * 48000) samples long, written as
 *    32-bit float WAV.
 * 3. Loudness (planLoudnessGain): the master is measured with render-qa's
 *    EBU R128 scan, then the final pass applies one gain and, whenever
 *    targetLufs is set, a look-ahead limiter at limiterCeilingDb with its
 *    latency compensated (alimiter latency=1), so the picture needs no delay.
 */

export const AUDIO_RATE = 48000;
/** Audio inputs per ffmpeg: past this the mix is built in stages, so a long edit never opens thousands of files at once. */
const ENTRIES_PER_STAGE = 48;

/** Expression for a piecewise-linear function of `variable`, as a balanced tree so evaluation depth stays log2(keys). */
export function piecewiseLinear(keys: ReadonlyArray<{ t: number; v: number }>, variable: string): string {
  const num = (value: number): string => {
    const text = String(Number(value.toPrecision(12)));
    return text.startsWith('-') ? `(${text})` : text;
  };
  if (keys.length === 0) return '1';
  if (keys.length === 1) return num(keys[0]!.v);
  const build = (lo: number, hi: number): string => {
    if (hi - lo === 1) {
      const a = keys[lo]!;
      const b = keys[hi]!;
      if (a.v === b.v) return num(a.v);
      return `(${num(a.v)}+${num(b.v - a.v)}*(${variable}-${num(a.t)})/${num(b.t - a.t)})`;
    }
    const mid = Math.floor((lo + hi) / 2);
    return `if(lt(${variable},${num(keys[mid]!.t)}),${build(lo, mid)},${build(mid, hi)})`;
  };
  const first = keys[0]!;
  const last = keys.at(-1)!;
  return `if(lt(${variable},${num(first.t)}),${num(first.v)},if(gt(${variable},${num(last.t)}),${num(last.v)},${build(0, keys.length - 1)}))`;
}

/** Linear interpolation of 0..1-style keys at t: held outside the range (the schema's key rule). */
export function keyValueAt(keys: ReadonlyArray<{ t: number; v: number }>, t: number): number {
  if (keys.length === 0) return 1;
  if (t <= keys[0]!.t) return keys[0]!.v;
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index]!;
    if (t <= right.t) {
      const left = keys[index - 1]!;
      return right.t > left.t ? left.v + ((right.v - left.v) * (t - left.t)) / (right.t - left.t) : right.v;
    }
  }
  return keys.at(-1)!.v;
}

function atempoChain(speed: number): string {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-9) filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters.join(',');
}

const LAYOUT_CHANNELS: Record<string, string[]> = {
  '3.0': ['FL', 'FR', 'FC'],
  quad: ['FL', 'FR', 'BL', 'BR'],
  '4.0': ['FL', 'FR', 'FC', 'BC'],
  '5.0': ['FL', 'FR', 'FC', 'BL', 'BR'],
  '5.0(side)': ['FL', 'FR', 'FC', 'SL', 'SR'],
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '5.1(side)': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
  '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  '7.1(wide)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'],
};

/**
 * The stereo mapping (schema: mono at unity in both channels; more than two
 * channels by ITU-R BS.775, L = L + 0.7071 C + 0.7071 Ls, LFE dropped).
 */
export function stereoMap(channels: number, layout: string): string {
  if (channels <= 1) return 'pan=stereo|c0=c0|c1=c0';
  if (channels === 2) return 'pan=stereo|c0=c0|c1=c1';
  const names = LAYOUT_CHANNELS[layout];
  if (!names) return 'aformat=channel_layouts=stereo';
  const k = '0.7071';
  const left = ['FL'];
  const right = ['FR'];
  for (const name of names) {
    if (name === 'FC' || name === 'BC') {
      left.push(`${k}*${name}`);
      right.push(`${k}*${name}`);
    } else if (['BL', 'SL', 'FLC'].includes(name)) left.push(`${k}*${name}`);
    else if (['BR', 'SR', 'FRC'].includes(name)) right.push(`${k}*${name}`);
  }
  return `pan=stereo|FL=${left.join('+')}|FR=${right.join('+')}`;
}

/** Where an entry's input opens its source: a whole tenth at least 0.2 s before `in` (render.ts seekPoint). */
function seekPoint(sourceIn: number): number {
  return Math.max(0, Math.floor(sourceIn * 10 - 2) / 10);
}

const fixed = (value: number): string => String(Number(value.toFixed(6)));

interface EntryGraph {
  args: string[];
  chain: (input: number, label: string) => string;
}

function entryGraph(entry: PlanAudioEntry, media: PlanMediaProbe): EntryGraph {
  const seek = seekPoint(entry.in);
  const length = audioEntryEnd(entry) - entry.at;
  const samples = Math.max(1, Math.round(length * AUDIO_RATE));
  const fade = (spec: PlanAudioEntry['fadeIn'], type: 'in' | 'out'): string | undefined => {
    const count = Math.min(samples, Math.round(spec.duration * AUDIO_RATE));
    if (count <= 0) return undefined;
    const curve = spec.curve === 'linear' ? 'tri' : 'hsin';
    return type === 'in'
      ? `afade=t=in:curve=${curve}:ss=0:ns=${count}`
      : `afade=t=out:curve=${curve}:ss=${samples - count}:ns=${count}`;
  };
  const keys = entry.gainKeys.map((key) => ({ t: key.t, v: key.gain }));
  const constant = keys.every((key) => key.v === keys[0]!.v);
  // aeval's t is the entry's own time; the keys are on the timeline.
  const gain = constant
    ? (keys[0]!.v === 1 ? undefined : `volume=${keys[0]!.v}`)
    : `aeval=exprs='st(0,t+${fixed(entry.at)});val(0)*(${piecewiseLinear(keys, 'ld(0)')})|st(0,t+${fixed(entry.at)});val(1)*(${piecewiseLinear(keys, 'ld(0)')})':c=same`;
  const delay = Math.round(entry.at * AUDIO_RATE);
  const tempo = atempoChain(entry.speed);
  return {
    args: [...(seek > 0 ? ['-noaccurate_seek', '-ss', fixed(seek)] : []), '-vn', '-sn', '-dn', '-i', media.path],
    chain: (input, label) => [
      `[${input}:a:0]aresample=${AUDIO_RATE}`,
      stereoMap(media.audioChannels, media.audioLayout),
      `atrim=start=${fixed(entry.in - seek)}:end=${fixed(entry.out - seek)}`,
      'asetpts=PTS-STARTPTS',
      ...(tempo ? [tempo] : []),
      // atempo can come up a few samples short at the end: pad, then cut to the exact length.
      `apad=whole_len=${samples}`,
      `atrim=end_sample=${samples}`,
      'asetpts=PTS-STARTPTS',
      ...[fade(entry.fadeIn, 'in'), fade(entry.fadeOut, 'out')].filter((value): value is string => Boolean(value)),
      ...(gain ? [gain] : []),
      ...(delay > 0 ? [`adelay=delays=${delay}S:all=1`] : []),
      `aformat=sample_fmts=flt:sample_rates=${AUDIO_RATE}:channel_layouts=stereo[${label}]`,
    ].join(','),
  };
}

export interface AudioJob {
  /** ffmpeg argument lists to run in order; the last one writes `wavPath`. */
  runs: string[][];
  wavPath: string;
  samples: number;
}

/**
 * The ffmpeg runs that render the plan's audio master to a float WAV of
 * exactly round(duration * 48000) stereo samples. Graphs go to script files
 * via `script` (the filtergraph can outgrow a command-line argument).
 */
export async function planAudioJob(
  plan: RenderPlan,
  media: ReadonlyMap<string, PlanMediaProbe>,
  workDir: string,
  script: (path: string) => string[],
): Promise<AudioJob> {
  const samples = Math.round(plan.duration * AUDIO_RATE);
  const wavPath = join(workDir, 'mix.wav');
  const playable = plan.audio.filter((entry) => {
    const probe = media.get(entry.assetRef.id);
    return probe && probe.audioChannels > 0;
  });
  const stages: PlanAudioEntry[][] = [];
  for (let at = 0; at < playable.length; at += ENTRIES_PER_STAGE) stages.push(playable.slice(at, at + ENTRIES_PER_STAGE));
  const bed = `anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=end_sample=${samples},aformat=sample_fmts=flt[bed]`;
  const output = (path: string): string[] => ['-c:a', 'pcm_f32le', '-ar', String(AUDIO_RATE), '-ac', '2', '-f', 'wav', path];
  const runs: string[][] = [];
  const stagePaths: string[] = [];
  for (const [index, entries] of stages.entries()) {
    const args: string[] = ['-y', '-nostdin'];
    const lines: string[] = [];
    entries.forEach((entry, at) => {
      const graph = entryGraph(entry, media.get(entry.assetRef.id)!);
      args.push(...graph.args);
      lines.push(graph.chain(at, `a${at}`));
    });
    lines.push(bed);
    lines.push(`[bed]${entries.map((_, at) => `[a${at}]`).join('')}amix=inputs=${entries.length + 1}:duration=first:normalize=0,atrim=end_sample=${samples}[mix]`);
    const graphPath = join(workDir, `audio-${index}.graph`);
    await writeFile(graphPath, lines.join(';\n'), 'utf8');
    const path = stages.length === 1 ? wavPath : join(workDir, `audio-${index}.wav`);
    runs.push([...args, ...script(graphPath), '-map', '[mix]', ...output(path)]);
    stagePaths.push(path);
  }
  if (stages.length !== 1) {
    // No entries (a silent master), or several stages summed once more.
    const args: string[] = ['-y', '-nostdin'];
    const lines = [bed];
    stagePaths.forEach((path, at) => {
      args.push('-i', path);
      lines.push(`[${at}:a]aformat=sample_fmts=flt[s${at}]`);
    });
    lines.push(`[bed]${stagePaths.map((_, at) => `[s${at}]`).join('')}amix=inputs=${stagePaths.length + 1}:duration=first:normalize=0,atrim=end_sample=${samples}[mix]`);
    const graphPath = join(workDir, 'audio-sum.graph');
    await writeFile(graphPath, lines.join(';\n'), 'utf8');
    runs.push([...args, ...script(graphPath), '-map', '[mix]', ...output(wavPath)]);
  }
  return { runs, wavPath, samples };
}

export interface LoudnessDecision {
  /** One gain for the whole master, dB (0 when none). */
  gainDb: number;
  limit: boolean;
  /** Why no gain was applied, when none was. */
  reason?: 'off' | 'silent' | 'deadband';
}

/** The schema's loudness rule (render-qa.ts's gain rule, limiter always on). */
export function planLoudnessGain(loudness: PlanLoudness, integrated: number | null): LoudnessDecision {
  if (loudness.targetLufs === null) return { gainDb: 0, limit: false, reason: 'off' };
  if (integrated === null || integrated <= loudness.silentBelowLufs) return { gainDb: 0, limit: true, reason: 'silent' };
  if (Math.abs(integrated - loudness.targetLufs) <= loudness.deadbandLu) return { gainDb: 0, limit: true, reason: 'deadband' };
  return { gainDb: Math.round((loudness.targetLufs - integrated) * 10) / 10, limit: true };
}

/** The master's final-pass audio filters for a loudness decision. */
export function loudnessFilters(loudness: PlanLoudness, decision: LoudnessDecision): string[] {
  const filters: string[] = [];
  if (decision.gainDb !== 0) filters.push(`volume=${decision.gainDb.toFixed(1)}dB`);
  if (decision.limit) {
    const ceiling = (10 ** (loudness.limiterCeilingDb / 20)).toFixed(6);
    filters.push(`alimiter=limit=${ceiling}:level=disabled:latency=1`);
  }
  return filters;
}
