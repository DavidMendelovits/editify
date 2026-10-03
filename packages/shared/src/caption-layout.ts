import { MONTSERRAT_BOLD_RAW, type RawFontMetrics } from './caption-font-metrics.js';
import type { PlanFontFace } from './caption-fonts.js';

/*
 * Shared caption measurement and layout (plan decision OV7). The render plan
 * places every caption line with these numbers and the native renderer draws
 * them with Core Text, kerning on and ligatures off, without re-measuring; a
 * macOS CI corpus test holds the two to the same widths.
 *
 * Widths come from the bundled face's own tables (caption-font-metrics.ts,
 * generated from the TTF): advance widths plus GPOS `kern` pair adjustments.
 * Emoji are drawn by Apple Color Emoji through Core Text's font cascade, so
 * they measure from the emoji table below instead.
 */

/**
 * Apple Color Emoji, measured from /System/Library/Fonts/Apple Color Emoji.ttc
 * (macOS 27): unitsPerEm 800, every glyph advances 800 (1.0 em), hhea ascender
 * 800 and descender 250. Core Text agrees: "🔥" in a Montserrat run at 100 px
 * advances exactly 100 px, and "a🔥b" is a + b + 100. A whole emoji cluster
 * (skin tone, ZWJ family, flag, keycap) draws as one glyph of this width.
 */
export const EMOJI_ADVANCE_EM = 1;
export const EMOJI_ASCENT_EM = 1;
export const EMOJI_DESCENT_EM = 0.3125;
/**
 * Characters the face does not cover and that are not emoji (CJK, most other
 * scripts) fall back to a system face. 1 em is the CJK ideograph advance in
 * PingFang and Hiragino, the likeliest such text in a caption.
 */
export const FALLBACK_ADVANCE_EM = 1;

/** Text set in a face: everything in font units, ready to scale to pixels. */
export interface FontMetrics {
  face: PlanFontFace;
  unitsPerEm: number;
  /** hhea ascender, units above the baseline. */
  ascender: number;
  /** hhea descender as a positive distance. */
  descender: number;
  lineGap: number;
  winAscent: number;
  winDescent: number;
  /** Advance of a covered code point, in font units. */
  advance(code: number): number | undefined;
  /** GPOS kern adjustment between two code points, in font units (0 when unlisted). */
  kern(left: number, right: number): number;
}

const RAW: Readonly<Record<PlanFontFace, RawFontMetrics>> = { 'Montserrat-Bold': MONTSERRAT_BOLD_RAW };
const decoded = new Map<PlanFontFace, FontMetrics>();

function decode(face: PlanFontFace, raw: RawFontMetrics): FontMetrics {
  const advances = new Map<number, number>();
  for (const run of raw.advances.split(';')) {
    const [start, values] = run.split(':') as [string, string];
    const first = Number.parseInt(start, 16);
    values.split(',').forEach((value, index) => advances.set(first + index, Number(value)));
  }
  const classesOf = (list: string): Map<number, number> => {
    const classes = new Map<number, number>();
    list.split(';').forEach((codes, index) => {
      for (const code of codes.split(',')) classes.set(Number.parseInt(code, 16), index);
    });
    return classes;
  };
  const leftClass = classesOf(raw.kernLeft);
  const rightClass = classesOf(raw.kernRight);
  const matrix = raw.kernMatrix.split(';').map((row) => row.split(',').map((value) => (value === '' ? 0 : Number(value))));
  return {
    face,
    unitsPerEm: raw.unitsPerEm,
    ascender: raw.ascender,
    descender: raw.descender,
    lineGap: raw.lineGap,
    winAscent: raw.winAscent,
    winDescent: raw.winDescent,
    advance: (code) => advances.get(code),
    kern: (left, right) => {
      const row = leftClass.get(left);
      const column = rightClass.get(right);
      return row === undefined || column === undefined ? 0 : matrix[row]?.[column] ?? 0;
    },
  };
}

/** The face's metrics, decoded once. */
export function fontMetrics(face: PlanFontFace): FontMetrics {
  let metrics = decoded.get(face);
  if (!metrics) {
    metrics = decode(face, RAW[face]);
    decoded.set(face, metrics);
  }
  return metrics;
}

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}
function isSkinTone(code: number): boolean {
  return code >= 0x1f3fb && code <= 0x1f3ff;
}
function isTag(code: number): boolean {
  return code >= 0xe0020 && code <= 0xe007f;
}
/** Zero-width marks a cluster absorbs: variation selectors, combining marks, joiners. */
function isZeroWidth(code: number): boolean {
  return (code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f) || code === 0x200b
    || code === 0x200c || code === ZWJ || code === 0x2060 || code === 0xfeff || isTag(code);
}
/**
 * Unicode 16.0 Emoji_Presentation (what Node's Emoji_Presentation property escape gave
 * when this was written; a literal table because Hermes has no Unicode
 * property escapes). These draw as emoji with no VS16.
 */
