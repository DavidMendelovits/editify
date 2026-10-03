import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PLAN_LOUDNESS, type PlanLoudness, type RenderPlan } from '@editify/shared';
import { loudnessFilters, planLoudnessGain } from '../src/media/plan/audio.js';

/*
 * RenderPlan loudness: render-qa's gain rule (one gain toward -16 LUFS outside
 * a 0.5 LU deadband, none below -60 LUFS) with the limiter ALWAYS on while
 * targetLufs is set. Legacy render-qa limited only when it applied gain, so
 * a hot mix inside the deadband left legacy with its peaks: the plan render
 * limits it (intended, schema `loudness`).
 */
const LOUDNESS: PlanLoudness = { ...PLAN_LOUDNESS };

describe('planLoudnessGain', () => {
  it('applies one gain, rounded to 0.1 dB, outside the deadband, and limits', () => {
    expect(planLoudnessGain(LOUDNESS, -20.04)).toEqual({ gainDb: 4, limit: true });
    expect(planLoudnessGain(LOUDNESS, -12.26)).toEqual({ gainDb: -3.7, limit: true });
  });

  it('applies no gain inside the deadband but still limits', () => {
    expect(planLoudnessGain(LOUDNESS, -16.5)).toEqual({ gainDb: 0, limit: true, reason: 'deadband' });
    expect(planLoudnessGain(LOUDNESS, -15.6)).toEqual({ gainDb: 0, limit: true, reason: 'deadband' });
  });

  it('applies no gain to a silent master (or one not measured) but still limits', () => {
    expect(planLoudnessGain(LOUDNESS, -60)).toEqual({ gainDb: 0, limit: true, reason: 'silent' });
    expect(planLoudnessGain(LOUDNESS, null)).toEqual({ gainDb: 0, limit: true, reason: 'silent' });
  });

  it('turns everything off with targetLufs null', () => {
    expect(planLoudnessGain({ ...LOUDNESS, targetLufs: null }, -10)).toEqual({ gainDb: 0, limit: false, reason: 'off' });
    expect(loudnessFilters({ ...LOUDNESS, targetLufs: null }, { gainDb: 0, limit: false })).toEqual([]);
  });

  it('limits at limiterCeilingDb with its latency compensated, after the gain', () => {
    expect(loudnessFilters(LOUDNESS, { gainDb: -3.7, limit: true })).toEqual([
      'volume=-3.7dB',
      'alimiter=limit=0.841395:level=disabled:latency=1',
    ]);
  });
});

const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '';
const usable = ['zscale', 'lut1d', 'alimiter', 'subtitles', 'maskedmerge'].every((name) => new RegExp(`\\s${name}\\s`).test(filters));

