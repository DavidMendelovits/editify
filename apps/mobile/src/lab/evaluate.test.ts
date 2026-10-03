import { describe, expect, it } from 'vitest';
import { evaluate, parseRows, toMarkdown, type LabRow } from './evaluate';

function row(overrides: Partial<LabRow> = {}): LabRow {
  return {
    spike: 'S1', variant: 'render1080-source', run: 1, device: 'iPhone14,5', ios: '26.0',
    config: 'Release', status: 'ok', startedAt: '2026-10-02T10:00:00Z',
    thermalStart: 'nominal', thermalEnd: 'fair', memPeakMB: 800, batteryStart: 90, batteryEnd: 85,
    metrics: { fpsSustained: 30 },
    ...overrides,
  };
}

const runs = (overrides: Partial<LabRow>[]) => overrides.map((o, i) => row({ run: i + 1, ...o }));
/** An S5 run that passes every check unless `extra` overrides a metric. */
const preview = (msPerFrame: number, extra: Record<string, unknown> = {}): Partial<LabRow> => ({
  spike: 'S5', variant: 'preview1080',
  metrics: { compositedFrames: 600, msPerFrame, msPerFrameP95: msPerFrame * 1.5, visualMatch: true, visualDiffMaxChannel: 4, ...extra } as LabRow['metrics'],
});
/** An S1 run of the stand-up plan for the full window. */
const plan = (fpsSustained: number): Partial<LabRow> => ({ variant: 'render1080-plan', metrics: { fpsSustained, seconds: 600 } });

