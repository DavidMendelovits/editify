import { describe, expect, it } from 'vitest';
import { renderPlanSchema } from '@editify/shared';
import { LAB_ASSET_ID, LAB_PLAN_SECONDS, labPlanTarget, standupLabPlan, standupLabProject, type LabSource } from './standup-plan';

// IMG_0008: the 295 s 4K HLG stand-up set, stored landscape and turned upright by 90°.
const SOURCE: LabSource = { width: 3840, height: 2160, rotation: 90, duration: 295, hasAudio: true, color: 'hlg' };

describe('the lab stand-up cut', () => {
  it('is a valid 60 s plan with crossfades, a punch-in, karaoke captions and two stickers', () => {
    const plan = standupLabPlan(SOURCE, 'writer-60s-1080');
    expect(() => renderPlanSchema.parse(plan)).not.toThrow();
    expect(plan.duration).toBe(LAB_PLAN_SECONDS);
    expect(plan.fps).toBe(30);
    // Three crossfades: segments where two layers of the clip overlap.
    expect(plan.video.segments.filter((segment) => segment.layers.length === 2)).toHaveLength(3);
    const zoomed = plan.video.segments.flatMap((segment) => segment.layers).filter((layer) => layer.cropKeys.some((key) => key.scale > 1.2));
    expect(zoomed.length).toBeGreaterThan(0);
    expect(plan.captions).toHaveLength(20);
    expect(plan.captions.every((caption) => caption.lines.some((line) => (line.words?.length ?? 0) > 0))).toBe(true);
    expect(plan.overlays.filter((overlay) => overlay.kind === 'emoji')).toHaveLength(2);
    expect(plan.audio.every((entry) => entry.assetRef.id === LAB_ASSET_ID)).toBe(true);
    expect(plan.loudness.targetLufs).toBe(-16);
  });

  it('times the words of each karaoke block inside its 3 s slot, in order, on the plan timeline', () => {
    const plan = standupLabPlan(SOURCE, 'writer-60s-1080');
    plan.captions.forEach((caption, index) => {
      expect(caption.start).toBeCloseTo(index * 3, 6);
      const words = caption.lines.flatMap((line) => line.words ?? []);
      expect(words.length).toBeGreaterThanOrEqual(4);
      // The first word lights when the block appears (document times are relative to words[0].s).
      expect(words[0]!.s).toBeCloseTo(caption.start, 3);
      for (let i = 1; i < words.length; i += 1) expect(words[i]!.s).toBeGreaterThan(words[i - 1]!.s);
      expect(words.at(-1)!.e).toBeLessThanOrEqual(caption.end + 1e-6);
      expect(caption.end).toBeLessThanOrEqual((index + 1) * 3);
    });
  });

  it('builds the preview variants as the native preview does: kind preview, no loudness pass', () => {
    const preview = standupLabPlan(SOURCE, 'preview1080');
    expect(preview.size).toEqual({ w: 1080, h: 1920 });
    expect(preview.loudness.targetLufs).toBeNull();
    expect(standupLabPlan(SOURCE, 'render1080-plan').loudness.targetLufs).toBeNull();
    expect(standupLabPlan(SOURCE, 'writer-60s-1080').loudness.targetLufs).toBe(-16);
  });

  it('picks size and colour from the variant: 4K keeps an HDR source HDR, 1080 and preview are SDR', () => {
    expect(labPlanTarget('writer-60s-4k30', SOURCE)).toEqual({ size: { w: 2160, h: 3840 }, color: 'hlg' });
    expect(labPlanTarget('writer-60s-4k30', { color: 'sdr' })).toEqual({ size: { w: 2160, h: 3840 }, color: 'sdr' });
    expect(labPlanTarget('writer-60s-1080', SOURCE)).toEqual({ size: { w: 1080, h: 1920 }, color: 'sdr' });
    expect(labPlanTarget('preview1080', SOURCE)).toEqual({ size: { w: 1080, h: 1920 }, color: 'sdr' });
    const plan = standupLabPlan(SOURCE, 'writer-60s-4k30');
    expect(plan.size).toEqual({ w: 2160, h: 3840 });
    expect(plan.color).toBe('hlg');
  });

  it('refuses a clip too short for the cut', () => {
    expect(() => standupLabProject({ duration: 30 })).toThrow(/at least 76 s/);
  });
});
