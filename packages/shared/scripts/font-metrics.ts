/*
 * Generates packages/shared/src/caption-font-metrics.ts from the bundled
 * caption font (plan decision OV7): the hhea box, advance widths and GPOS
 * kern pairs that caption-layout.ts measures with, so the TS layout and Core
 * Text agree without either side guessing.
 *
 *   npx tsx packages/shared/scripts/font-metrics.ts          # rewrite the module
 *   npx tsx packages/shared/scripts/font-metrics.ts --check  # fail if it is stale
 *
 * The TTF is parsed directly (no font library): `head`, `hhea`, `OS/2`, `hmtx`,
 * `cmap` (formats 4 and 12) and GPOS PairPos (formats 1 and 2, also behind
 * Extension lookups) for the `kern` feature of the `latn` script. Output is a
 * pure function of the font bytes, so re-running on the same font yields the
 * same file byte for byte; server/test/caption-layout.test.ts checks that.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FONT_PATH = resolve(here, '../../../server/fonts/Montserrat-Bold.ttf');
export const OUTPUT_PATH = resolve(here, '../src/caption-font-metrics.ts');

/**
 * Code points whose advances are tabled: everything the font maps in these
 * blocks (Basic Latin, Latin-1, Latin Extended-A/B, Greek, Cyrillic, General Punctuation,
 * currency, letterlike symbols). Anything else measures with the fallback.
 */
const WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x7e], [0xa0, 0x24f], [0x370, 0x3ff], [0x400, 0x52f], [0x2000, 0x206f], [0x20a0, 0x20bf], [0x2100, 0x214f],
];
/**
 * Pairs are tabled only between these (Basic Latin, Latin-1 letters, Russian Cyrillic, Latin
 * Extended-A, curly quotes, dashes, ellipsis): caption text. Pairs outside
 * measure unkerned.
 */
const KERN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x7e], [0xa1, 0x17f], [0x401, 0x45f], [0x2013, 0x2014], [0x2018, 0x201e], [0x2026, 0x2026],
];

interface Tables { [tag: string]: { offset: number; length: number } }

class Reader {
  constructor(readonly bytes: Uint8Array, private readonly view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)) {}
  u16(at: number): number { return this.view.getUint16(at); }
  i16(at: number): number { return this.view.getInt16(at); }
  u32(at: number): number { return this.view.getUint32(at); }
  tag(at: number): string { return String.fromCharCode(...this.bytes.subarray(at, at + 4)); }
}

function tables(font: Reader): Tables {
  const count = font.u16(4);
  const found: Tables = {};
  for (let index = 0; index < count; index += 1) {
    const record = 12 + 16 * index;
    found[font.tag(record)] = { offset: font.u32(record + 8), length: font.u32(record + 12) };
  }
  return found;
}

function table(all: Tables, tag: string): number {
  const entry = all[tag];
  if (!entry) throw new Error(`the font has no ${tag} table`);
  return entry.offset;
}

/** Unicode code point -> glyph id, from the best Unicode cmap subtable. */
function readCmap(font: Reader, cmap: number): Map<number, number> {
  const count = font.u16(cmap + 2);
  const candidates: Array<{ rank: number; offset: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const record = cmap + 4 + 8 * index;
    const platform = font.u16(record);
    const encoding = font.u16(record + 2);
    const offset = cmap + font.u32(record + 4);
    const format = font.u16(offset);
    const rank = format === 12 ? 2 : format === 4 && (platform === 0 || (platform === 3 && encoding === 1)) ? 1 : 0;
    if (rank > 0) candidates.push({ rank, offset });
  }
  const best = candidates.sort((left, right) => right.rank - left.rank)[0];
  if (!best) throw new Error('the font has no Unicode cmap');
  const map = new Map<number, number>();
  const at = best.offset;
  if (font.u16(at) === 12) {
    const groups = font.u32(at + 12);
    for (let index = 0; index < groups; index += 1) {
      const group = at + 16 + 12 * index;
      const first = font.u32(group);
      const last = font.u32(group + 4);
      const glyph = font.u32(group + 8);
      for (let code = first; code <= last; code += 1) map.set(code, glyph + code - first);
    }
    return map;
  }
  const segments = font.u16(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const rangeOffsets = deltas + 2 * segments;
  for (let segment = 0; segment < segments; segment += 1) {
    const start = font.u16(starts + 2 * segment);
    const end = font.u16(ends + 2 * segment);
    const delta = font.u16(deltas + 2 * segment);
    const rangeOffset = font.u16(rangeOffsets + 2 * segment);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const raw = font.u16(rangeOffsets + 2 * segment + rangeOffset + 2 * (code - start));
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(code, glyph);
    }
  }
  return map;
}

