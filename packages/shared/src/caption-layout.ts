import { APPLE_COLOR_EMOJI } from './caption-emoji-metrics.js';
import { MONTSERRAT_BOLD_RAW, type RawFontMetrics } from './caption-font-metrics.js';
import type { PlanFontFace } from './caption-fonts.js';
import { PLAN_LIMITS } from './render-plan-schema.js';

/*
 * Shared caption measurement and layout (plan decision OV7). The render plan
 * places every caption line with these numbers and the native renderer draws
 * them with Core Text, kerning on and ligatures off, without re-measuring; a
 * macOS CI corpus test holds the two to the same widths.
 *
 * Widths come from the bundled face's own tables (caption-font-metrics.ts,
 * generated from the TTF): advance widths plus GPOS `kern` pair adjustments.
 * Emoji are drawn by Apple Color Emoji through Core Text's font cascade, so
 * they measure from caption-emoji-metrics.ts (generated from Core Text).
 * Text in scripts the face does not cover is drawn by a system fallback face
 * the layout cannot know, so it measures with a fallback width and the
 * result says it is approximate.
 */

/**
 * Apple Color Emoji in a caption run: every cluster (skin tone, ZWJ
 * sequence, flag, keycap) is one glyph advancing 1 em; ascent 1 em, descent
 * 0.3125 em. Measured with Core Text by scripts/emoji-metrics.ts.
 */
export const EMOJI_ADVANCE_EM: number = APPLE_COLOR_EMOJI.advanceEm;
export const EMOJI_ASCENT_EM: number = APPLE_COLOR_EMOJI.ascentEm;
export const EMOJI_DESCENT_EM: number = APPLE_COLOR_EMOJI.descentEm;
/** Fallback advance for Han, Kana and Hangul: the ideograph square of PingFang and Hiragino. */
export const FALLBACK_WIDE_EM = 1;
/** Fallback advance for any other uncovered character (Greek, Thai, Hebrew, Arabic...): a typical proportional letter. */
export const FALLBACK_ADVANCE_EM = 0.6;

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
    // Hebrew points, Arabic harakat, Thai vowel and tone marks: they sit on the letter before.
    || (code >= 0x591 && code <= 0x5c7) || (code >= 0x64b && code <= 0x65f) || code === 0x670
    || code === 0xe31 || (code >= 0xe34 && code <= 0xe3a) || (code >= 0xe47 && code <= 0xe4e)
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


/** Han, Kana, Hangul and fullwidth forms: square glyphs in every Apple fallback face. */
function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x11ff) || (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xa960 && code <= 0xa97f)
    || (code >= 0xac00 && code <= 0xd7ff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3ffff);
}

/** Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms. */
function isRightToLeft(code: number): boolean {
  return (code >= 0x0590 && code <= 0x08ff) || (code >= 0xfb1d && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff)
    || (code >= 0x10800 && code <= 0x10fff) || (code >= 0x1e800 && code <= 0x1efff);
}

/** One drawn unit: a face glyph (kerned with its neighbours), an emoji, fallback text, or nothing. */
type Cluster =
  | { kind: 'glyph'; code: number }
  | { kind: 'emoji' }
  | { kind: 'fallback'; em: number; rtl: boolean }
  | { kind: 'zero' };

const isEmojiBase = (code: number | undefined): boolean => code !== undefined && (isEmojiPresentation(code) || isPictographic(code));

function clusters(text: string, metrics: FontMetrics): Cluster[] {
  const codes = Array.from(text, (char) => char.codePointAt(0)!);
  const out: Cluster[] = [];
  let index = 0;
  while (index < codes.length) {
    const code = codes[index]!;
    const next = codes[index + 1];
    // Keycaps: 0-9 # * then (VS16) U+20E3.
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
    // Emoji presentation by default, or a text-default pictograph that VS16,
    // a skin tone or a ZWJ sequence ("☝🏽", "❤‍🔥") turns into emoji.
    if (isEmojiPresentation(code) || (isPictographic(code)
      && (next === VS16 || (next !== undefined && isSkinTone(next)) || (next === ZWJ && isEmojiBase(codes[index + 2]))))) {
      out.push({ kind: 'emoji' });
      index += 1;
      while (index < codes.length) {
        const follow = codes[index]!;
        if (isSkinTone(follow) || follow === VS16 || isTag(follow) || follow === KEYCAP) {
          index += 1;
        } else if (follow === ZWJ && isEmojiBase(codes[index + 1])) {
          // A ZWJ joins only when a pictograph follows it.
          index += 2;
        } else {
          break;
        }
      }
      continue;
    }
    if (isZeroWidth(code) || code === 0x0a || code === 0x0d) out.push({ kind: 'zero' });
    else if (metrics.advance(code) !== undefined) out.push({ kind: 'glyph', code });
    else out.push({ kind: 'fallback', em: isWide(code) ? FALLBACK_WIDE_EM : FALLBACK_ADVANCE_EM, rtl: isRightToLeft(code) });
    index += 1;
  }
  return out;
}

