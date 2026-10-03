import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  captionWords,
  fontMetrics,
  layoutCaption,
  measureText,
  measureTextDetailed,
  planCaptionPlacements,
  type CaptionStyle,
  type Project,
} from '@editify/shared';
import { buildEmojiModule, EMOJI_OUTPUT_PATH, measureEmojiMetrics } from '../../packages/shared/scripts/emoji-metrics.js';
import { buildMetricsModule, FONT_PATH, OUTPUT_PATH } from '../../packages/shared/scripts/font-metrics.js';

/**
 * T3 of the on-device export plan (OV7): caption measurement from the bundled
 * face's own tables, so the TS layout and Core Text place the same glyphs.
 */
const FACE = 'Montserrat-Bold' as const;

describe('caption font metrics', () => {
  it('regenerates the committed metrics module byte for byte', () => {
    expect(buildMetricsModule(readFileSync(FONT_PATH))).toBe(readFileSync(OUTPUT_PATH, 'utf8'));
  });

  // Core Text exists only on macOS (and the iOS simulator, once CI has one there).
  it.runIf(process.platform === 'darwin')('regenerates the emoji metrics from Core Text', () => {
    expect(buildEmojiModule(measureEmojiMetrics())).toBe(readFileSync(EMOJI_OUTPUT_PATH, 'utf8'));
  }, 60_000);

  it('reads the face\'s vertical metrics', () => {
    const metrics = fontMetrics(FACE);
    expect(metrics).toMatchObject({ unitsPerEm: 1000, ascender: 968, descender: 251, lineGap: 0, winAscent: 1109, winDescent: 453 });
  });
});

describe('measureText', () => {
  it('applies GPOS kern pairs: "AV" is narrower than A plus V', () => {
    const a = measureText('A', FACE, 100);
    const v = measureText('V', FACE, 100);
    expect(measureText('AV', FACE, 100)).toBeLessThan(a + v);
    expect(fontMetrics(FACE).kern(0x41, 0x56)).toBe(-38);
  });

  /**
   * Widths Core Text gives for the same strings in Montserrat-Bold.ttf at
   * 100 px, ligatures off (CTLineGetTypographicBounds, macOS 27). The macOS CI
   * corpus test keeps this honest on every font change; these pin it here.
   */
  it.each([
    ['A', 76.6], ['AV', 147.4], ['To', 121.8], ['HELLO WORLD', 795.1], ['NOBODY TELLS YOU THIS', 1338.3],
    ['fi office', 393.2], ['office ffi ffl', 569.3], ['café naïve résumé', 956.3], ['¿Qué? ¡Sí! Ñandú', 883.6],
    ['Kerning Test: AVAWAYFaTeToVaWaYoLTLVLY', 2328.2], ['Wave, Tâche: «Yes» \u2014 “quoted” 1,234.56 $€', 2242.5],
    ['12:30pm \u2014 99% off', 969.1], ['©2024 Editify™', 801.9], ['P.S. J.R.R. "Hi"', 723.6], ['Привет мир', 649.9],
    ['Tiếng Việt rất đẹp', 935.9], ['Người ĐẸP Ở ĐÂU', 944.8], ['Nguyễn Thị Ánh', 842.4], ['← → ↑ ↓ ↔', 436.3], ['Next → Done', 642.7],
  ])('measures %j like Core Text', (text, coreText) => {
    expect(measureTextDetailed(text, FACE, 100)).toEqual({ width: expect.closeTo(coreText, 6), approximate: false, rightToLeft: false });
  });

  /**
   * Scripts the face does not cover: Core Text draws them in a system face,
   * so the layout can only estimate (fallback 0.6 em, 1 em for CJK) and says
   * so. These pin the size of the error, not exactness.
   */
  it.each([
    ['Γειά σου κόσμε', 748.21, 0.1], ['ΑΘΗΝΑ', 372.22, 0.25], ['สวัสดีครับ', 410.31, 0.1], ['ภาษาไทย ง่าย', 586.5, 0.1],
    ['日本語のテキスト', 794, 0.05], ['한국어', 259.5, 0.2], ['שלום עולם', 492.85, 0.1],
  ])('estimates %j and marks it approximate', (text, coreText, tolerance) => {
    const measured = measureTextDetailed(text, FACE, 100);
    expect(measured.approximate).toBe(true);
    expect(Math.abs(measured.width - coreText) / coreText).toBeLessThan(tolerance);
  });

  it('measures emoji as one 1 em Apple Color Emoji glyph per cluster', () => {
    expect(measureText('🔥', FACE, 100)).toBe(100);
    expect(measureText('👍🏽', FACE, 100)).toBe(100);
    expect(measureText('🇺🇸', FACE, 100)).toBe(100);
    expect(measureText('👨‍👩‍👧', FACE, 100)).toBe(100);
    expect(measureText('a🔥b', FACE, 100)).toBeCloseTo(230.7, 6);
    expect(measureText('#️⃣ 1️⃣', FACE, 100)).toBeCloseTo(228.3, 6);
    // ™ is in the face, so it stays text unless VS16 asks for emoji.
    expect(measureText('™️', FACE, 100)).toBe(100);
    expect(measureText('™', FACE, 100)).toBeCloseTo(104.6, 6);
    expect(measureText('❤️', FACE, 100)).toBe(100);
    expect(measureText('⌚', FACE, 100)).toBe(100);
    // A text-default pictograph turns emoji when a skin tone or a ZWJ sequence follows it.
    expect(measureText('☝🏽', FACE, 100)).toBe(100);
    expect(measureText('✌🏻', FACE, 100)).toBe(100);
    expect(measureText('❤‍🔥', FACE, 100)).toBe(100);
    // A ZWJ with no pictograph after it joins nothing.
    expect(measureText('🔥\u200dA', FACE, 100)).toBeCloseTo(100 + measureText('A', FACE, 100), 9);
    // Alone and without VS16, ❤ is text in a system face: approximate.
    expect(measureTextDetailed('❤', FACE, 100).approximate).toBe(true);
  });

  it('scales linearly with the size', () => {
    expect(measureText('HELLO WORLD', FACE, 50)).toBeCloseTo(397.55, 6);
  });
});