function readAdvances(font: Reader, all: Tables): number[] {
  const hhea = table(all, 'hhea');
  const metrics = font.u16(hhea + 34);
  const glyphs = font.u16(table(all, 'maxp') + 4);
  const hmtx = table(all, 'hmtx');
  const advances: number[] = [];
  for (let glyph = 0; glyph < glyphs; glyph += 1) {
    advances.push(font.u16(hmtx + 4 * Math.min(glyph, metrics - 1)));
  }
  return advances;
}

/** Coverage index of `glyph`, or -1. */
function coverageIndex(font: Reader, coverage: number, glyph: number): number {
  const format = font.u16(coverage);
  const count = font.u16(coverage + 2);
  if (format === 1) {
    for (let index = 0; index < count; index += 1) if (font.u16(coverage + 4 + 2 * index) === glyph) return index;
    return -1;
  }
  for (let index = 0; index < count; index += 1) {
    const record = coverage + 4 + 6 * index;
    const start = font.u16(record);
    const end = font.u16(record + 2);
    if (glyph >= start && glyph <= end) return font.u16(record + 4) + glyph - start;
  }
  return -1;
}

function classOf(font: Reader, classDef: number, glyph: number): number {
  const format = font.u16(classDef);
  if (format === 1) {
    const start = font.u16(classDef + 2);
    const count = font.u16(classDef + 4);
    return glyph >= start && glyph < start + count ? font.u16(classDef + 6 + 2 * (glyph - start)) : 0;
  }
  const count = font.u16(classDef + 2);
  for (let index = 0; index < count; index += 1) {
    const record = classDef + 4 + 6 * index;
    if (glyph >= font.u16(record) && glyph <= font.u16(record + 2)) return font.u16(record + 4);
  }
  return 0;
}

/** Bytes in a ValueRecord of this format: two per set bit. */
function valueSize(format: number): number {
  let size = 0;
  for (let bit = format; bit; bit >>= 1) size += (bit & 1) * 2;
  return size;
}

/** The record's horizontal advance change: XAdvance (bit 0x0004), 0 when the format has none. */
function xAdvance(font: Reader, record: number, format: number): number {
  if (!(format & 0x0004)) return 0;
  const before = valueSize(format & 0x0003);
  return font.i16(record + before);
}

/** PairPos subtable offsets of the `kern` lookups for `latn` (DFLT if absent), in lookup-list order. */
function kernSubtables(font: Reader, gpos: number): number[][] {
  const scripts = gpos + font.u16(gpos + 4);
  const features = gpos + font.u16(gpos + 6);
  const lookups = gpos + font.u16(gpos + 8);
  let langSys: number | undefined;
  for (const wanted of ['latn', 'DFLT']) {
    for (let index = 0; index < font.u16(scripts) && langSys === undefined; index += 1) {
      const record = scripts + 2 + 6 * index;
      if (font.tag(record) !== wanted) continue;
      const script = scripts + font.u16(record + 4);
      const defaultLangSys = font.u16(script);
      if (defaultLangSys) langSys = script + defaultLangSys;
    }
    if (langSys !== undefined) break;
  }
  if (langSys === undefined) return [];
  const lookupIndexes = new Set<number>();
  const featureCount = font.u16(langSys + 4);
  for (let index = 0; index < featureCount; index += 1) {
    const featureIndex = font.u16(langSys + 6 + 2 * index);
    const record = features + 2 + 6 * featureIndex;
    if (font.tag(record) !== 'kern') continue;
    const feature = features + font.u16(record + 4);
    for (let at = 0; at < font.u16(feature + 2); at += 1) lookupIndexes.add(font.u16(feature + 4 + 2 * at));
  }
  return [...lookupIndexes].sort((left, right) => left - right).map((lookupIndex) => {
    const lookup = lookups + font.u16(lookups + 2 + 2 * lookupIndex);
    const type = font.u16(lookup);
    const subtables: number[] = [];
    for (let index = 0; index < font.u16(lookup + 4); index += 1) {
      let subtable = lookup + font.u16(lookup + 6 + 2 * index);
      let subtype = type;
      if (type === 9) {
        subtype = font.u16(subtable + 2);
        subtable += font.u32(subtable + 4);
      }
      if (subtype === 2) subtables.push(subtable);
    }
    return subtables;
  });
}

