import { fontMetrics, type PlanCallout, type PlanCaption, type PlanFontFace, type PlanOverlay, type RenderPlan } from '@editify/shared';

/*
 * The ASS writer for plan captions and callout cards (RenderPlan captionLine
 * "ASS (P6 server writer)"). libass draws the plan's layout; it decides
 * nothing:
 *
 * - One Dialogue per plan line, `{\an7\pos(x, y - winAscent * sizePx / unitsPerEm)}`:
 *   the top-left of the line's cell, so the baseline lands on the plan's y.
 *   WrapStyle 2 (never wrap) and no `\N`: the plan already broke the lines.
 * - Fontsize = sizePx * (winAscent + winDescent) / unitsPerEm: libass treats
 *   Fontsize as the cell height (Montserrat Bold: x 1.562).
 * - Outline = strokePx, Shadow = offsetPx with BackColour at the shadow's
 *   opacity, BorderStyle 1. A plan `box` becomes a BorderStyle 3 event on a
 *   lower layer (square corners, and libass fills per line, so overlapping
 *   line boxes double: an accepted difference the schema names).
 * - Karaoke: every line's Dialogue starts at the caption's start, opens with an
 *   empty `{\k}` syllable up to its first word, then one `{\kN}` per word, so
 *   word i turns from SecondaryColour (color) to PrimaryColour (emphasisColor)
 *   at its absolute plan time s. Right-to-left and approximate lines are one
 *   word in the plan, so they are one syllable here.
 * - Times are snapped to the output frame grid before they become
 *   centiseconds: an event (or a word) starting at t is drawn from frame
 *   ceil(t * fps - 1e-6) on, the frame the native renderer first draws it on,
 *   and ASS's 10 ms resolution then cannot move it across a frame (fps <= 100).
 *
 * Callout cards are drawn here too, from the plan's primitives, on every
 * platform: the card as an ASS vector path (rounded corners as Bezier arcs),
 * the verdict glyph as a stroked polyline (libass strokes are round-capped and
 * round-joined, as the schema asks), the label in the bundled face. Rotation
 * is `\frz` about the box centre (ASS turns counter-clockwise, the plan
 * clockwise). Accepted differences: libass applies ligatures and has no colour
 * emoji.
 */

export const ASS_FONT_FAMILY: Readonly<Record<PlanFontFace, { family: string; bold: boolean }>> = {
  'Montserrat-Bold': { family: 'Montserrat', bold: true },
};

/** `#RRGGBB` or `#RRGGBBAA` with an extra opacity factor -> ASS `&HAABBGGRR` (ASS alpha is inverted). */
export function assColour(hex: string, opacity = 1): string {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i.exec(hex);
  if (!match) return '&H00FFFFFF';
  const alpha = (match[4] ? Number.parseInt(match[4], 16) / 255 : 1) * opacity;
  const inverted = Math.max(0, Math.min(255, Math.round(255 - alpha * 255)));
  return `&H${inverted.toString(16).padStart(2, '0')}${match[3]}${match[2]}${match[1]}`.toUpperCase();
}

/** Inline `\c` takes `&HBBGGRR&`; inline alpha `\1a` takes `&HAA&`. */
function inlineColour(hex: string): string {
  return `&H${assColour(hex).slice(4)}&`;
}
function inlineAlpha(hex: string, opacity = 1): string {
  return `&H${assColour(hex, opacity).slice(2, 4)}&`;
}

function assText(text: string): string {
  // Plan text never carries a line break (lines are pre-broken); a stray one must not become \N.
  return text.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}').replace(/\r?\n/g, ' ');
}

/** A number for an override tag: three decimals, no trailing zeros. */
function n(value: number): string {
  return String(Math.round(value * 1000) / 1000 + 0);
}

/** Centiseconds of the first output frame at or after `t` (see the frame snapping note above). */
export function frameSnappedCs(t: number, fps: number): number {
  const frame = Math.max(0, Math.ceil(t * fps - 1e-6));
  return Math.floor((frame * 100) / fps + 1e-9);
}