describe.skipIf(!usable)('plan render loudness on a real master', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'editify-plan-loudness-'));
  process.env.EDITIFY_DATA_DIR = scratch;
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const peakDb = (path: string): number => {
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 28 }).stdout;
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    return 20 * Math.log10(peak);
  };

  function plan(audio: RenderPlan['audio'], loudness: PlanLoudness = LOUDNESS): RenderPlan {
    return {
      version: 1, requires: [], revision: 1, buildSeq: 1, size: { w: 64, h: 64 }, fps: 30, duration: 6, color: 'sdr',
      background: '#0B0B0F', loudness, video: { segments: [{ start: 0, end: 6, layers: [] }] }, overlays: [], captions: [], audio,
    };
  }
  const entry = (id: string): RenderPlan['audio'][number] => ({
    id: 'hot', clipId: 'hot', assetRef: { id, kind: 'audio' }, at: 0, in: 0, out: 6, speed: 1,
    gainKeys: [{ t: 0, gain: 1 }], fadeIn: { duration: 0.008, curve: 'halfSine' }, fadeOut: { duration: 0.008, curve: 'halfSine' },
  });

  it('limits a hot mix that sits inside the deadband (legacy would have left its peaks)', async () => {
    const { measureLoudness } = await import('../src/services/render-qa.js');
    const { renderPlan } = await import('../src/media/plan/render.js');
    // A quiet tone with 1 ms full-scale bursts every half second: an 18 dB crest, so at -16 LUFS the bursts overshoot 0 dBFS.
    const raw = join(scratch, 'raw.wav');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      "aevalsrc='0.12*sin(2*PI*1000*t)+if(lt(mod(t,0.5),0.001),0.95*sin(2*PI*1000*t),0)':s=48000:d=6:c=stereo", '-c:a', 'pcm_f32le', raw]);
    const measured = (await measureLoudness(raw)).integrated!;
    const hot = join(scratch, 'hot.wav');
    // Scale the whole master so it measures -16.0 LUFS: in the deadband, so no gain.
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', `volume=${(-16 - measured).toFixed(3)}dB`, '-c:a', 'pcm_f32le', hot]);
    const before = await measureLoudness(hot);
    expect(Math.abs(before.integrated! + 16)).toBeLessThanOrEqual(0.3);
    expect(before.truePeak!).toBeGreaterThan(LOUDNESS.truePeakLimitDb);
    // Legacy's rule: no gain inside the deadband, and it limited only alongside a gain.
    expect(Math.abs(before.integrated! - (LOUDNESS.targetLufs ?? 0)) <= LOUDNESS.deadbandLu).toBe(true);

    const out = join(scratch, 'hot.mp4');
    const result = await renderPlan(plan([entry('hot')]), () => hot, { outputPath: out, workDir: join(scratch, 'hot') });
    expect(result.loudness.decision).toEqual({ gainDb: 0, limit: true, reason: 'deadband' });
    const after = await measureLoudness(out);
    expect(after.truePeak!).toBeLessThanOrEqual(LOUDNESS.truePeakLimitDb);
    expect(peakDb(out)).toBeLessThan(peakDb(hot) - 0.5);
    // Limiting the bursts barely moves the programme loudness.
    expect(Math.abs(after.integrated! + 16)).toBeLessThanOrEqual(0.5);
  }, 120000);

  it('leaves a master alone with targetLufs null (no gain, no limiter)', async () => {
    const { renderPlan } = await import('../src/media/plan/render.js');
    const hot = join(scratch, 'hot.wav');
    const out = join(scratch, 'off.mp4');
    const result = await renderPlan(plan([entry('hot')], { ...LOUDNESS, targetLufs: null }), () => hot, { outputPath: out, workDir: join(scratch, 'off') });
    expect(result.loudness.decision).toEqual({ gainDb: 0, limit: false, reason: 'off' });
    expect(peakDb(out)).toBeGreaterThan(LOUDNESS.limiterCeilingDb);
  }, 120000);

  it('applies no gain to a silent master', async () => {
    const { renderPlan } = await import('../src/media/plan/render.js');
    const result = await renderPlan(plan([]), () => undefined, { outputPath: join(scratch, 'silent.mp4'), workDir: join(scratch, 'silent') });
    expect(result.loudness.decision).toEqual({ gainDb: 0, limit: true, reason: 'silent' });
  }, 120000);

  it('routes a plan over the memory budget away before rendering anything (the queue then uses legacy)', async () => {
    const { renderPlan, planRenderMemoryMb, PlanRenderUnavailableError } = await import('../src/media/plan/render.js');
    const big = { ...plan([]), size: { w: 2160, h: 3840 } };
    expect(planRenderMemoryMb(big)).toBeGreaterThan(3072);
    expect(planRenderMemoryMb(plan([]))).toBeLessThan(100);
    const workDir = join(scratch, 'work-big');
    await expect(renderPlan(big, () => undefined, { outputPath: join(scratch, 'big.mp4'), workDir })).rejects.toBeInstanceOf(PlanRenderUnavailableError);
    expect(existsSync(join(scratch, 'big.mp4'))).toBe(false);
  });

  it('estimates memory from the stress measurements, graphics grouped as the final pass groups them', async () => {
    const { planRenderMemoryMb, planGraphics } = await import('../src/media/plan/render.js');
    const size = { w: 1080, h: 1920 };
    const box = { x: 100, y: 100, w: 100, h: 100, rotationDeg: 0 };
    const sticker = (z: number): RenderPlan['overlays'][number] => ({ id: `s${z}`, kind: 'image', z, start: 0, end: 2, box, media: { assetRef: { id: 'logo', kind: 'image' }, srcStart: 0, speed: 1 } });
    const callout = (z: number): RenderPlan['overlays'][number] => ({ id: `c${z}`, kind: 'callout', z, start: 0, end: 2, box } as RenderPlan['overlays'][number]);
    type Shape = Pick<RenderPlan, 'size' | 'color' | 'captions' | 'overlays'>;
    const stress = (count: number, color: RenderPlan['color'] = 'sdr'): Shape => ({ size, color, captions: [], overlays: [...Array.from({ length: count }, (_, z) => sticker(z)), callout(count)] });
    // Measured peaks (ffmpeg 9.0, 14 cores; the stress plan): no graphics 0.86 GB, 1 sticker + a callout 1.57 GB,
    // 30 stickers + a callout 1.93 GB; HLG no graphics 1.45 GB. The estimate stays above them, within ~25%.
    const cases: Array<[Shape, number]> = [
      [{ size, color: 'sdr', captions: [], overlays: [] }, 863],
      [stress(1), 1570],
      [stress(10), 1681],
      [stress(30), 1931],
      [{ size, color: 'hlg', captions: [], overlays: [] }, 1450],
      [stress(30, 'hlg'), 2381],
    ];
    for (const [plan, measured] of cases) {
      expect(planRenderMemoryMb(plan)).toBeGreaterThanOrEqual(measured);
      expect(planRenderMemoryMb(plan)).toBeLessThanOrEqual(measured * 1.25);
    }
    // Consecutive stickers share a canvas and consecutive callouts an ASS run; captions are one more run.
    expect(planGraphics({ captions: [], overlays: [sticker(0), sticker(1), callout(2), callout(3), sticker(4)] })).toEqual({ graphics: 3, stickers: 3 });
    expect(planGraphics({ captions: [{} as RenderPlan['captions'][number]], overlays: [] })).toEqual({ graphics: 1, stickers: 0 });
  });

  it('caps the encoders\' threads and lookahead (memory independent of the host\'s cores)', async () => {
    const { encoderArgs } = await import('../src/media/plan/color.js');
    const sdr = encoderArgs({ color: 'sdr' });
    expect(sdr.slice(sdr.indexOf('-threads:v'), sdr.indexOf('-threads:v') + 4)).toEqual(['-threads:v', '4', '-rc-lookahead', '20']);
    expect(encoderArgs({ color: 'hlg' }).find((arg) => arg.startsWith('colorprim='))).toContain(':pools=4:frame-threads=2');
  });

  it('cuts a zoom into crop-window chunks of at most 1.5x each', async () => {
    const { zoomChunks, ZOOM_CHUNK_RATIO } = await import('../src/media/plan/render.js');
    expect(ZOOM_CHUNK_RATIO).toBe(1.5);
    expect(zoomChunks([{ t: 0, v: 1 }, { t: 90, v: 1.15 }], 90)).toEqual([{ first: 0, end: 90, smallest: 1 }]);
    const chunks = zoomChunks([{ t: 0, v: 1 }, { t: 90, v: 3 }], 90);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.first).toBe(0);
    expect(chunks.at(-1)!.end).toBe(90);
    chunks.forEach((chunk, index) => {
      if (index > 0) expect(chunk.first).toBe(chunks[index - 1]!.end);
      expect(chunk.smallest).toBeCloseTo(1 + (2 * chunk.first) / 90, 9);
      expect((1 + (2 * (chunk.end - 1)) / 90) / chunk.smallest).toBeLessThanOrEqual(1.5 + 1e-9);
    });
  });

  it('removes its work directory after a render, and after a failed one', async () => {
    const { renderPlan } = await import('../src/media/plan/render.js');
    const workDir = join(scratch, 'work-ok');
    await renderPlan(plan([]), () => undefined, { outputPath: join(scratch, 'ok.mp4'), workDir });
    expect(existsSync(workDir)).toBe(false);
    expect(existsSync(join(scratch, 'ok.mp4'))).toBe(true);
    const failed = join(scratch, 'work-failed');
    // An asset the resolver will not hand over fails the render.
    await expect(renderPlan(plan([entry('not-mine')]), () => undefined, { outputPath: join(scratch, 'failed.mp4'), workDir: failed }))
      .rejects.toThrow('Asset not-mine is not available to this render');
    expect(existsSync(failed)).toBe(false);
  }, 120000);
});