interface Measured {
  /** Pen x where each cluster starts, font units. */
  starts: number[];
  width: number;
  /** Some cluster measured with a fallback width. */
  approximate: boolean;
  /** Some cluster is right-to-left text. */
  rightToLeft: boolean;
}

/**
 * Pen positions and the total advance, in font units. Kerning applies between
 * consecutive face glyphs (zero-width marks are skipped over); emoji and
 * fallback text break the kern chain, as a font change does in Core Text.
 */
function advancesInUnits(text: string, metrics: FontMetrics, emojiOnly = false): Measured {
  const units = metrics.unitsPerEm;
  let pen = 0;
  let previous: number | undefined;
  let approximate = false;
  let rightToLeft = false;
  const starts: number[] = [];
  for (const cluster of clusters(text, metrics)) {
    // An emoji sticker run is set in Apple Color Emoji: its other characters fall back too.
    const drawn: Cluster = emojiOnly && cluster.kind === 'glyph'
      ? { kind: 'fallback', em: isWide(cluster.code) ? FALLBACK_WIDE_EM : FALLBACK_ADVANCE_EM, rtl: isRightToLeft(cluster.code) }
      : cluster;
    if (drawn.kind === 'glyph' && previous !== undefined) pen += metrics.kern(previous, drawn.code);
    starts.push(pen);
    if (drawn.kind === 'glyph') {
      pen += metrics.advance(drawn.code)!;
      previous = drawn.code;
    } else if (drawn.kind === 'emoji') {
      pen += EMOJI_ADVANCE_EM * units;
      previous = undefined;
    } else if (drawn.kind === 'fallback') {
      pen += drawn.em * units;
      approximate = true;
      rightToLeft ||= drawn.rtl;
      previous = undefined;
    }
  }
  return { starts, width: pen, approximate, rightToLeft };
}

/** Advance width of `text` set on one line in `face` at `sizePx` (em), kerned, no ligatures. */
export function measureText(text: string, face: PlanFontFace, sizePx: number): number {
  return measureTextDetailed(text, face, sizePx).width;
}

/** measureText, plus whether any of it measured with a fallback width or runs right to left. */
export function measureTextDetailed(text: string, face: PlanFontFace, sizePx: number): { width: number; approximate: boolean; rightToLeft: boolean } {
  const metrics = fontMetrics(face);
  const measured = advancesInUnits(text, metrics);
  return { width: (measured.width * sizePx) / metrics.unitsPerEm, approximate: measured.approximate, rightToLeft: measured.rightToLeft };
}

/**
 * An emoji sticker's run, set in Apple Color Emoji: emoji clusters at their
 * table advance, and every other character at the fallback width (the
 * sticker font has no letters, so Core Text cascades to a system face; such
 * text is approximate). `face` only supplies the cluster rules.
 */
export function measureEmojiRun(text: string, face: PlanFontFace): { emoji: number; widthEm: number; approximate: boolean } {
  const metrics = fontMetrics(face);
  const emoji = clusters(text, metrics).filter((cluster) => cluster.kind === 'emoji').length;
  const measured = advancesInUnits(text, metrics, true);
  return { emoji, widthEm: measured.width / metrics.unitsPerEm, approximate: measured.approximate };
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
  /** Most lines before the caption shrinks further and reports overflow. */
  maxLines?: number;
}

export interface CaptionLayoutWord {
  w: string;
  /** Pen x from the line's start, pixels at the fitted size. */
  x: number;
  /** Index of the input word this came from (a hard-broken long word gives several pieces). */
  index: number;
}