/**
 * One lookup's adjustment for the pair: the first subtable that applies wins,
 * as in HarfBuzz and Core Text. Format 1 applies only when it lists the second
 * glyph; format 2 applies whenever the first glyph is covered.
 */
function lookupAdjustment(font: Reader, subtables: number[], first: number, second: number): number {
  for (const subtable of subtables) {
    const format = font.u16(subtable);
    const covered = coverageIndex(font, subtable + font.u16(subtable + 2), first);
    if (covered < 0) continue;
    const format1 = font.u16(subtable + 4);
    const format2 = font.u16(subtable + 6);
    if (format === 1) {
      const pairSet = subtable + font.u16(subtable + 10 + 2 * covered);
      const recordSize = 2 + valueSize(format1) + valueSize(format2);
      for (let index = 0; index < font.u16(pairSet); index += 1) {
        const record = pairSet + 2 + recordSize * index;
        if (font.u16(record) !== second) continue;
        return xAdvance(font, record + 2, format1) + xAdvance(font, record + 2 + valueSize(format1), format2);
      }
      continue;
    }
    if (format === 2) {
      const class1 = classOf(font, subtable + font.u16(subtable + 8), first);
      const class2 = classOf(font, subtable + font.u16(subtable + 10), second);
      const class1Count = font.u16(subtable + 12);
      const class2Count = font.u16(subtable + 14);
      if (class1 >= class1Count || class2 >= class2Count) continue;
      const recordSize = valueSize(format1) + valueSize(format2);
      const record = subtable + 16 + (class1 * class2Count + class2) * recordSize;
      return xAdvance(font, record, format1) + xAdvance(font, record + valueSize(format1), format2);
    }
  }
  return 0;
}

function inRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([from, to]) => code >= from && code <= to);
}

function hex(code: number): string {
  return code.toString(16);
}

export interface ParsedMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
  winAscent: number;
  winDescent: number;
  advances: Array<[number, number]>;
  kern: Array<[number, number, number]>;
}

export function parseFontMetrics(bytes: Uint8Array): ParsedMetrics {
  const font = new Reader(bytes);
  const all = tables(font);
  const head = table(all, 'head');
  const hhea = table(all, 'hhea');
  const cmap = readCmap(font, table(all, 'cmap'));
  const advances = readAdvances(font, all);
  const codes = [...cmap.keys()].filter((code) => inRanges(code, WIDTH_RANGES)).sort((left, right) => left - right);
  const lookups = all.GPOS ? kernSubtables(font, all.GPOS.offset) : [];
  const kernCodes = codes.filter((code) => inRanges(code, KERN_RANGES));
  const kern: Array<[number, number, number]> = [];
  for (const left of kernCodes) {
    for (const right of kernCodes) {
      const first = cmap.get(left)!;
      const second = cmap.get(right)!;
      const value = lookups.reduce((sum, subtables) => sum + lookupAdjustment(font, subtables, first, second), 0);
      if (value !== 0) kern.push([left, right, value]);
    }
  }
  return {
    unitsPerEm: font.u16(head + 18),
    ascender: font.i16(hhea + 4),
    // hhea stores the descender negative; the layout wants a distance.
    descender: -font.i16(hhea + 6),
    lineGap: font.i16(hhea + 8),
    winAscent: font.u16(table(all, 'OS/2') + 74),
    winDescent: font.u16(table(all, 'OS/2') + 76),
    advances: codes.map((code) => [code, advances[cmap.get(code)!] ?? 0]),
    kern,
  };
}

