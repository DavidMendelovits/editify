import { describe, expect, it } from 'vitest';
import type { Clip } from '@editify/shared';
import { duckExpression, duckWindows } from '../src/media/duck.js';

function clip(overrides: Partial<Clip> & { id: string }): Clip {
  return { assetId: 'asset', start: 0, in: 0, out: 2, ...overrides };
}

describe('duckWindows', () => {
  it('finds nothing when no clip ducks', () => {
    expect(duckWindows([clip({ id: 'a' }), clip({ id: 'b', start: 4 })])).toEqual([]);
  });

  it('spans the clip at its played length, not its source length', () => {
    expect(duckWindows([clip({ id: 'a', start: 1, in: 2, out: 6, speed: 2, duck: true })]))
      .toEqual([{ start: 1, end: 3 }]);
  });

  it('ignores clips that do not duck and sorts what is left', () => {
    expect(duckWindows([
      clip({ id: 'late', start: 10, duck: true }),
      clip({ id: 'music', start: 0, out: 30 }),
      clip({ id: 'early', start: 3, duck: true }),
    ])).toEqual([{ start: 3, end: 5 }, { start: 10, end: 12 }]);
  });

  it('merges overlapping and touching windows so the bed never bobs back up', () => {
    expect(duckWindows([
      clip({ id: 'overlapping', start: 0, out: 2, duck: true }),
      clip({ id: 'straddling', start: 1, out: 2, duck: true }),
      clip({ id: 'touching', start: 3, out: 2, duck: true }),
      clip({ id: 'apart', start: 7, out: 2, duck: true }),
    ])).toEqual([{ start: 0, end: 5 }, { start: 7, end: 9 }]);
  });
});

describe('duckExpression', () => {
  it('ramps to a 0.3 floor over 0.12s on each edge', () => {
    expect(duckExpression([{ start: 2, end: 5 }]))
      .toBe('1-0.7*clip((t-1.88)/0.12,0,1)*clip((5.12-t)/0.12,0,1)');
  });

  it('clamps the rising edge at zero so a head window emits no double minus', () => {
    expect(duckExpression([{ start: 0, end: 1 }])).not.toContain('--');
    expect(duckExpression([{ start: 0, end: 1 }])).toContain('(t-0)/0.12');
  });

  it('takes the deepest window with max() when several apply', () => {
    expect(duckExpression([{ start: 0, end: 1 }, { start: 4, end: 5 }])).toBe(
      '1-0.7*max(clip((t-0)/0.12,0,1)*clip((1.12-t)/0.12,0,1),'
      + 'clip((t-3.88)/0.12,0,1)*clip((5.12-t)/0.12,0,1))',
    );
  });
});
