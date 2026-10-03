import { describe, expect, it } from 'vitest';
import { normalizeFilter } from '../src/media/color.js';
import { hwDecodeArgs, proxyVideoFilter } from '../src/media/process.js';

describe('proxy encode', () => {
  it('scales to 540p before the HDR tonemap, never after', () => {
    // Regression: tonemapping full 4K frames in float RGB made a 5-minute HLG
    // clip's proxy take 212s on an M4 Max; scaling first is 3x faster in software.
    const normalize = normalizeFilter({ primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', range: 'tv' }, 'sdr');
    const chain = proxyVideoFilter(normalize);
    expect(chain.indexOf('scale=540:540')).toBe(0);
    expect(chain.indexOf('tonemap')).toBeGreaterThan(chain.indexOf('scale=540:540'));
    expect(chain.endsWith('range=tv')).toBe(true);
  });

  it('asks for hardware decode only where this ffmpeg has VideoToolbox', async () => {
    const args = await hwDecodeArgs();
    expect(args.length === 0 || (args[0] === '-hwaccel' && args[1] === 'videotoolbox')).toBe(true);
    if (process.platform !== 'darwin') expect(args).toEqual([]);
  });
});
