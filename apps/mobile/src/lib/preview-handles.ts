/**
 * Geometry and gestures for the native preview's handles (plan P5, decision 6A). The
 * native view draws every pixel; React Native only lays selection boxes and grips over
 * it, placed from the plan's own overlay boxes and caption lines, so a handle sits
 * exactly on what the renderer drew. Pure: the component (PreviewHandles.tsx) feeds it
 * layout sizes and pan deltas.
 *
 *   plan box (output pixels, centre + size + clockwise rotation)
 *     ─▶ planToViewRect (the view aspect-fits the plan: one scale, letterbox offsets)
 *     ─▶ an RN box: left/top/width/height + rotate about its centre
 *
 *   drag ─▶ HandleDrag.move ─▶ placement (dragPlacement / gripShape) ─▶ onPreview
 *          (a parameter-only plan update: the overlay's box) ─▶ release ─▶ one set_overlay
 *
 * The placement math is the RN preview's Sticker (PreviewPlayer.tsx), kept identical so a
 * drag lands where it did; P7 retires that copy with the RN overlays.
 */
import { fontMetrics, type Operation, type OverlayPlacement, type PlanCaption, type PlanOverlay } from '@editify/shared';

export interface Size { width: number; height: number }

/** Where the plan's frame sits in a view that aspect-fits it. */
export interface PlanFit {
  /** View points per plan pixel. */
  scale: number;
  offsetX: number;
  offsetY: number;
  /** The frame's size in view points (the "stage" the gestures measure against). */
  width: number;
  height: number;
}

export function planFit(plan: { w: number; h: number }, view: Size): PlanFit {
  if (plan.w <= 0 || plan.h <= 0 || view.width <= 0 || view.height <= 0) return { scale: 0, offsetX: 0, offsetY: 0, width: 0, height: 0 };
  const scale = Math.min(view.width / plan.w, view.height / plan.h);
  const width = plan.w * scale;
  const height = plan.h * scale;
  return { scale, offsetX: (view.width - width) / 2, offsetY: (view.height - height) / 2, width, height };
}

/** A box for an RN View: unrotated left/top/size, turned `rotationDeg` clockwise about its centre (RN's default origin). */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
  rotationDeg: number;
  centerX: number;
  centerY: number;
}

/** An overlay box (centre, size, clockwise rotation, output pixels) in view points. */
export function planToViewRect(box: PlanOverlay['box'], plan: { w: number; h: number }, view: Size): ViewRect {
  const fit = planFit(plan, view);
  const centerX = fit.offsetX + box.x * fit.scale;
  const centerY = fit.offsetY + box.y * fit.scale;
  const width = box.w * fit.scale;
  const height = box.h * fit.scale;
  return { left: centerX - width / 2, top: centerY - height / 2, width, height, rotationDeg: box.rotationDeg, centerX, centerY };
}

/**
 * The cells a caption's lines occupy, in view points: from the first line's ascent to the
 * last line's descent (the face's win metrics, which is how far glyphs reach), across the
 * widest line, padded by the stroke.
 */
export function captionViewRect(caption: Pick<PlanCaption, 'font' | 'sizePx' | 'strokePx' | 'lines'>, plan: { w: number; h: number }, view: Size): ViewRect | undefined {
  if (caption.lines.length === 0) return undefined;
  const metrics = fontMetrics(caption.font);
  const ascent = (caption.sizePx * metrics.winAscent) / metrics.unitsPerEm;
  const descent = (caption.sizePx * metrics.winDescent) / metrics.unitsPerEm;
  const pad = caption.strokePx;
  const left = Math.min(...caption.lines.map((line) => line.x)) - pad;
  const right = Math.max(...caption.lines.map((line) => line.x + line.width)) + pad;
  const top = caption.lines[0]!.y - ascent - pad;
  const bottom = caption.lines[caption.lines.length - 1]!.y + descent + pad;
  return planToViewRect({ x: (left + right) / 2, y: (top + bottom) / 2, w: right - left, h: bottom - top, rotationDeg: 0 }, plan, view);
}

/** A point in the view to output pixels (inverse of planToViewRect's placement). */
export function viewToPlanPoint(x: number, y: number, plan: { w: number; h: number }, view: Size): { x: number; y: number } {
  const fit = planFit(plan, view);
  if (fit.scale === 0) return { x: 0, y: 0 };
  return { x: (x - fit.offsetX) / fit.scale, y: (y - fit.offsetY) / fit.scale };
}

// ─── Placement math (identical to PreviewPlayer's Sticker) ───