/** The module text: compact strings (hex code points, decimal font units) decoded once at import. */
export function buildMetricsModule(bytes: Uint8Array): string {
  const metrics = parseFontMetrics(bytes);
  const advanceRuns: string[] = [];
  // Consecutive code points share one entry: "start:adv,adv,adv".
  let run: { start: number; values: number[] } | undefined;
  for (const [code, advance] of metrics.advances) {
    if (run && code === run.start + run.values.length) {
      run.values.push(advance);
    } else {
      if (run) advanceRuns.push(`${hex(run.start)}:${run.values.join(',')}`);
      run = { start: code, values: [advance] };
    }
  }
  if (run) advanceRuns.push(`${hex(run.start)}:${run.values.join(',')}`);
  // Pairs compressed back into classes: code points whose rows (or columns)
  // of adjustments are identical share a class, as the font's own ClassDefs do.
  const value = new Map(metrics.kern.map(([left, right, units]) => [`${left},${right}`, units]));
  const lefts = [...new Set(metrics.kern.map(([left]) => left))].sort((a, b) => a - b);
  const rights = [...new Set(metrics.kern.map(([, right]) => right))].sort((a, b) => a - b);
  const group = (codes: number[], key: (code: number) => string): number[][] => {
    const classes = new Map<string, number[]>();
    for (const code of codes) classes.set(key(code), [...(classes.get(key(code)) ?? []), code]);
    return [...classes.values()];
  };
  const leftClasses = group(lefts, (left) => rights.map((right) => value.get(`${left},${right}`) ?? 0).join(','));
  const rightClasses = group(rights, (right) => lefts.map((left) => value.get(`${left},${right}`) ?? 0).join(','));
  const rows = leftClasses.map((leftClass) => rightClasses
    .map((rightClass) => value.get(`${leftClass[0]},${rightClass[0]}`) ?? 0)
    .map((units) => (units === 0 ? '' : String(units)))
    .join(','));
  const classList = (classes: number[][]): string[] => classes.map((codes) => codes.map(hex).join(','));
  const chunk = (items: string[], per: number): string[] => {
    const lines: string[] = [];
    for (let index = 0; index < items.length; index += per) lines.push(`  '${items.slice(index, index + per).join(';')}',`);
    return lines;
  };
  return [
    '// Generated by packages/shared/scripts/font-metrics.ts from server/fonts/Montserrat-Bold.ttf.',
    '// Do not edit by hand: re-run the script after changing the font.',
    '',
    'export interface RawFontMetrics {',
    '  unitsPerEm: number;',
    '  /** hhea ascender, font units above the baseline. */',
    '  ascender: number;',
    '  /** hhea descender as a positive distance below the baseline. */',
    '  descender: number;',
    '  lineGap: number;',
    '  /** OS/2 usWinAscent and usWinDescent: libass sizes a font so that their sum is the ASS Fontsize. */',
    '  winAscent: number;',
    '  winDescent: number;',
    '  /** Advance widths: "startHex:adv,adv,...", runs of consecutive code points, joined by ";". */',
    '  advances: string;',
    '  /** GPOS kern (latn) classes of left code points: hex code points joined by ",", classes by ";". */',
    '  kernLeft: string;',
    '  /** Classes of right code points, the same way. */',
    '  kernRight: string;',
    '  /** One row per left class, one font-unit adjustment per right class ("" is 0), rows joined by ";". */',
    '  kernMatrix: string;',
    '}',
    '',
    'export const MONTSERRAT_BOLD_RAW: RawFontMetrics = {',
    `  unitsPerEm: ${metrics.unitsPerEm},`,
    `  ascender: ${metrics.ascender},`,
    `  descender: ${metrics.descender},`,
    `  lineGap: ${metrics.lineGap},`,
    `  winAscent: ${metrics.winAscent},`,
    `  winDescent: ${metrics.winDescent},`,
    '  advances: [',
    ...chunk(advanceRuns, 4),
    "  ].join(';'),",
    '  kernLeft: [',
    ...chunk(classList(leftClasses), 4),
    "  ].join(';'),",
    '  kernRight: [',
    ...chunk(classList(rightClasses), 4),
    "  ].join(';'),",
    '  kernMatrix: [',
    ...chunk(rows, 1),
    "  ].join(';'),",
    '};',
    '',
  ].join('\n');
}

function main(): void {
  const text = buildMetricsModule(readFileSync(FONT_PATH));
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT_PATH, 'utf8');
    if (current !== text) {
      console.error(`${OUTPUT_PATH} is stale: run npx tsx packages/shared/scripts/font-metrics.ts`);
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUTPUT_PATH, text);
  console.log(`wrote ${join('packages/shared/src', 'caption-font-metrics.ts')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