describe('layoutCaption', () => {
  const layout = (text: string, sizePx: number, maxWidth: number) => {
    const { words, breaks } = captionWords(text);
    return layoutCaption({ words, breaks, face: FACE, sizePx, maxWidth });
  };

  it('wraps greedily at stable points', () => {
    const result = layout('the quick brown fox jumps over the lazy dog', 64, 600);
    expect(result.lines.map((line) => line.text)).toEqual(['the quick brown', 'fox jumps over', 'the lazy dog']);
    expect(result).toMatchObject({ shrunk: false, scale: 1, sizePx: 64, overflow: false });
    for (const line of result.lines) {
      expect(line.width).toBeLessThanOrEqual(600);
      expect(line.width).toBeCloseTo(measureText(line.text, FACE, 64), 9);
    }
  });

  it('keeps each word\'s pen x, including the kern into it', () => {
    const [line] = layout('AV AV', 100, 2000).lines;
    expect(line!.words.map((word) => word.w)).toEqual(['AV', 'AV']);
    expect(line!.words[0]!.x).toBe(0);
    expect(line!.words[1]!.x).toBeCloseTo(measureText('AV ', FACE, 100) + (fontMetrics(FACE).kern(0x20, 0x41) / 10), 9);
  });

  it('balances lines to even widths at the greedy line count', () => {
    // Greedy alone would fill the first line and strand one word on the second.
    const text = 'WE SHOULD HAVE LEFT AN HOUR AGO';
    const greedyWidth = measureText('WE SHOULD HAVE LEFT AN HOUR', FACE, 64);
    const result = layout(text, 64, greedyWidth + 1);
    expect(result.lines.map((line) => line.text)).toEqual(['WE SHOULD HAVE', 'LEFT AN HOUR AGO']);
    expect(Math.max(...result.lines.map((line) => line.width))).toBeLessThan(greedyWidth);
  });

  it('memoizes a layout on its inputs', () => {
    expect(layout('same words twice', 64, 600)).toBe(layout('same words twice', 64, 600));
  });

  it('honours hard line breaks', () => {
    expect(layout('one\ntwo three', 64, 2000).lines.map((line) => line.text)).toEqual(['one', 'two three']);
  });

  it('shrinks in 5% steps past three lines and flags it, never dropping a word', () => {
    const text = 'NOBODY TELLS YOU THIS ABOUT RUNNING A MARATHON IN THE POURING RAIN WITH NO SHOES';
    const result = layout(text, 40, 280);
    expect(result.shrunk).toBe(true);
    expect(result.scale).toBeLessThan(1);
    expect(Math.round(result.scale * 20)).toBe(result.scale * 20);
    expect(result.sizePx).toBeCloseTo(40 * result.scale, 9);
    expect(result.lines.length).toBeLessThanOrEqual(3);
    expect(result.lines.map((line) => line.text).join(' ')).toBe(text);
    expect(result.lines.some((line) => line.text.includes('…'))).toBe(false);
    // One step larger would not have fitted.
    const larger = layoutCaption({ words: text.split(' '), face: FACE, sizePx: 40 * (result.scale + 0.05), maxWidth: 280, maxLines: 99 });
    expect(larger.lines.length > 3 || larger.lines.some((line) => line.width > 280)).toBe(true);
  });

  it('shrinks a single word wider than the line', () => {
    const result = layout('SUPERCALIFRAGILISTIC', 100, 600);
    expect(result.shrunk).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.width).toBeLessThanOrEqual(600);
  });
});

describe('safezone uses the shared measure', () => {
  function project(): Project {
    return {
      id: 'p', title: 'Placement', format: '9:16', fps: 30, duration: 10, version: 0,
      tracks: [{ id: 'video-main', kind: 'video', clips: [{ id: 'clip-a', assetId: 'a1', start: 0, in: 0, out: 10 }] }],
    };
  }
  const style: CaptionStyle = { font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'bottom', emphasis: 'bold', strokePx: 3 };

  it('sizes a bottom caption block from the real line count', () => {
    // At Fontsize 64 (a 41 px em) this wraps to two lines within 1000 px; the old 0.58 em estimate said three.
    const text = 'THIS CAPTION RUNS LONG ENOUGH THAT IT HAS TO WRAP AROUND';
    const { words } = captionWords(text);
    const lines = layoutCaption({ words, face: FACE, sizePx: 64 * 1000 / 1562, maxWidth: 1000 }).lines.length;
    expect(lines).toBe(2);
    const [placement] = planCaptionPlacements(project(), [{ id: 'c', start: 1, end: 3, text, style }], () => undefined);
    // Lifted into the Instagram band: bottom edge at 1920 - 420, centre half a block above
    // (one 64px cell per line, as the plan stacks lines, plus 3px stroke each side).
    expect(placement?.toPct).toBeCloseTo((1500 - (lines * 64 + 6) / 2) / 1920 * 100, 1);
  });
});