describe('evaluate', () => {
  it('passes a group whose median and worst runs both clear every check', () => {
    const result = evaluate(runs([{}, {}, { metrics: { fpsSustained: 29.8 } }]))[0]!;
    expect(result.verdict).toBe('go');
    expect(result.metrics.find((m) => m.metric === 'fpsSustained')).toMatchObject({ median: 30, worst: 29.8 });
  });

  it('fails when the median misses a threshold', () => {
    const result = evaluate(runs([{ metrics: { fpsSustained: 24 } }, { metrics: { fpsSustained: 25 } }, {}]))[0]!;
    expect(result.verdict).toBe('no-go');
  });

  it('is borderline when the median passes but the worst run does not', () => {
    const result = evaluate(runs([{}, {}, { thermalEnd: 'serious' }]))[0]!;
    expect(result.verdict).toBe('borderline');
    expect(result.metrics.find((m) => m.metric === 'thermalEnd')).toMatchObject({ median: 'fair', worst: 'serious', worstPass: false });
  });

  it('judges the analyzer pipeline (S11) on readiness, found faces and a real memo pair landing in sync', () => {
    const metrics = { readyRealtimeFactor: 9, wordsReady: true, laughterReady: true, facesReady: true, facesFound: true, syncSelfCheck: false, syncFineLocked: true, syncParity: true };
    const pipeline = { spike: 'S11' as const, variant: 'pipeline', metrics };
    expect(evaluate(runs([pipeline, pipeline, pipeline]))[0]!.verdict).toBe('go');
    const noModel = { ...pipeline, metrics: { ...metrics, wordsReady: false } };
    expect(evaluate(runs([noModel, noModel, pipeline]))[0]!.verdict).toBe('no-go');
    const blindFaces = { ...pipeline, metrics: { ...metrics, facesFound: false } };
    expect(evaluate(runs([blindFaces, blindFaces, blindFaces]))[0]!.verdict).toBe('no-go');
    const selfCheck = { ...pipeline, metrics: { ...metrics, syncSelfCheck: true } };
    expect(evaluate(runs([selfCheck, selfCheck, selfCheck]))[0]!.verdict).toBe('no-go');
    const offSync = { ...pipeline, metrics: { ...metrics, syncParity: false } };
    expect(evaluate(runs([offSync, offSync, pipeline]))[0]!.verdict).toBe('no-go');
    const coarseOnly = { ...pipeline, metrics: { ...metrics, syncFineLocked: false } };
    expect(evaluate(runs([coarseOnly, coarseOnly, coarseOnly]))[0]!.verdict).toBe('no-go');
  });

  it('gives the S11 scheduler arm its own verdict on pauseHeld', () => {
    const held = { spike: 'S11' as const, variant: 'scheduler', metrics: { pauseHeld: true, partsFailed: 0 } };
    expect(evaluate(runs([held, held, held]))[0]).toMatchObject({ verdict: 'go', metrics: [{ metric: 'pauseHeld' }, { metric: 'partsFailed' }] });
    const leaked = { ...held, metrics: { pauseHeld: false, partsFailed: 0 } };
    expect(evaluate(runs([leaked, leaked, held]))[0]!.verdict).toBe('no-go');
  });

  it('judges the real renderer: S4 at 4K and 1080, S5 on compositor time and the visual match, S1 on the plan', () => {
    const writer = (variant: string, exportSeconds: number, tagsCorrect = true, hlg = variant.includes('4k')) => ({
      spike: 'S4' as const, variant, metrics: { exportSeconds, xRealtime: 60 / exportSeconds, tagsCorrect, fpsKept: true, hlg },
    });
    expect(evaluate(runs([writer('writer-60s-4k30', 28), writer('writer-60s-4k30', 29), writer('writer-60s-4k30', 29.5)]))[0]!.verdict).toBe('go');
    expect(evaluate(runs([writer('writer-60s-4k30', 31), writer('writer-60s-4k30', 33), writer('writer-60s-4k30', 29)]))[0]!.verdict).toBe('no-go');
    // The 1080 arm gets its own verdict, with the same checks.
    const hd = evaluate(runs([writer('writer-60s-1080', 12), writer('writer-60s-1080', 13), writer('writer-60s-1080', 12, false)]))[0]!;
    expect(hd).toMatchObject({ variant: 'writer-60s-1080', verdict: 'borderline' });
    expect(hd.metrics.map((m) => m.metric)).toEqual(['exportSeconds', 'tagsCorrect', 'fpsKept', 'memPeakMB']);

    expect(evaluate(runs([preview(2.5), preview(3), preview(3.9)]))[0]!.verdict).toBe('go');
    expect(evaluate(runs([preview(4.2), preview(5), preview(3)]))[0]!.verdict).toBe('no-go');
    expect(evaluate(runs([preview(2), preview(2, { visualMatch: false }), preview(2, { visualMatch: false })]))[0]!.verdict).toBe('no-go');

    expect(evaluate(runs([plan(30), plan(29.9), plan(29.6)]))[0]).toMatchObject({ variant: 'render1080-plan', verdict: 'go' });
    expect(evaluate(runs([plan(24), plan(25), plan(30)]))[0]!.verdict).toBe('no-go');
  });

  it('gates 4K on the HLG master: an SDR 4K export is no-go however fast', () => {
    const sdr4k = { spike: 'S4' as const, variant: 'writer-60s-4k30', metrics: { exportSeconds: 20, tagsCorrect: true, fpsKept: true, hlg: false } };
    expect(evaluate(runs([sdr4k, sdr4k, sdr4k]))[0]!.verdict).toBe('no-go');
  });

  it('never passes S5 when nothing was composited or the device reported no timing', () => {
    // An older build reported percentile([]) = -1 for an empty run: -1 < 4 must not pass.
    const empty = preview(-1, { compositedFrames: 0, msPerFrameP95: -1 });
    expect(evaluate(runs([empty, empty, empty]))[0]!.verdict).toBe('no-go');
    // null (nothing measured) counts as a missing metric.
    const unmeasured = preview(2, { msPerFrame: null as unknown as number });
    const result = evaluate(runs([unmeasured, unmeasured, unmeasured]))[0]!;
    expect(result.verdict).toBe('no-go');
    expect(result.problems).toContain('missing metric msPerFrame');
  });

  it('gates S5 on the slow tail and on the worst channel of the visual match', () => {
    const slowTail = preview(3, { msPerFrameP95: 12 });
    expect(evaluate(runs([slowTail, slowTail, preview(3)]))[0]!.verdict).toBe('no-go');
    const brokenRegion = preview(3, { visualDiffMaxChannel: 90 });
    expect(evaluate(runs([brokenRegion, brokenRegion, preview(3)]))[0]!.verdict).toBe('no-go');
  });

  it('needs ~10 min of S1 on the plan: a short run is no-go however smooth', () => {
    const short = { variant: 'render1080-plan', metrics: { fpsSustained: 30, seconds: 120 } };
    expect(evaluate(runs([short, short, short]))[0]!.verdict).toBe('no-go');
  });

  it("never calls runs on the picker's app copy a go", () => {
    const copy = preview(2, { source: 'app-copy' } as Record<string, unknown>);
    const result = evaluate(runs([copy, preview(2, { source: 'photos' } as Record<string, unknown>), preview(2)]))[0]!;
    expect(result.verdict).toBe('borderline');
    expect(result.problems[0]).toMatch(/run 1 read the picker's app copy/);
  });

  it('needs three ok runs before judging', () => {
    const result = evaluate(runs([{}, {}]))[0]!;
    expect(result.verdict).toBe('insufficient');
  });

  it('drops refused runs instead of counting them', () => {
    const result = evaluate(runs([{}, {}, { status: 'refused' }]))[0]!;
    expect(result).toMatchObject({ verdict: 'insufficient', runs: 2 });
  });

  it('fails a group outright when any run was killed before its end marker', () => {
    const result = evaluate(runs([{}, {}, {}, { status: 'killed' }]))[0]!;
    expect(result.verdict).toBe('killed');
  });

  it('enforces the memory ceiling from the environment fields', () => {
    const result = evaluate(runs([{ memPeakMB: 1300 }, { memPeakMB: 1250 }, {}]))[0]!;
    expect(result.verdict).toBe('no-go');
  });

  it('reports a missing metric as a failure, not a pass', () => {
    const result = evaluate(runs([{ metrics: {} }, { metrics: {} }, { metrics: {} }]))[0]!;
    expect(result.verdict).toBe('no-go');
    expect(result.problems).toContain('missing metric fpsSustained');
  });

  it('never calls a Debug build a clean go', () => {
    const result = evaluate(runs([{}, {}, { config: 'Debug' }]))[0]!;
    expect(result.verdict).toBe('borderline');
  });

  it('treats any false boolean as the worst value', () => {
    const s4 = (exportSeconds: number, tagsCorrect: boolean) => ({
      spike: 'S4' as const, variant: 'writer-60s-4k30', metrics: { exportSeconds, tagsCorrect, fpsKept: true, hlg: true },
    });
    const result = evaluate(runs([s4(20, true), s4(22, true), s4(21, false)]))[0]!;
    expect(result.metrics.find((m) => m.metric === 'tagsCorrect')).toMatchObject({ median: true, worst: false });
    expect(result.verdict).toBe('borderline');
  });

  it('keeps devices and arms apart and only judges the threshold arm', () => {
    const results = evaluate([
      ...runs([{}, {}, {}]),
      ...runs([{ device: 'iPhone16,1' }, { device: 'iPhone16,1' }, { device: 'iPhone16,1' }]),
      ...runs([{ variant: 'render720-proxy' }, { variant: 'render720-proxy' }, { variant: 'render720-proxy' }]),
    ]);
    expect(results.map((r) => `${r.device}/${r.variant}/${r.verdict}`)).toEqual([
      'iPhone14,5/render1080-source/go',
      'iPhone14,5/render720-proxy/go',
      'iPhone16,1/render1080-source/go',
    ]);
    expect(results[1]!.metrics).toEqual([]);
  });
});

describe('parseRows / toMarkdown', () => {
  it('round-trips JSONL and renders one table per device', () => {
    const jsonl = runs([{}, {}, {}]).map((r) => JSON.stringify(r)).join('\n') + '\n\n';
    const markdown = toMarkdown(evaluate(parseRows(jsonl)));
    expect(markdown).toContain('### iPhone14,5');
    expect(markdown).toContain('| S1 | render1080-source | 3 | go | fpsSustained 30 / 30 (>= 29.5)');
  });
});
