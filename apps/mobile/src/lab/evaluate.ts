/**
 * Capability-lab evaluator: turns the rows the device appends to
 * Documents/lab/results.jsonl into one go/no-go verdict per
 * device × spike × variant.
 *
 *   rows ──group by device/spike/variant──▶ ok rows ──median + worst per metric──▶ thresholds ──▶ verdict
 *                                   └─ refused rows dropped, killed rows fail the group
 *
 * The median decides go/no-go; a group whose median passes but whose worst run
 * fails is "borderline", so thermal or battery noise can't hide behind one good run.
 */

export type SpikeId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11';
export type Thermal = 'nominal' | 'fair' | 'serious' | 'critical';
export type MetricValue = number | boolean | Thermal;

export interface LabRow {
  spike: SpikeId;
  /** Which arm of the spike, e.g. `render1080-source` or `writer-hevc-hlg`. */
  variant: string;
  run: number;
  device: string;
  ios: string;
  config: 'Release' | 'Debug';
  /** `killed`: the run's end marker was missing on next launch (jetsam or crash). */
  status: 'ok' | 'refused' | 'killed' | 'error';
  startedAt: string;
  thermalStart: Thermal;
  thermalEnd: Thermal;
  memPeakMB: number;
  batteryStart: number;
  batteryEnd: number;
  metrics: Record<string, MetricValue>;
  note?: string;
}

type Op = '<' | '<=' | '>=' | '==';
interface Check { metric: string; op: Op; value: MetricValue }
/** `also`: further arms of the same spike that get their own verdict. */
interface Rule { variant: string; checks: Check[]; also?: Array<{ variant: string; checks: Check[] }> }

const THERMAL_RANK: Record<Thermal, number> = { nominal: 0, fair: 1, serious: 2, critical: 3 };
const MEM_CEILING_MB = 1200;

