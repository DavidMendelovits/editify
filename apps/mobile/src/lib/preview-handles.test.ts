import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fontMetrics, type OverlayPlacement, type RenderPlan } from '@editify/shared';
import {
  captionViewRect, dragPlacement, gripShape, HandleDrag, planFit, planToViewRect, viewToPlanPoint,
} from './preview-handles';

function fixture(name: string): RenderPlan {
  const path = decodeURIComponent(new URL(`../../../../packages/shared/fixtures/render-plans/${name}.json`, import.meta.url).pathname);
  return (JSON.parse(readFileSync(path, 'utf8')) as { plan: RenderPlan }).plan;
}

describe('planToViewRect', () => {
  it('fits the plan inside the view: one scale, letterbox or pillarbox offsets', () => {
    expect(planFit({ w: 1080, h: 1920 }, { width: 270, height: 480 })).toEqual({ scale: 0.25, offsetX: 0, offsetY: 0, width: 270, height: 480 });
    // A view wider than 9:16: bars left and right.
    expect(planFit({ w: 1080, h: 1920 }, { width: 330, height: 480 })).toEqual({ scale: 0.25, offsetX: 30, offsetY: 0, width: 270, height: 480 });
    // Taller: bars top and bottom.
    expect(planFit({ w: 1080, h: 1920 }, { width: 270, height: 520 })).toEqual({ scale: 0.25, offsetX: 0, offsetY: 20, width: 270, height: 480 });
    expect(planFit({ w: 1080, h: 1920 }, { width: 0, height: 480 }).scale).toBe(0);
  });

  it('maps a centre-anchored box to a view box, rotation untouched', () => {
    const box = { x: 540, y: 960, w: 400, h: 200, rotationDeg: -12 };
    expect(planToViewRect(box, { w: 1080, h: 1920 }, { width: 270, height: 480 })).toEqual({
      left: 85, top: 215, width: 100, height: 50, rotationDeg: -12, centerX: 135, centerY: 240,
    });
    // Pillarboxed and letterboxed: the same box, moved by the bars.
    expect(planToViewRect(box, { w: 1080, h: 1920 }, { width: 330, height: 480 })).toMatchObject({ left: 85 + 30, top: 215, width: 100, height: 50, centerX: 165 });
    expect(planToViewRect(box, { w: 1080, h: 1920 }, { width: 270, height: 520 })).toMatchObject({ left: 85, top: 215 + 20, width: 100, height: 50, centerY: 260 });
  });

  it('puts every handle on the box the renderer draws (6A)', () => {
    const plan = fixture('overlays');
    const view = { width: 180, height: 320 };
    for (const overlay of plan.overlays) {
      const rect = planToViewRect(overlay.box, plan.size, view);
      // The renderer turns the box clockwise about its centre at (x, y): so does RN, about the View's centre.
      expect(rect.left + rect.width / 2).toBeCloseTo(overlay.box.x / 2, 9);
      expect(rect.top + rect.height / 2).toBeCloseTo(overlay.box.y / 2, 9);
      expect(rect.width).toBeCloseTo(overlay.box.w / 2, 9);
      expect(rect.rotationDeg).toBe(overlay.box.rotationDeg);
      const back = viewToPlanPoint(rect.centerX, rect.centerY, plan.size, view);
      expect(back.x).toBeCloseTo(overlay.box.x, 9);
      expect(back.y).toBeCloseTo(overlay.box.y, 9);
    }
  });

  it('outlines a caption from its line cells', () => {
    const plan = fixture('caption-karaoke');
    const caption = plan.captions[0]!;
    const view = { width: 270, height: 480 };
    const rect = captionViewRect(caption, plan.size, view)!;
    const metrics = fontMetrics(caption.font);
    const k = 0.25;
    for (const line of caption.lines) {
      expect(rect.left).toBeLessThanOrEqual(line.x * k);
      expect(rect.left + rect.width).toBeGreaterThanOrEqual((line.x + line.width) * k);
    }
    expect(rect.top).toBeCloseTo((caption.lines[0]!.y - (caption.sizePx * metrics.winAscent) / metrics.unitsPerEm - caption.strokePx) * k, 6);
    expect(rect.top + rect.height).toBeCloseTo((caption.lines.at(-1)!.y + (caption.sizePx * metrics.winDescent) / metrics.unitsPerEm + caption.strokePx) * k, 6);
    expect(captionViewRect({ ...caption, lines: [] }, plan.size, view)).toBeUndefined();
  });
});

