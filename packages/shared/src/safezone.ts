import { faceAt, type FaceTrack } from './analysis.js';
import { clipTimelineDuration, type CaptionStyle, type Clip, type DeliveryPlatform, type Project } from './index.js';

/**
 * Caption placement: never on the speaker's face, always inside the posting
 * app's safe area, and as close to the caption's own anchor as those allow.
 * Adapted from kurbaitaev/ghost-editor scripts/lib/safezone.mjs (MIT).
 *
 * Platform chrome at 1080x1920, in pixels the app covers: measured guides for
 * Reels, TikTok and Shorts. `all` is the intersection of the three. Only the
 * vertical bands are enforced; captions are centred and full-width, so the
 * action-button column on the right is left to the caption margins.
 */
export const PLATFORM_SAFE_AREAS: Record<DeliveryPlatform, { top: number; bottom: number; name: string }> = {
  instagram: { top: 220, bottom: 420, name: 'Instagram Reels' },
  tiktok: { top: 160, bottom: 480, name: 'TikTok' },
  shorts: { top: 140, bottom: 380, name: 'YouTube Shorts' },
  all: { top: 220, bottom: 480, name: 'Reels + TikTok + Shorts' },
};

/** Clear space between a caption block and the face box, at 1920 tall. */
const FACE_GAP_PX = 36;
/** Face samples taken across a caption's lifetime. */
const SAMPLE_STEP_SEC = 0.1;
/** Consecutive captions this close in position share one, so they don't hop. */
const HOLD_FRACTION = 0.04;
/** ASS's default top/bottom margin, from ass.ts. */
const ASS_SAFE_MARGIN_PCT = 12;

export interface CaptionPlacement {
  clipId: string;
  /** Anchor the caption would have used, as percent of frame height. */
  fromPct: number;
  toPct: number;
  reason: 'kept' | 'below-face' | 'above-face' | 'safe-area' | 'no-room';
}

interface Frame { width: number; height: number }

/** Design-space canvas for a format; anchorPct is relative, so any size works. */
export function designFrame(format: Project['format']): Frame {
  if (format === '9:16') return { width: 1080, height: 1920 };
  if (format === '1:1') return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function lerp(from: number, to: number, p: number): number {
  return from + (to - from) * p;
}

/**
 * A source-normalized y (0 top, 1 bottom) mapped to screen pixels through the
 * same cover-scale, crop and zoompan geometry render.ts builds for this clip.
 */
export function sourceYToScreen(v: number, clip: Clip, t: number, source: Frame, frame: Frame): number {
  const { width: W, height: H } = frame;
  const from = clip.transform ?? { scale: 1, x: 0, y: 0 };
  if (!clip.transformEnd) {
    const scale = Math.max(1, from.scale);
    const cover = Math.max((W * scale) / source.width, (H * scale) / source.height);
    const scaledHeight = source.height * cover;
    const offset = ((scaledHeight - H) / 2) * (1 + from.y);
    return v * scaledHeight - offset;
  }
  const to = clip.transformEnd;
  const oversample = Math.min(2, Math.max(1, from.scale, to.scale));
  const overHeight = H * oversample;
  const cover = Math.max((W * oversample) / source.width, overHeight / source.height);
  const scaledHeight = source.height * cover;
  const yOver = v * scaledHeight - (scaledHeight - overHeight) / 2;
  const duration = Math.max(clipTimelineDuration(clip), 1e-6);
  const p = Math.min(1, Math.max(0, (t - clip.start) / duration));
  const zoom = lerp(Math.max(1, from.scale), Math.max(1, to.scale), p);
  const panY = lerp((1 + from.y) / 2, (1 + to.y) / 2, p);
  const windowHeight = overHeight / zoom;
  return (yOver - (overHeight - windowHeight) * panY) * (H / windowHeight);
}

/** The topmost video clip on screen at timeline second `t`: later tracks draw over earlier ones. */
function videoClipAt(project: Project, t: number): Clip | undefined {
  let found: Clip | undefined;
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of track.clips) {
      if (clip.assetId && t >= clip.start && t < clip.start + clipTimelineDuration(clip)) found = clip;
    }
  }
  return found;
}

/** The union of every face box on screen during [start, end), in screen pixels. */
function faceSpan(
  project: Project,
  start: number,
  end: number,
  faces: (assetId: string) => FaceTrack | undefined,
  frame: Frame,
): { top: number; bottom: number } | undefined {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const steps = Math.max(1, Math.ceil((end - start) / SAMPLE_STEP_SEC));
  for (let step = 0; step <= steps; step += 1) {
    const t = Math.min(end - 1e-3, start + step * SAMPLE_STEP_SEC);
    const clip = videoClipAt(project, t);
    const track = clip?.assetId ? faces(clip.assetId) : undefined;
    if (!clip || !track || !track.width || !track.height) continue;
    const box = faceAt(track, clip.in + (t - clip.start) * (clip.speed ?? 1));
    if (!box) continue;
    const source = { width: track.width, height: track.height };
    top = Math.min(top, sourceYToScreen(box.top, clip, t, source, frame));
    bottom = Math.max(bottom, sourceYToScreen(box.bottom, clip, t, source, frame));
  }
  if (!Number.isFinite(top)) return undefined;
  // A face pushed off screen by a punch-in cannot collide with anything.
  const clampedTop = Math.max(0, top);
  const clampedBottom = Math.min(frame.height, bottom);
  return clampedBottom > clampedTop ? { top: clampedTop, bottom: clampedBottom } : undefined;
}