/** Mirrors the go/no-go column of the plan's lab table. `variant` is the arm the verdict is about. */
export const THRESHOLDS: Record<SpikeId, Rule> = {
  S1: { variant: 'render1080-source', checks: [
    { metric: 'fpsSustained', op: '>=', value: 29.5 },
    { metric: 'thermalEnd', op: '<=', value: 'fair' },
    { metric: 'memPeakMB', op: '<', value: MEM_CEILING_MB },
  ], also: [
    // P7 (5B): the same gate on the finished renderer, PlanPlayer playing the lab's stand-up cut.
    { variant: 'render1080-plan', checks: [
      { metric: 'fpsSustained', op: '>=', value: 29.5 },
      { metric: 'thermalEnd', op: '<=', value: 'fair' },
      { metric: 'memPeakMB', op: '<', value: MEM_CEILING_MB },
    ] },
  ] },
  S2: { variant: 'hevc-source', checks: [
    { metric: 'newestFrameP95Ms', op: '<', value: 100 },
    { metric: 'exactFrameMs', op: '<', value: 150 },
  ] },
  S3: { variant: 'clips50', checks: [
    { metric: 'paramStallMs', op: '<', value: 1000 / 60 },
    { metric: 'structuralStallMs', op: '<', value: 100 },
  ] },
  // S4 and S5 run PlanExporter and PlanPlayer on the lab's stand-up cut (src/lab/standup-plan.ts).
  S4: { variant: 'writer-60s-4k30', checks: [
    { metric: 'exportSeconds', op: '<', value: 30 },
    { metric: 'tagsCorrect', op: '==', value: true },
    { metric: 'fpsKept', op: '==', value: true },
    { metric: 'memPeakMB', op: '<', value: MEM_CEILING_MB },
  ], also: [
    // The 1080p SDR export the app ships today: held to the 4K budget, so it must clear it easily.
    { variant: 'writer-60s-1080', checks: [
      { metric: 'exportSeconds', op: '<', value: 30 },
      { metric: 'tagsCorrect', op: '==', value: true },
      { metric: 'fpsKept', op: '==', value: true },
      { metric: 'memPeakMB', op: '<', value: MEM_CEILING_MB },
    ] },
  ] },
  // msPerFrame: the compositor's p50 per frame (msPerFrameP95 is reported beside it).
  S5: { variant: 'preview1080', checks: [
    { metric: 'msPerFrame', op: '<', value: 4 },
    { metric: 'visualMatch', op: '==', value: true },
    { metric: 'memPeakMB', op: '<', value: MEM_CEILING_MB },
  ] },
  S6: { variant: 'photos', checks: [
    { metric: 'localMs', op: '<', value: 200 },
    { metric: 'icloudProgress', op: '==', value: true },
    { metric: 'icloudCancellable', op: '==', value: true },
    { metric: 'deletedDetected', op: '==', value: true },
    { metric: 'limitedDetected', op: '==', value: true },
  ] },
  S7: { variant: 'continued-processing', checks: [
    { metric: 'completedInBackground', op: '==', value: true },
    { metric: 'progressUiCorrect', op: '==', value: true },
  ] },
  S8: { variant: 'speech-analyzer', checks: [
    { metric: 'timestampDeltaP95Ms', op: '<', value: 100 },
    { metric: 'qualityOk', op: '==', value: true },
  ] },
  S9: { variant: 'bridge30hz', checks: [
    { metric: 'dragToPixelFrames', op: '<', value: 2 },
    { metric: 'jsThreadPct', op: '<', value: 30 },
  ] },
  S10: { variant: 'proxy540', checks: [
    { metric: 'realtimeFactor', op: '>=', value: 10 },
  ] },
  // P2 analyzers end to end (decode, sync, words, laughter, energy, faces). The M4 Max
  // ran a 295 s set in about 8 s (37x); a phone at 5x still has a 5-minute set ready in
  // a minute. Every analyzer must come back ready (the words model installed) and faces
  // must find a face (a detector failing every frame reads as "no faces"). Sync must
  // fine-lock and land within 2 ms of a fine-locked reference for a real memo pair
  // (stand-up pair: 59.424); a self-check (no memo) aligns sample-identical audio, so it
  // can't pass. Known divergence to investigate, not to absorb here: on the stand-up pair
  // the same Swift code fine-locks on the simulator (score 4.17) but not on macOS
  // (3.44, under the 4.0 lock score), where it falls back to the 10 ms coarse cell.
  S11: { variant: 'pipeline', checks: [
    { metric: 'readyRealtimeFactor', op: '>=', value: 5 },
    { metric: 'wordsReady', op: '==', value: true },
    { metric: 'laughterReady', op: '==', value: true },
    { metric: 'facesReady', op: '==', value: true },
    { metric: 'facesFound', op: '==', value: true },
    { metric: 'syncSelfCheck', op: '==', value: false },
    { metric: 'syncFineLocked', op: '==', value: true },
    { metric: 'syncParity', op: '==', value: true },
    { metric: 'memPeakMB', op: '<', value: MEM_CEILING_MB },
    { metric: 'thermalEnd', op: '<=', value: 'fair' },
  ], also: [
    // 8A: playback holds the heavy lane (within one step of the running part).
    { variant: 'scheduler', checks: [{ metric: 'pauseHeld', op: '==', value: true }, { metric: 'partsFailed', op: '==', value: 0 }] },
  ] },
};

export const RUNS_REQUIRED = 3;

export type Verdict = 'go' | 'borderline' | 'no-go' | 'insufficient' | 'killed';

export interface GroupResult {
  device: string;
  spike: SpikeId;
  variant: string;
  runs: number;
  verdict: Verdict;
  /** Per checked metric: median and worst across ok runs, and whether each passes. */
  metrics: Array<{ metric: string; op: Op; target: MetricValue; median: MetricValue; worst: MetricValue; medianPass: boolean; worstPass: boolean }>;
  /** Why a group couldn't be judged or failed outright, e.g. a missing metric. */
  problems: string[];
}

/** Environment fields double as metrics so thresholds can name them uniformly. */
function metricOf(row: LabRow, metric: string): MetricValue | undefined {
  if (metric === 'memPeakMB') return row.memPeakMB;
  if (metric === 'thermalEnd') return row.thermalEnd;
  return row.metrics[metric];
}

function rank(value: MetricValue): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  return THERMAL_RANK[value];
}

function passes(value: MetricValue, op: Op, target: MetricValue): boolean {
  if (op === '==') return value === target;
  const a = rank(value);
  const b = rank(target);
  return op === '<' ? a < b : op === '<=' ? a <= b : a >= b;
}

/** Worst = the direction that fails the check: max for `<`/`<=`, min for `>=`, any mismatch for `==`. */
function worstOf(values: MetricValue[], op: Op, target: MetricValue): MetricValue {
  if (op === '==') return values.find((value) => value !== target) ?? target;
  const sorted = [...values].sort((a, b) => rank(a) - rank(b));
  return (op === '>=' ? sorted[0] : sorted[sorted.length - 1])!;
}

