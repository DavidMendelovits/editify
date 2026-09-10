import { describe, expect, it } from 'vitest';
import { isHdr, isWideGamut, normalizeFilter, outputColorArgs, outputColorFilter, type SourceColor } from '../src/media/color.js';

function color(overrides: Partial<SourceColor> = {}): SourceColor {
  return { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv', ...overrides };
}

const pq = color({ primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc' });

describe('normalizeFilter', () => {
  it('leaves a plain BT.709 source alone but for the pixel format', () => {
    expect(normalizeFilter(color(), 'sdr')).toBe('format=yuv420p');
  });

  it('says nothing about an unknown source either', () => {
    expect(normalizeFilter(color({ primaries: 'unknown', transfer: 'unknown', matrix: 'unknown', range: 'unknown' }), 'sdr'))
      .toBe('format=yuv420p');
  });

  it('maps full-range levels to limited, the common washed-out cast', () => {
    const filter = normalizeFilter(color({ range: 'pc' }), 'sdr');
    expect(filter).toContain('in_range=full:out_range=limited');
    expect(filter.endsWith('format=yuv420p')).toBe(true);
  });

  it('tone maps a PQ source when the target is SDR', () => {
    const filter = normalizeFilter(pq, 'sdr');
    expect(filter).toContain('tonemap=tonemap=hable');
    expect(filter).toContain('zscale=t=bt709:m=bt709:r=tv');
    expect(filter.endsWith('format=yuv420p')).toBe(true);
  });

  it('passes a PQ source through untouched when the target is HDR', () => {
    const filter = normalizeFilter(pq, 'hdr');
    expect(filter).not.toContain('tonemap');
    expect(filter).toBe('format=yuv420p10le');
  });

  it('still converts an SDR source when the target is HDR, there is nothing to keep', () => {
    expect(normalizeFilter(color(), 'hdr')).toBe('format=yuv420p');
  });

  it('converts a BT.2020 SDR gamut without tone mapping it', () => {
    const filter = normalizeFilter(color({ primaries: 'bt2020', matrix: 'bt2020nc' }), 'sdr');
    expect(filter).toContain('zscale=p=bt709');
    expect(filter).not.toContain('tonemap');
  });

  it('degrades to a plain format conversion on an ffmpeg without libzimg', () => {
    const filter = normalizeFilter(pq, 'sdr', { zscale: false });
    expect(filter).toBe('format=yuv420p');
    expect(filter).not.toContain('zscale');
  });
});

describe('isHdr / isWideGamut', () => {
  it('recognises PQ and HLG as HDR', () => {
    expect(isHdr(pq)).toBe(true);
    expect(isHdr(color({ transfer: 'arib-std-b67' }))).toBe(true);
    expect(isHdr(color())).toBe(false);
  });

  it('recognises P3 and BT.2020 as wide gamut', () => {
    expect(isWideGamut(color({ primaries: 'smpte432' }))).toBe(true);
    expect(isWideGamut(color({ matrix: 'bt2020c' }))).toBe(true);
    expect(isWideGamut(color())).toBe(false);
  });
});

describe('outputColorArgs', () => {
  it('tags an SDR export BT.709 all the way through', () => {
    expect(outputColorArgs('sdr', true)).toEqual([
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ]);
  });

  it('tags an HDR export BT.2020 PQ in 10-bit', () => {
    expect(outputColorArgs('hdr', true)).toEqual([
      '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-color_range', 'tv',
      '-profile:v', 'main10',
    ]);
  });

  it('falls back to BT.709 when an HDR export has no HDR source', () => {
    expect(outputColorArgs('hdr', false)).toContain('bt709');
  });
});

describe('outputColorFilter', () => {
  it('stamps BT.709 on the frames so ffmpeg 7 does not drop the tags', () => {
    expect(outputColorFilter('sdr', true)).toBe('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  });

  it('stamps BT.2020 PQ for a real HDR export', () => {
    expect(outputColorFilter('hdr', true)).toContain('color_trc=smpte2084');
  });
});