const EMOJI_PRESENTATION: ReadonlyArray<readonly [number, number]> = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f1e6, 0x1f1ff], [0x1f201, 0x1f201], [0x1f21a, 0x1f21a], [0x1f22f, 0x1f22f], [0x1f232, 0x1f236],
  [0x1f238, 0x1f23a], [0x1f250, 0x1f251], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa89], [0x1fa8f, 0x1fac6], [0x1face, 0x1fadc],
  [0x1fadf, 0x1fae9], [0x1faf0, 0x1faf8],
];

function isEmojiPresentation(code: number): boolean {
  let low = 0;
  let high = EMOJI_PRESENTATION.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [from, to] = EMOJI_PRESENTATION[middle]!;
    if (code < from) high = middle - 1;
    else if (code > to) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * Pictographs with a text default (❤, ☺, ©, ™, ↔): emoji only when VS16
 * follows. Without it Core Text sets them in the face if it has them, or in a
 * text fallback face (measured here with the fallback width).
 */
function isPictographic(code: number): boolean {
  return (code >= 0x1f000 && code <= 0x1faff) || (code >= 0x2600 && code <= 0x27bf)
    || (code >= 0x2300 && code <= 0x23ff) || (code >= 0x2b00 && code <= 0x2bff)
    || (code >= 0x2190 && code <= 0x21ff) || (code >= 0x25a0 && code <= 0x25ff)
    || code === 0xa9 || code === 0xae || code === 0x203c || code === 0x2049 || code === 0x2122
    || code === 0x2139 || code === 0x24c2 || code === 0x3030 || code === 0x303d || code === 0x3297 || code === 0x3299;
}

/** One drawn unit: a face glyph (kerned with its neighbours), an emoji, or fallback text. */
type Cluster = { kind: 'glyph'; code: number } | { kind: 'emoji' } | { kind: 'fallback' } | { kind: 'zero' };

function clusters(text: string, metrics: FontMetrics): Cluster[] {
  const codes = Array.from(text, (char) => char.codePointAt(0)!);
  const out: Cluster[] = [];
  let index = 0;
  while (index < codes.length) {
    const code = codes[index]!;
    const next = codes[index + 1];
    // Keycaps: 0-9 # * then VS16 and U+20E3.
    if (((code >= 0x30 && code <= 0x39) || code === 0x23 || code === 0x2a)
      && (next === KEYCAP || (next === VS16 && codes[index + 2] === KEYCAP))) {
      out.push({ kind: 'emoji' });
      index += next === KEYCAP ? 2 : 3;
      continue;
    }
    if (isRegionalIndicator(code)) {
      out.push({ kind: 'emoji' });
      index += next !== undefined && isRegionalIndicator(next) ? 2 : 1;
      continue;
    }
    const covered = metrics.advance(code) !== undefined;
    if (isEmojiPresentation(code) || (isPictographic(code) && next === VS16)) {
      out.push({ kind: 'emoji' });
      index += 1;
      // Absorb modifiers, VS16, tags and ZWJ-joined pictographs into this one glyph.
      while (index < codes.length) {
        const follow = codes[index]!;
        if (isSkinTone(follow) || follow === VS16 || isTag(follow) || follow === KEYCAP) {
          index += 1;
        } else if (follow === ZWJ && index + 1 < codes.length) {
          index += 2;
        } else {
          break;
        }
      }
      continue;
    }
    if (isZeroWidth(code) || code === 0x0a || code === 0x0d) out.push({ kind: 'zero' });
    else if (covered) out.push({ kind: 'glyph', code });
    else out.push({ kind: 'fallback' });
    index += 1;
  }
  return out;
}

/**
 * Pen x where each cluster starts, plus the total advance, in font units.
 * Kerning applies between consecutive face glyphs (zero-width marks are
 * skipped over); emoji and fallback text break the kern chain, as a font
 * change does in Core Text.
 */
function advancesInUnits(text: string, metrics: FontMetrics): { starts: number[]; width: number } {
  const units = metrics.unitsPerEm;
  let pen = 0;
  let previous: number | undefined;
  const starts: number[] = [];
  for (const cluster of clusters(text, metrics)) {
    if (cluster.kind === 'glyph' && previous !== undefined) pen += metrics.kern(previous, cluster.code);
    starts.push(pen);
    if (cluster.kind === 'glyph') {
      pen += metrics.advance(cluster.code)!;
      previous = cluster.code;
    } else if (cluster.kind === 'emoji') {
      pen += EMOJI_ADVANCE_EM * units;
      previous = undefined;
    } else if (cluster.kind === 'fallback') {
      pen += FALLBACK_ADVANCE_EM * units;
      previous = undefined;
    }
  }
  return { starts, width: pen };
}

/** Advance width of `text` set on one line in `face` at `sizePx` (em), kerned, no ligatures. */
export function measureText(text: string, face: PlanFontFace, sizePx: number): number {
  const metrics = fontMetrics(face);
  return (advancesInUnits(text, metrics).width * sizePx) / metrics.unitsPerEm;
}

/** Emoji clusters and their run width in em, for sticker payloads drawn in Apple Color Emoji. */
export function measureEmojiRun(text: string, face: PlanFontFace): { emoji: number; widthEm: number } {
  const metrics = fontMetrics(face);
  const emoji = clusters(text, metrics).filter((cluster) => cluster.kind === 'emoji').length;
  return { emoji, widthEm: advancesInUnits(text, metrics).width / metrics.unitsPerEm };
}

export interface CaptionLayoutInput {
  /** Words to set, in order; a karaoke caption passes its words so each keeps its own x. */
  words: string[];
  /** Indexes into `words` that must start a new line (hard breaks from "\n"). */
  breaks?: ReadonlySet<number>;
  face: PlanFontFace;
  /** Styled font size, em in pixels, before any shrink. */
  sizePx: number;
  /** Widest a line may be, in pixels. */
  maxWidth: number;
  /** Most lines before the caption shrinks instead. */
  maxLines?: number;
}

export interface CaptionLayoutLine {
  text: string;
  /** Advance width of the line in pixels at the fitted size. */
  width: number;
  /** Each word's pen x from the line's start, in pixels at the fitted size. */
  words: Array<{ w: string; x: number }>;
}

export interface CaptionLayout {
  /** Fitted font size: sizePx x scale. */
  sizePx: number;
  scale: number;
  shrunk: boolean;
  lines: CaptionLayoutLine[];
  /** True only when even the smallest step overflows; the caption is still drawn, never cut. */
  overflow: boolean;
}

export const CAPTION_MAX_LINES = 3;
/** Shrink steps of 5%: scale = (20 - k) / 20, so every step is an exact, stable number. */
const SHRINK_STEPS = 20;
/** The smallest step tried; below it the caption draws at this size and reports overflow. */
const MIN_SCALE_STEP = 5;

/** Greedy wrap at one size: as many words per line as fit, a word wider than the line gets a line of its own. */
function wrap(input: CaptionLayoutInput, sizePx: number, metrics: FontMetrics): { lines: CaptionLayoutLine[]; fits: boolean } {
  const toPx = sizePx / metrics.unitsPerEm;
  const lines: string[][] = [];
  let fits = true;
  input.words.forEach((word, index) => {
    const current = lines.at(-1);
    if (!current || input.breaks?.has(index)) {
      lines.push([word]);
      return;
    }
    const candidate = [...current, word].join(' ');
    if (advancesInUnits(candidate, metrics).width * toPx <= input.maxWidth + 1e-9) current.push(word);
    else lines.push([word]);
  });
  const laidOut = lines.map((words) => {
    const text = words.join(' ');
    const { starts, width } = advancesInUnits(text, metrics);
    // Cluster index where each word starts: words are separated by exactly one space cluster.
    const positions: Array<{ w: string; x: number }> = [];
    let cluster = 0;
    for (const word of words) {
      positions.push({ w: word, x: (starts[cluster] ?? 0) * toPx });
      cluster += clusters(word, metrics).length + 1;
    }
    const widthPx = width * toPx;
    if (widthPx > input.maxWidth + 1e-9) fits = false;
    return { text, width: widthPx, words: positions };
  });
  if (laidOut.length > (input.maxLines ?? CAPTION_MAX_LINES)) fits = false;
  return { lines: laidOut, fits };
}

/**
 * Greedy wrap to `maxWidth`, at most `maxLines` lines. When the caption does
 * not fit at its size it shrinks in 5% steps until it does and says so
 * (`shrunk`, `scale`): the receipt the plan carries instead of an ellipsis.
 * Word order and text are never changed.
 */
export function layoutCaption(input: CaptionLayoutInput): CaptionLayout {
  const metrics = fontMetrics(input.face);
  const words = input.words.filter((word) => word.length > 0);
  const clean = { ...input, words };
  let last: { lines: CaptionLayoutLine[]; fits: boolean } | undefined;
  let scale = 1;
  for (let step = SHRINK_STEPS; step >= MIN_SCALE_STEP; step -= 1) {
    scale = step / SHRINK_STEPS;
    last = wrap(clean, input.sizePx * scale, metrics);
    if (last.fits) break;
  }
  return {
    sizePx: input.sizePx * scale,
    scale,
    shrunk: scale < 1,
    lines: last?.lines ?? [],
    overflow: !(last?.fits ?? true),
  };
}

/** Split caption text into words and the word indexes that start a hard line ("\n"). */
export function captionWords(text: string): { words: string[]; breaks: Set<number> } {
  const words: string[] = [];
  const breaks = new Set<number>();
  text.split(/\r?\n/).forEach((paragraph, index) => {
    const parts = paragraph.split(/\s+/).filter(Boolean);
    if (index > 0 && parts.length > 0 && words.length > 0) breaks.add(words.length);
    words.push(...parts);
  });
  return { words, breaks };
}