function medianOf(values: MetricValue[]): MetricValue {
  const sorted = [...values].sort((a, b) => rank(a) - rank(b));
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid]!;
  if (sorted.length % 2 === 1 || typeof upper !== 'number') return upper;
  return ((sorted[mid - 1] as number) + upper) / 2;
}

export function evaluate(rows: LabRow[]): GroupResult[] {
  const groups = new Map<string, LabRow[]>();
  for (const row of rows) {
    if (row.status === 'refused') continue;
    const key = `${row.device}\u0000${row.spike}\u0000${row.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const results: GroupResult[] = [];
  for (const groupRows of groups.values()) {
    const { device, spike, variant } = groupRows[0]!;
    const spikeRule = THRESHOLDS[spike];
    const rule = [spikeRule, ...(spikeRule.also ?? [])].find((arm) => arm.variant === variant) ?? spikeRule;
    const ok = groupRows.filter((row) => row.status === 'ok');
    const problems = groupRows
      .filter((row) => row.config !== 'Release')
      .map((row) => `run ${row.run} is a ${row.config} build; numbers are not decision-grade`);
    const base = { device, spike, variant, runs: ok.length, problems };

    // Only the arm named in the threshold gets a verdict; other arms are context.
    if (variant !== rule.variant) {
      results.push({ ...base, verdict: ok.length >= RUNS_REQUIRED ? 'go' : 'insufficient', metrics: [] });
      continue;
    }
    if (groupRows.some((row) => row.status === 'killed')) {
      results.push({ ...base, verdict: 'killed', metrics: [], problems: [...problems, 'a run was terminated before its end marker (likely jetsam)'] });
      continue;
    }
    if (ok.length < RUNS_REQUIRED) {
      results.push({ ...base, verdict: 'insufficient', metrics: [], problems: [...problems, `${ok.length}/${RUNS_REQUIRED} ok runs`] });
      continue;
    }

    const metrics: GroupResult['metrics'] = [];
    for (const check of rule.checks) {
      const values = ok.map((row) => metricOf(row, check.metric));
      if (values.some((value) => value === undefined)) {
        problems.push(`missing metric ${check.metric}`);
        continue;
      }
      const present = values as MetricValue[];
      const median = medianOf(present);
      const worst = worstOf(present, check.op, check.value);
      metrics.push({
        metric: check.metric, op: check.op, target: check.value, median, worst,
        medianPass: passes(median, check.op, check.value),
        worstPass: passes(worst, check.op, check.value),
      });
    }
    const verdict: Verdict = problems.some((p) => p.startsWith('missing')) || metrics.some((m) => !m.medianPass) ? 'no-go'
      : metrics.some((m) => !m.worstPass) || problems.length > 0 ? 'borderline'
        : 'go';
    results.push({ ...base, verdict, metrics, problems });
  }
  return results.sort((a, b) => a.device.localeCompare(b.device)
    || Number(a.spike.slice(1)) - Number(b.spike.slice(1)) || a.variant.localeCompare(b.variant));
}

export function parseRows(jsonl: string): LabRow[] {
  return jsonl.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as LabRow);
}

function fmt(value: MetricValue): string {
  return typeof value === 'number' ? String(Math.round(value * 10) / 10) : String(value);
}

/** One markdown table per device, ready to paste into research/mobile-capabilities.md. */
export function toMarkdown(results: GroupResult[]): string {
  const byDevice = new Map<string, GroupResult[]>();
  for (const result of results) byDevice.set(result.device, [...(byDevice.get(result.device) ?? []), result]);
  const sections: string[] = [];
  for (const [device, deviceResults] of byDevice) {
    const lines = [`### ${device}`, '', '| Spike | Variant | Runs | Verdict | Median / worst vs target | Problems |', '|---|---|---|---|---|---|'];
    for (const r of deviceResults) {
      const detail = r.metrics.map((m) => `${m.metric} ${fmt(m.median)} / ${fmt(m.worst)} (${m.op} ${fmt(m.target)})`).join('; ');
      lines.push(`| ${r.spike} | ${r.variant} | ${r.runs} | ${r.verdict} | ${detail || '-'} | ${r.problems.join('; ') || '-'} |`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}