/** Caption font size in pixels, the way ass.ts sizes it. */
function captionSize(style: CaptionStyle, frame: Frame): number {
  return Math.max(10, Math.round(style.sizePct !== undefined ? frame.height * style.sizePct / 100 : style.size * frame.width / 1080));
}

/**
 * Rendered block height, estimated: libass wraps at the frame width less the
 * 40px side margins, and Montserrat Bold averages ~0.58 em per character.
 */
function blockHeight(text: string, style: CaptionStyle, frame: Frame): number {
  const size = captionSize(style, frame);
  const wrapWidth = Math.max(1, frame.width - 80);
  const lines = text.split(/\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.length * 0.58 * size / wrapWidth)), 0);
  return lines * size * 1.15 + 2 * (style.strokePx ?? 3);
}

/** Where ass.ts would centre this caption, in pixels from the top. */
function desiredCenter(style: CaptionStyle, height: number, frame: Frame): number {
  if (style.anchorPct !== undefined) return frame.height * style.anchorPct / 100;
  const margin = frame.height * ASS_SAFE_MARGIN_PCT / 100;
  if (style.position === 'top') return margin + height / 2;
  if (style.position === 'center') return frame.height / 2;
  return frame.height - margin - height / 2;
}

function safeBand(project: Project, frame: Frame): { top: number; bottom: number } {
  if (project.format !== '9:16') return { top: frame.height * 0.05, bottom: frame.height * 0.95 };
  const area = PLATFORM_SAFE_AREAS[project.platform ?? 'instagram'];
  const scale = frame.height / 1920;
  return { top: area.top * scale, bottom: frame.height - area.bottom * scale };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface PlaceableCaption {
  id: string;
  start: number;
  end: number;
  text: string;
  style: CaptionStyle;
}

/** What ass.ts renders a caption with when the clip carries no style of its own. */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold' };

export function placeableCaption(clip: Clip, style: CaptionStyle = clip.style ?? DEFAULT_CAPTION_STYLE): PlaceableCaption | undefined {
  if (!clip.text) return undefined;
  const text = style.words?.length ? style.words.map((word) => word.w).join(' ') : clip.text;
  return { id: clip.id, start: clip.start, end: clip.start + clipTimelineDuration(clip), text, style };
}

/**
 * One anchor per caption. A caption whose own anchor already clears the face
 * and sits inside the safe band keeps it; otherwise it moves to the nearest
 * spot below the chin or above the head that fits, and when the face fills
 * the band it drops to the lowest safe spot, over the chest, never the eyes.
 */
export function planCaptionPlacements(
  project: Project,
  captions: PlaceableCaption[],
  faces: (assetId: string) => FaceTrack | undefined,
): CaptionPlacement[] {
  const frame = designFrame(project.format);
  const band = safeBand(project, frame);
  const gap = FACE_GAP_PX * frame.height / 1920;
  const placements: CaptionPlacement[] = [];
  let previous: { end: number; y: number } | undefined;
  for (const caption of [...captions].sort((left, right) => left.start - right.start)) {
    const height = blockHeight(caption.text, caption.style, frame);
    const half = height / 2;
    const desired = desiredCenter(caption.style, height, frame);
    const face = faceSpan(project, caption.start, caption.end, faces, frame);
    const fits = (y: number): boolean => y - half >= band.top - 0.5 && y + half <= band.bottom + 0.5
      && !(face && y + half > face.top - gap && y - half < face.bottom + gap);

    let y = desired;
    let reason: CaptionPlacement['reason'] = 'kept';
    if (!fits(desired)) {
      const candidates: Array<{ y: number; reason: CaptionPlacement['reason'] }> = [];
      const belowMin = Math.max(band.top, face ? face.bottom + gap : band.top) + half;
      const belowMax = band.bottom - half;
      if (belowMin <= belowMax) candidates.push({ y: clamp(desired, belowMin, belowMax), reason: face ? 'below-face' : 'safe-area' });
      if (face) {
        const aboveMin = band.top + half;
        const aboveMax = face.top - gap - half;
        if (aboveMin <= aboveMax) candidates.push({ y: clamp(desired, aboveMin, aboveMax), reason: 'above-face' });
      }
      // Ties go below the chin: that is where people read.
      const best = candidates.sort((left, right) => Math.abs(left.y - desired) - Math.abs(right.y - desired))[0];
      if (best) ({ y, reason } = best);
      else {
        y = Math.max(band.top + half, band.bottom - half);
        reason = 'no-room';
      }
    }
    // Hysteresis: a back-to-back caption that could sit where the last one did stays put.
    if (previous && caption.start - previous.end < 0.5 && Math.abs(previous.y - y) < frame.height * HOLD_FRACTION && fits(previous.y)) {
      y = previous.y;
    }
    previous = { end: caption.end, y };
    placements.push({
      clipId: caption.id,
      fromPct: round1(desired / frame.height * 100),
      toPct: round1(clamp(y / frame.height * 100, 0, 100)),
      reason,
    });
  }
  return placements;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