export function formatCs(totalCentiseconds: number): string {
  const cs = Math.max(0, Math.round(totalCentiseconds));
  const hours = Math.floor(cs / 360000);
  const minutes = Math.floor((cs % 360000) / 6000);
  const secs = Math.floor((cs % 6000) / 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** ASS Fontsize (the cell height) for a Core Text size in pixels. */
export function assFontSize(face: PlanFontFace, sizePx: number): number {
  const metrics = fontMetrics(face);
  return (sizePx * (metrics.winAscent + metrics.winDescent)) / metrics.unitsPerEm;
}

/** Top of the line's cell for a baseline at `y`. */
export function cellTop(face: PlanFontFace, sizePx: number, y: number): number {
  const metrics = fontMetrics(face);
  return y - (metrics.winAscent * sizePx) / metrics.unitsPerEm;
}

const STYLE_FORMAT = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';

interface Style {
  name: string;
  face: PlanFontFace;
  size: number;
  primary: string;
  secondary: string;
  outline: string;
  back: string;
  borderStyle: 1 | 3;
  outlineWidth: number;
  shadow: number;
}

function styleLine(style: Style): string {
  const font = ASS_FONT_FAMILY[style.face];
  return `Style: ${style.name},${font.family},${n(style.size)},${style.primary},${style.secondary},${style.outline},${style.back},${font.bold ? -1 : 0},0,0,0,100,100,0,0,${style.borderStyle},${n(style.outlineWidth)},${n(style.shadow)},7,0,0,0,1`;
}

function captionStyles(caption: PlanCaption, index: number): Style[] {
  const karaoke = caption.lines.some((line) => line.words);
  const size = assFontSize(caption.font, caption.sizePx);
  const styles: Style[] = [{
    name: `Caption${index}`,
    face: caption.font,
    size,
    // Karaoke paints SecondaryColour before a syllable is reached and PrimaryColour after.
    primary: assColour(karaoke ? caption.emphasisColor : caption.color),
    secondary: assColour(karaoke ? caption.color : caption.emphasisColor),
    outline: assColour(caption.strokeColor),
    back: caption.shadow ? assColour(caption.shadow.color, caption.shadow.opacity) : '&HFF000000',
    borderStyle: 1,
    outlineWidth: caption.strokePx,
    shadow: caption.shadow?.offsetPx ?? 0,
  }];
  if (caption.box) {
    styles.push({
      name: `CaptionBox${index}`,
      face: caption.font,
      size,
      primary: '&HFF000000',
      secondary: '&HFF000000',
      outline: assColour(caption.box.color, caption.box.opacity),
      back: '&HFF000000',
      borderStyle: 3,
      outlineWidth: caption.box.padPx,
      shadow: 0,
    });
  }
  return styles;
}

/** The karaoke text of one line: a lead-in syllable to the first word, then one syllable per word. */
export function karaokeLineText(caption: PlanCaption, words: NonNullable<PlanCaption['lines'][number]['words']>, fps: number): string {
  const eventCs = frameSnappedCs(caption.start, fps);
  // Absolute start of each word's syllable, never before the previous one.
  const starts: number[] = [];
  for (const word of words) starts.push(Math.max(starts.at(-1) ?? eventCs, frameSnappedCs(word.s, fps)));
  const lastEnd = Math.max(starts.at(-1)!, frameSnappedCs(words.at(-1)!.e, fps));
  const lead = starts[0]! - eventCs;
  // Each syllable runs to the next word's start (the last to its own end), so the \k sum lands every word on its time.
  const syllables = words.map((word, index) => {
    const duration = (index < words.length - 1 ? starts[index + 1]! : lastEnd) - starts[index]!;
    return `{\\k${duration}}${assText(word.w)}${index < words.length - 1 ? ' ' : ''}`;
  });
  return `${lead > 0 ? `{\\k${lead}}` : ''}${syllables.join('')}`;
}

/** Dialogue lines for one caption: one per plan line (plus its box on a lower layer). */
function captionDialogue(caption: PlanCaption, index: number, layer: number, fps: number): string[] {
  const start = formatCs(frameSnappedCs(caption.start, fps));
  const end = formatCs(frameSnappedCs(caption.end, fps));
  const out: string[] = [];
  for (const line of caption.lines) {
    const pos = `\\an7\\pos(${n(line.x)},${n(cellTop(caption.font, caption.sizePx, line.y))})`;
    if (caption.box) {
      out.push(`Dialogue: ${layer},${start},${end},CaptionBox${index},,0,0,0,,{${pos}}${assText(line.text)}`);
    }
    const text = line.words ? karaokeLineText(caption, line.words, fps) : assText(line.text);
    out.push(`Dialogue: ${layer + 1},${start},${end},Caption${index},,0,0,0,,{${pos}}${text}`);
  }
  return out;
}

/** Rounded rectangle path, w x h with corner radius r, origin top-left. */
function roundedRect(w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r === 0) return `m 0 0 l ${n(w)} 0 l ${n(w)} ${n(h)} l 0 ${n(h)}`;
  const k = r * (1 - 0.5523);
  return [
    `m ${n(r)} 0`,
    `l ${n(w - r)} 0`, `b ${n(w - k)} 0 ${n(w)} ${n(k)} ${n(w)} ${n(r)}`,
    `l ${n(w)} ${n(h - r)}`, `b ${n(w)} ${n(h - k)} ${n(w - k)} ${n(h)} ${n(w - r)} ${n(h)}`,
    `l ${n(r)} ${n(h)}`, `b ${n(k)} ${n(h)} 0 ${n(h - k)} 0 ${n(h - r)}`,
    `l 0 ${n(r)}`, `b 0 ${n(k)} ${n(k)} 0 ${n(r)} 0`,
  ].join(' ');
}

const GLYPH_STROKES: Record<'check' | 'cross', Array<Array<[number, number]>>> = {
  check: [[[0.05, 0.55], [0.38, 0.88], [0.95, 0.12]]],
  cross: [[[0.12, 0.12], [0.88, 0.88]], [[0.88, 0.12], [0.12, 0.88]]],
};

/** Dialogue lines that draw one callout overlay: card, glyph, label, in that order. */
function calloutDialogue(overlay: PlanOverlay & { callout: PlanCallout }, layer: number, fps: number): string[] {
  const { box, callout } = overlay;
  const start = formatCs(frameSnappedCs(overlay.start, fps));
  const end = formatCs(frameSnappedCs(overlay.end, fps));
  const left = box.x - box.w / 2;
  const top = box.y - box.h / 2;
  const turn = box.rotationDeg ? `\\org(${n(box.x)},${n(box.y)})\\frz${n(-box.rotationDeg)}` : '';
  const out: string[] = [];
  const card = callout.card;
  out.push(`Dialogue: ${layer},${start},${end},Draw,,0,0,0,,{\\an7\\pos(${n(left + card.x)},${n(top + card.y)})${turn}\\bord0\\shad0\\1c${inlineColour(card.color)}\\1a${inlineAlpha(card.color)}\\p1}${roundedRect(card.w, card.h, card.radiusPx)}{\\p0}`);
  if (callout.glyph) {
    const glyph = callout.glyph;
    const strokes = GLYPH_STROKES[glyph.shape].map((points) => points.map(([fx, fy]) => [glyph.x + fx * glyph.w, glyph.y + fy * glyph.h] as const));
    const all = strokes.flat();
    const minX = Math.min(...all.map(([x]) => x));
    const minY = Math.min(...all.map(([, y]) => y));
    // A zero-area contour traced out and back: libass strokes it as the polyline itself (round caps and joins).
    const path = strokes.map((points) => {
      const forward = points.map(([x, y]) => `${n(x - minX)} ${n(y - minY)}`);
      const back = forward.slice(0, -1).reverse();
      return `m ${forward[0]} l ${[...forward.slice(1), ...back].join(' l ')}`;
    }).join(' ');
    out.push(`Dialogue: ${layer + 1},${start},${end},Draw,,0,0,0,,{\\an7\\pos(${n(left + minX)},${n(top + minY)})${turn}\\bord${n(glyph.strokePx / 2)}\\shad0\\1a&HFF&\\3c${inlineColour(glyph.color)}\\3a&H00&\\p1}${path}{\\p0}`);
  }
  const label = callout.label;
  out.push(`Dialogue: ${layer + 2},${start},${end},Label,,0,0,0,,{\\an7\\pos(${n(left + label.x)},${n(top + cellTop(label.font, label.sizePx, label.y))})${turn}\\fs${n(assFontSize(label.font, label.sizePx))}\\bord0\\shad0\\1c${inlineColour(label.color)}}${assText(label.text)}`);
  return out;
}

export type AssItem =
  | { kind: 'caption'; caption: PlanCaption }
  | { kind: 'callout'; overlay: PlanOverlay & { callout: PlanCallout } };

/**
 * A complete ASS script drawing `items` in order (later items on higher
 * layers), at the plan's frame size and on its frame grid.
 */
export function planAss(plan: Pick<RenderPlan, 'size' | 'fps'>, items: readonly AssItem[]): string {
  const styles: Style[] = [];
  const events: string[] = [];
  let layer = 0;
  let captionIndex = 0;
  for (const item of items) {
    if (item.kind === 'caption') {
      styles.push(...captionStyles(item.caption, captionIndex));
      events.push(...captionDialogue(item.caption, captionIndex, layer, plan.fps));
      captionIndex += 1;
      layer += 2;
    } else {
      events.push(...calloutDialogue(item.overlay, layer, plan.fps));
      layer += 3;
    }
  }
  const drawStyle: Style = { name: 'Draw', face: 'Montserrat-Bold', size: 20, primary: '&H00FFFFFF', secondary: '&H00FFFFFF', outline: '&H00000000', back: '&HFF000000', borderStyle: 1, outlineWidth: 0, shadow: 0 };
  const labelStyle: Style = { ...drawStyle, name: 'Label' };
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'Kerning: yes',
    'YCbCr Matrix: None',
    `PlayResX: ${plan.size.w}`,
    `PlayResY: ${plan.size.h}`,
    '',
    '[V4+ Styles]',
    STYLE_FORMAT,
    ...[drawStyle, labelStyle, ...styles].map(styleLine),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/** First and one-past-last output frame of a [start, end) span. */
export function spanFrames(start: number, end: number, fps: number): [number, number] {
  return [Math.max(0, Math.ceil(start * fps - 1e-6)), Math.max(0, Math.ceil(end * fps - 1e-6))];
}