export interface CaptionLayoutLine {
  text: string;
  /** Advance width of the line in pixels at the fitted size. */
  width: number;
  words: CaptionLayoutWord[];
  approximate: boolean;
  rightToLeft: boolean;
}

export interface CaptionLayout {
  /** Fitted font size: sizePx x scale. */
  sizePx: number;
  scale: number;
  shrunk: boolean;
  lines: CaptionLayoutLine[];
  /** Did not fit maxLines even at the smallest normal step (see the schema's fitted.overflow). */
  overflow: boolean;
  /** Some text measured with a fallback width. */
  approximate: boolean;
}

export const CAPTION_MAX_LINES = 3;
/** Normal shrink steps of 5%: scale = (20 - k) / 20, so every step is an exact, stable number. */
const SHRINK_STEPS = 20;
const MIN_SCALE_STEP = 5;
/** Past 0.25 an overflowing caption keeps shrinking by 10% a step, down to this floor. */
const OVERFLOW_STEP = 0.9;
const OVERFLOW_FLOOR = 0.001;

interface Piece { w: string; index: number; breakBefore: boolean }

/** Words as layout pieces: empty ones dropped, any longer than PLAN_LIMITS.textChars hard-broken by code point. */
function pieces(input: CaptionLayoutInput): Piece[] {
  const out: Piece[] = [];
  input.words.forEach((word, index) => {
    if (word.trim().length === 0) return;
    const breakBefore = input.breaks?.has(index) ?? false;
    if (word.length <= PLAN_LIMITS.textChars) {
      out.push({ w: word, index, breakBefore });
      return;
    }
    let chunk = '';
    let first = true;
    for (const char of Array.from(word)) {
      if (chunk.length + char.length > PLAN_LIMITS.textChars) {
        out.push({ w: chunk, index, breakBefore: first ? breakBefore : true });
        first = false;
        chunk = '';
      }
      chunk += char;
    }
    if (chunk) out.push({ w: chunk, index, breakBefore: first ? breakBefore : true });
  });
  return out;
}

/**
 * Greedy wrap at one size and width limit: as many pieces per line as fit
 * the width and the schema's per-line caps; a piece wider than the line gets
 * a line of its own. Returns the pieces per line.
 */
function greedy(items: readonly Piece[], toPx: number, limit: number, metrics: FontMetrics): Piece[][] {
  const lines: Piece[][] = [];
  let text = '';
  for (const item of items) {
    const current = lines.at(-1);
    if (!current || item.breakBefore) {
      lines.push([item]);
      text = item.w;
      continue;
    }
    const candidate = `${text} ${item.w}`;
    if (candidate.length <= PLAN_LIMITS.textChars && current.length < PLAN_LIMITS.wordsPerLine
      && advancesInUnits(candidate, metrics).width * toPx <= limit + 1e-9) {
      current.push(item);
      text = candidate;
    } else {
      lines.push([item]);
      text = item.w;
    }
  }
  return lines;
}

function widthOf(line: readonly Piece[], toPx: number, metrics: FontMetrics): number {
  return advancesInUnits(line.map((item) => item.w).join(' '), metrics).width * toPx;
}

function fits(lines: Piece[][], toPx: number, maxWidth: number, maxLines: number, metrics: FontMetrics): boolean {
  return lines.length <= maxLines && lines.every((line) => widthOf(line, toPx, metrics) <= maxWidth + 1e-9);
}

/**
 * Balance: the narrowest width limit that still gives the greedy line count,
 * found by bisection, so the widest line is as narrow as it can be and the
 * lines come out even, close to libass WrapStyle 0 (which also evens lines but
 * prefers the top one wider; the two can break one word apart). A single
 * line, or a word wider than the limit, leaves the greedy lines as they are.
 */
function balance(items: readonly Piece[], lines: Piece[][], toPx: number, maxWidth: number, metrics: FontMetrics): Piece[][] {
  if (lines.length < 2) return lines;
  const widest = Math.max(...items.map((item) => advancesInUnits(item.w, metrics).width * toPx));
  if (widest > maxWidth) return lines;
  let low = widest;
  let high = maxWidth;
  let best = lines;
  for (let step = 0; step < 24 && high - low > 0.01; step += 1) {
    const middle = (low + high) / 2;
    const trial = greedy(items, toPx, middle, metrics);
    if (trial.length === lines.length) {
      best = trial;
      high = middle;
    } else {
      low = middle;
    }
  }
  return best;
}