export const STICKER_SNAP = 0.03;
export const DEFAULT_PLACEMENT: OverlayPlacement = { x: 0.5, y: 0.35, width: 0.28, rotation: 0 };

/** Placement after a drag, clamped to the frame with a centre magnet. `stage` is the frame in view points. */
export function dragPlacement(placement: OverlayPlacement, dx: number, dy: number, stage: Size): OverlayPlacement {
  const x = Math.max(0, Math.min(1, placement.x + (stage.width > 0 ? dx / stage.width : 0)));
  const y = Math.max(0, Math.min(1, placement.y + (stage.height > 0 ? dy / stage.height : 0)));
  return {
    ...placement,
    x: Math.abs(x - 0.5) <= STICKER_SNAP ? 0.5 : Math.round(x * 1000) / 1000,
    y: Math.abs(y - 0.5) <= STICKER_SNAP ? 0.5 : Math.round(y * 1000) / 1000,
  };
}

/** Size and rotation from the corner grip's travel, relative to the centre. */
export function gripShape(placement: OverlayPlacement, dx: number, dy: number, stage: Size): { width: number; rotation: number } {
  if (stage.width <= 0) return { width: placement.width, rotation: placement.rotation };
  // The grip starts on the box corner, so the start vector is half the box.
  const x0 = placement.width * stage.width / 2;
  const y0 = x0;
  const from = Math.hypot(x0, y0);
  const to = Math.hypot(x0 + dx, y0 + dy);
  const turn = (Math.atan2(y0 + dy, x0 + dx) - Math.atan2(y0, x0)) * 180 / Math.PI;
  const width = Math.max(0.06, Math.min(0.9, placement.width * (from > 0 ? to / from : 1)));
  const rotation = ((Math.round(placement.rotation + turn) % 360) + 360) % 360;
  return { width: Math.round(width * 1000) / 1000, rotation: rotation > 180 ? rotation - 360 : rotation };
}

// ─── One drag, start to release ───

export interface HandleDragOptions {
  clipId: string;
  /** The placement when the finger went down. */
  start: OverlayPlacement;
  /** The frame in view points (planFit's width and height). */
  stage: Size;
  /** `move` drags the box; `grip` is the corner handle (size and rotation). */
  mode: 'move' | 'grip';
  /** Every move: the placement to preview (a parameter-only plan update). */
  onPreview: (placement: OverlayPlacement) => void;
  /** Release after a real change: the ops to commit (one set_overlay, as the RN Sticker sends). */
  onCommit: (ops: Operation[]) => void;
  /**
   * Release or cancel: the drag is over. `committed` says whether onCommit just ran (it runs
   * first, so the commit is painted before the preview stops overriding the plan).
   */
  onEnd?: (committed: boolean) => void;
}

/** Tap, not drag: under this many points of travel a release only selects. */
export const TAP_SLOP = 3;

export class HandleDrag {
  private last: OverlayPlacement;
  private done = false;

  constructor(private readonly options: HandleDragOptions) {
    this.last = options.start;
  }

  /** The placement for this much travel from the start. */
  placementAt(dx: number, dy: number): OverlayPlacement {
    const { start, stage, mode } = this.options;
    return mode === 'move' ? dragPlacement(start, dx, dy, stage) : { ...start, ...gripShape(start, dx, dy, stage) };
  }

  /** A pan update: previews the placement when it changed. Returns it. */
  move(dx: number, dy: number): OverlayPlacement {
    if (this.done) return this.last;
    const next = this.placementAt(dx, dy);
    if (!samePlacement(next, this.last)) {
      this.last = next;
      this.options.onPreview(next);
    }
    return next;
  }

  /** The finger lifted: commits one set_overlay when the placement changed (a tap commits nothing). */
  release(dx: number, dy: number): Operation[] | undefined {
    if (this.done) return undefined;
    this.done = true;
    const { start, clipId, mode } = this.options;
    const next = this.placementAt(dx, dy);
    const tapped = mode === 'move' && Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP;
    if (tapped || samePlacement(next, start)) {
      this.options.onEnd?.(false);
      return undefined;
    }
    const ops: Operation[] = [{ type: 'set_overlay', params: { clipId, overlay: next } }];
    this.options.onCommit(ops);
    this.options.onEnd?.(true);
    return ops;
  }

  /** The gesture was taken away: nothing is committed. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.options.onEnd?.(false);
  }
}

export function samePlacement(a: OverlayPlacement, b: OverlayPlacement): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.rotation === b.rotation;
}
