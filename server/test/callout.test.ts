import { describe, expect, it } from 'vitest';
import { calloutCacheKey, calloutDrawSpec, srgbComponents } from '../src/media/callout.js';

describe('srgbComponents', () => {
  it('reads 6-digit hex as opaque', () => {
    expect(srgbComponents('#FFFFFF')).toEqual([1, 1, 1, 1]);
    expect(srgbComponents('#39D98A')).toEqual([0.2235, 0.851, 0.5412, 1]);
  });

  it('reads the alpha byte of an 8-digit hex', () => {
    const [, , , alpha] = srgbComponents('#14141BF2');
    expect(alpha).toBeCloseTo(242 / 255, 4);
  });

  it('falls back to white rather than emitting NaN components', () => {
    expect(srgbComponents('not a colour')).toEqual([1, 1, 1, 1]);
  });
});

describe('calloutDrawSpec', () => {
  it('picks the verdict glyph and accent per variant', () => {
    expect(calloutDrawSpec({ text: 'Yes', variant: 'check' }).glyph).toBe('✓');
    expect(calloutDrawSpec({ text: 'No', variant: 'x' }).glyph).toBe('✗');
    // 'card' is text only — no glyph, so the card draws no leading gap.
    expect(calloutDrawSpec({ text: 'Plain', variant: 'card' }).glyph).toBe('');
    expect(calloutDrawSpec({ text: 'Yes', variant: 'check' }).glyphColor).toEqual(srgbComponents('#39D98A'));
    expect(calloutDrawSpec({ text: 'No', variant: 'x' }).glyphColor).toEqual(srgbComponents('#FF5C70'));
  });

  it('lets the clip override the accent and the card background', () => {
    const spec = calloutDrawSpec({ text: 'Yes', variant: 'check', color: '#0000FF', bg: '#FF0000' });
    expect(spec.glyphColor).toEqual([0, 0, 1, 1]);
    expect(spec.bgColor).toEqual([1, 0, 0, 1]);
  });

  it('derives card metrics from the font size', () => {
    const spec = calloutDrawSpec({ text: 'Yes', variant: 'check' }, 100);
    expect(spec).toMatchObject({ fontPx: 100, padding: 60, radius: 45, gap: 35 });
  });
});

describe('calloutCacheKey', () => {
  it('is stable for the same request', () => {
    const request = { text: 'Do it this way', variant: 'check' as const };
    expect(calloutCacheKey(request)).toBe(calloutCacheKey({ ...request }));
  });

  it('separates every input that changes the drawing', () => {
    const base = { text: 'Do it this way', variant: 'check' as const };
    const keys = new Set([
      calloutCacheKey(base),
      calloutCacheKey({ ...base, text: 'Do it that way' }),
      calloutCacheKey({ ...base, variant: 'x' }),
      calloutCacheKey({ ...base, color: '#0000FF' }),
      calloutCacheKey({ ...base, bg: '#0000FF' }),
    ]);
    expect(keys.size).toBe(5);
  });
});