function finish(lines: Piece[][], toPx: number, metrics: FontMetrics): CaptionLayoutLine[] {
  return lines.map((line) => {
    const text = line.map((item) => item.w).join(' ');
    const measured = advancesInUnits(text, metrics);
    // Pieces are separated by exactly one space cluster.
    const words: CaptionLayoutWord[] = [];
    let cluster = 0;
    for (const item of line) {
      words.push({ w: item.w, x: (measured.starts[cluster] ?? 0) * toPx, index: item.index });
      cluster += clusters(item.w, metrics).length + 1;
    }
    return { text, width: measured.width * toPx, words, approximate: measured.approximate, rightToLeft: measured.rightToLeft };
  });
}

const layoutCache = new Map<string, CaptionLayout>();
const LAYOUT_CACHE_SIZE = 256;

/**
 * Greedy wrap to `maxWidth`, at most `maxLines` lines, then balanced. When
 * the caption does not fit at its size it shrinks in 5% steps until it does
 * and says so (`shrunk`, `scale`): the receipt the plan carries instead of an
 * ellipsis. Past the 0.25 step it keeps shrinking toward the schema's caps
 * and sets `overflow`. Word order and text are never changed; only text past
 * PLAN_LIMITS.linesPerCaption lines at the smallest size is dropped.
 *
 * Results are memoized on the inputs (the plan rebuilds on every edit and
 * most captions do not change); treat them as read-only.
 */
export function layoutCaption(input: CaptionLayoutInput): CaptionLayout {
  const key = JSON.stringify([input.words, [...(input.breaks ?? [])].sort((a, b) => a - b), input.face, input.sizePx, input.maxWidth, input.maxLines ?? CAPTION_MAX_LINES]);
  const cached = layoutCache.get(key);
  if (cached) {
    layoutCache.delete(key);
    layoutCache.set(key, cached);
    return cached;
  }
  const result = computeLayout(input);
  layoutCache.set(key, result);
  if (layoutCache.size > LAYOUT_CACHE_SIZE) layoutCache.delete(layoutCache.keys().next().value!);
  return result;
}

function computeLayout(input: CaptionLayoutInput): CaptionLayout {
  const metrics = fontMetrics(input.face);
  const items = pieces(input);
  const maxLines = input.maxLines ?? CAPTION_MAX_LINES;
  const toPxAt = (scale: number): number => (input.sizePx * scale) / metrics.unitsPerEm;
  let chosen: { scale: number; lines: Piece[][]; overflow: boolean } | undefined;
  for (let step = SHRINK_STEPS; step >= MIN_SCALE_STEP && !chosen; step -= 1) {
    const scale = step / SHRINK_STEPS;
    const lines = greedy(items, toPxAt(scale), input.maxWidth, metrics);
    if (fits(lines, toPxAt(scale), input.maxWidth, maxLines, metrics)) chosen = { scale, lines, overflow: false };
  }
  if (!chosen) {
    let scale = MIN_SCALE_STEP / SHRINK_STEPS;
    let lines: Piece[][] = [];
    do {
      scale = Math.max(OVERFLOW_FLOOR, Math.round(scale * OVERFLOW_STEP * 1e6) / 1e6);
      lines = greedy(items, toPxAt(scale), input.maxWidth, metrics);
    } while (!fits(lines, toPxAt(scale), input.maxWidth, PLAN_LIMITS.linesPerCaption, metrics) && scale > OVERFLOW_FLOOR);
    chosen = { scale, lines: lines.slice(0, PLAN_LIMITS.linesPerCaption), overflow: true };
  }
  const toPx = toPxAt(chosen.scale);
  const balanced = chosen.overflow ? chosen.lines : balance(items, chosen.lines, toPx, input.maxWidth, metrics);
  const lines = finish(balanced, toPx, metrics);
  return {
    sizePx: input.sizePx * chosen.scale,
    scale: chosen.scale,
    shrunk: chosen.scale < 1,
    lines,
    overflow: chosen.overflow,
    approximate: lines.some((line) => line.approximate),
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