describe('placement math (the RN Sticker\'s)', () => {
  const stage = { width: 300, height: 600 };
  const start: OverlayPlacement = { x: 0.2, y: 0.3, width: 0.3, rotation: 0 };

  it('drags in frame fractions, clamped, with a centre magnet', () => {
    expect(dragPlacement(start, 30, 60, stage)).toEqual({ x: 0.3, y: 0.4, width: 0.3, rotation: 0 });
    expect(dragPlacement(start, -300, 0, stage).x).toBe(0);
    expect(dragPlacement(start, 92, 0, stage).x).toBe(0.5); // 0.507: inside the 0.03 magnet
  });

  it('sizes and turns from the corner grip', () => {
    const corner = start.width * stage.width / 2; // 45: the grip starts on (45, 45) from the centre
    expect(gripShape(start, corner, corner, stage).width).toBeCloseTo(0.6, 3);
    // Swinging the grip to straight below the centre turns the sticker 45 degrees clockwise.
    expect(gripShape(start, -corner, 0.414 * corner, stage).rotation).toBe(45);
    expect(gripShape(start, 1000, 1000, stage).width).toBe(0.9);
  });
});

describe('HandleDrag', () => {
  const stage = { width: 300, height: 600 };
  const start: OverlayPlacement = { x: 0.2, y: 0.3, width: 0.3, rotation: 0 };

  it('streams previews while moving and commits one set_overlay on release', () => {
    const previews: OverlayPlacement[] = [];
    const onCommit = vi.fn();
    const onEnd = vi.fn();
    const drag = new HandleDrag({ clipId: 'logo', start, stage, mode: 'move', onPreview: (p) => previews.push(p), onCommit, onEnd });
    drag.move(3, 0);
    drag.move(3, 0); // unchanged: no second preview
    drag.move(30, 60);
    drag.move(60, 120);
    expect(previews).toEqual([
      { ...start, x: 0.21 },
      { ...start, x: 0.3, y: 0.4 },
      { ...start, x: 0.4, y: 0.5 },
    ]);
    const ops = drag.release(60, 120);
    expect(ops).toEqual([{ type: 'set_overlay', params: { clipId: 'logo', overlay: { ...start, x: 0.4, y: 0.5 } } }]);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(ops);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(true);
    // The commit is painted before the drag lets go of the plan.
    expect(onCommit.mock.invocationCallOrder[0]!).toBeLessThan(onEnd.mock.invocationCallOrder[0]!);
    // A finished drag ignores late events.
    expect(drag.release(90, 0)).toBeUndefined();
    drag.move(90, 0);
    expect(previews).toHaveLength(3);
  });

  it('treats a release under the slop as a tap: nothing committed', () => {
    const onCommit = vi.fn();
    const drag = new HandleDrag({ clipId: 'logo', start, stage, mode: 'move', onPreview: () => undefined, onCommit });
    expect(drag.release(2, -2)).toBeUndefined();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits the grip\'s size and rotation, and nothing for a grip that ends where it began', () => {
    const onCommit = vi.fn();
    const grip = new HandleDrag({ clipId: 'logo', start, stage, mode: 'grip', onPreview: () => undefined, onCommit });
    grip.move(45, 45);
    expect(grip.release(45, 45)).toEqual([{ type: 'set_overlay', params: { clipId: 'logo', overlay: { ...start, width: 0.6 } } }]);
    const still = new HandleDrag({ clipId: 'logo', start, stage, mode: 'grip', onPreview: () => undefined, onCommit });
    expect(still.release(0, 0)).toBeUndefined();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('commits nothing when the gesture is taken away', () => {
    const onCommit = vi.fn();
    const onEnd = vi.fn();
    const drag = new HandleDrag({ clipId: 'logo', start, stage, mode: 'move', onPreview: () => undefined, onCommit, onEnd });
    drag.move(30, 30);
    drag.cancel();
    expect(drag.release(30, 30)).toBeUndefined();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(false);
  });
});
