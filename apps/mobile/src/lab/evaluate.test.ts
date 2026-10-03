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

  it('judges the analyzer pipeline (S11) on readiness and a real memo pair landing in sync', () => {
    const metrics = { readyRealtimeFactor: 9, wordsReady: true, laughterReady: true, facesReady: true, syncSelfCheck: false, syncLagErrorMs: 0.4 };
    const pipeline = { spike: 'S11' as const, variant: 'pipeline', metrics };
    expect(evaluate(runs([pipeline, pipeline, pipeline]))[0]!.verdict).toBe('go');
    const noModel = { ...pipeline, metrics: { ...metrics, wordsReady: false } };
    expect(evaluate(runs([noModel, noModel, pipeline]))[0]!.verdict).toBe('no-go');
    const selfCheck = { ...pipeline, metrics: { ...metrics, syncSelfCheck: true } };
    expect(evaluate(runs([selfCheck, selfCheck, selfCheck]))[0]!.verdict).toBe('no-go');
    const offBy3ms = { ...pipeline, metrics: { ...metrics, syncLagErrorMs: 3 } };
    expect(evaluate(runs([offBy3ms, offBy3ms, pipeline]))[0]!.verdict).toBe('no-go');
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
      spike: 'S4' as const, variant: 'writer-60s-4k30', metrics: { exportSeconds, tagsCorrect, fpsKept: true },
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
