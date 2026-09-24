import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '@editify/shared';
import { runProcess } from '../src/media/process.js';
import { parseLoudness, parseSilences, runRenderQa } from '../src/services/render-qa.js';

describe('render QA parsing', () => {
  it('reads the summary block, not the per-frame log', () => {
    const stderr = [
      '[Parsed_ebur128_0] t: 1.0  TARGET:-23 LUFS  M: -20.0 S: -20.0  I: -99.0 LUFS  LRA: 0 LU',
      '[Parsed_ebur128_0] Summary:',
      '  Integrated loudness:',
      '    I:         -24.3 LUFS',
      '  True peak:',
      '    Peak:       -3.2 dBFS',
    ].join('\n');
    expect(parseLoudness(stderr)).toEqual({ integrated: -24.3, truePeak: -3.2 });
    expect(parseLoudness('Summary:\n    I:         -inf LUFS\n    Peak:      -inf dBFS')).toEqual({ integrated: null, truePeak: null });
  });

  it('keeps only dead air inside the programme', () => {
    const stderr = [
      'silence_start: 0', 'silence_end: 1.2 | silence_duration: 1.2',
      'silence_start: 4.01', 'silence_end: 5.5 | silence_duration: 1.49',
      'silence_start: 6.2', 'silence_end: 6.6 | silence_duration: 0.4',
      'silence_start: 9.1', 'silence_end: 10 | silence_duration: 0.9',
    ].join('\n');
    expect(parseSilences(stderr, 10)).toEqual([{ start: 4.01, end: 5.5 }]);
  });
});

describe('render QA on a real master', () => {
  let directory: string;
  let master: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'editify-qa-'));
    master = join(directory, 'output.mp4');
    // 3s tone, 1.5s of nothing, 3s tone: quiet (about -30 LUFS) with dead air in the middle.
    await runProcess('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=180x320:r=30:d=7.5',
      '-f', 'lavfi', '-i', 'sine=f=300:d=3:sample_rate=48000',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.5',
      '-f', 'lavfi', '-i', 'sine=f=500:d=3:sample_rate=48000',
      '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1,volume=-27dB[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', master,
    ]);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('normalizes a quiet master to -16 LUFS, finds the gap, and writes a contact sheet', async () => {
    const project: Project = { id: 'p', title: 'QA', format: '9:16', fps: 30, duration: 7.5, version: 0, tracks: [] };
    const qa = await runRenderQa(master, project, { get: () => undefined }, 'normalize');
    expect(qa.normalized?.gainDb).toBeGreaterThan(8);
    expect(qa.loudnessLufs).not.toBeNull();
    expect(Math.abs((qa.loudnessLufs as number) + 16)).toBeLessThan(1);
    expect(qa.truePeakDb).toBeLessThanOrEqual(-1);
    expect(qa.deadAir).toHaveLength(1);
    expect(qa.deadAir[0]?.start).toBeCloseTo(3, 0);
    expect(qa.warnings.some((line) => line.includes('of silence at'))).toBe(true);
    expect(qa.contactSheet).toBe(true);
    expect(existsSync(join(directory, 'contact.jpg'))).toBe(true);
  }, 60_000);

  it('only reports when normalizing is off', async () => {
    const project: Project = { id: 'p', title: 'QA', format: '9:16', fps: 30, duration: 7.5, version: 0, tracks: [] };
    const qa = await runRenderQa(master, project, { get: () => undefined }, 'off');
    expect(qa.normalized).toBeNull();
  }, 60_000);
});
