import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fontMetrics, type PlanCallout, type PlanCaption, type PlanOverlay, type RenderPlan } from '@editify/shared';
import { assColour, assFontSize, cellTop, frameSnappedCs, karaokeLineText, planAss } from '../src/media/plan/ass.js';

/*
 * P6 ASS writer (RenderPlan captionLine "ASS (P6 server writer)"): the
 * generated script must say exactly what the plan says, line by line: one
 * Dialogue per plan line, \an7\pos at the top-left of the line's cell, the
 * Fontsize libass reads as the cell height, and karaoke \k sums that light
 * every word at its absolute plan time.
 */
const fixturesDir = fileURLToPath(new URL('../../packages/shared/fixtures/render-plans/', import.meta.url));
const fixture = (name: string): RenderPlan => (JSON.parse(readFileSync(`${fixturesDir}${name}.json`, 'utf8')) as { plan: RenderPlan }).plan;

interface Dialogue { layer: number; start: string; end: string; style: string; text: string }
function dialogues(script: string): Dialogue[] {
  return script.split('\n').filter((line) => line.startsWith('Dialogue: ')).map((line) => {
    const fields = line.slice('Dialogue: '.length).split(',');
    return { layer: Number(fields[0]), start: fields[1]!, end: fields[2]!, style: fields[3]!, text: fields.slice(9).join(',') };
  });
}
function style(script: string, name: string): string[] {
  const line = script.split('\n').find((entry) => entry.startsWith(`Style: ${name},`));
  if (!line) throw new Error(`no style ${name}`);
  return line.slice('Style: '.length).split(',');
}
const cs = (time: string): number => {
  const [h, m, s] = time.split(':') as [string, string, string];
  return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 100);
};
const pos = (text: string): [number, number] => {
  const match = /\\pos\(([-\d.]+),([-\d.]+)\)/.exec(text);
  if (!match) throw new Error(`no \\pos in ${text}`);
  return [Number(match[1]), Number(match[2])];
};

describe('ASS writer: captions', () => {
  const plan = fixture('caption-karaoke');
  const caption = plan.captions[0]!;
  const script = planAss(plan, [{ kind: 'caption', caption }]);
  const lines = dialogues(script);

  it('writes one Dialogue per plan line, never a \\N, with no wrapping', () => {
    expect(lines).toHaveLength(caption.lines.length);
    expect(script).toContain('WrapStyle: 2');
    expect(script).toContain('YCbCr Matrix: None');
    expect(script).toContain(`PlayResX: ${plan.size.w}`);
    expect(script).toContain(`PlayResY: ${plan.size.h}`);
    for (const line of lines) expect(line.text).not.toContain('\\N');
  });

  it('puts each line at \\an7\\pos(x, y - winAscent * sizePx / unitsPerEm)', () => {
    const metrics = fontMetrics(caption.font);
    caption.lines.forEach((line, index) => {
      const [x, y] = pos(lines[index]!.text);
      expect(lines[index]!.text).toContain('\\an7');
      expect(x).toBeCloseTo(line.x, 3);
      expect(y).toBeCloseTo(line.y - (metrics.winAscent * caption.sizePx) / metrics.unitsPerEm, 3);
    });
  });

  it('sizes the font as the cell height (sizePx x (winAscent + winDescent) / unitsPerEm) and styles from the plan', () => {
    const metrics = fontMetrics(caption.font);
    const fields = style(script, 'Caption0');
    expect(Number(fields[2])).toBeCloseTo((caption.sizePx * (metrics.winAscent + metrics.winDescent)) / metrics.unitsPerEm, 2);
    expect(Number(fields[2])).toBeCloseTo(140, 1); // the document's ASS size 140, which the builder turned into sizePx
    expect(fields[1]).toBe('Montserrat');
    // Karaoke: sung = Primary = emphasis, unsung = Secondary = colour.
    expect(fields[3]).toBe(assColour(caption.emphasisColor));
    expect(fields[4]).toBe(assColour(caption.color));
    expect(fields[5]).toBe(assColour(caption.strokeColor));
    expect(fields[6]).toBe(assColour(caption.shadow!.color, caption.shadow!.opacity));
    expect(fields[6]).toBe('&H64000000'); // legacy BackColour, 155/255 opaque
    expect(Number(fields[16])).toBe(caption.strokePx); // Outline
    expect(Number(fields[17])).toBe(caption.shadow!.offsetPx); // Shadow
    expect(Number(fields[15])).toBe(1); // BorderStyle
  });

  it('lights every karaoke word at its absolute plan time (the \\k sums from the event start)', () => {
    const start = cs(lines[0]!.start);
    expect(start).toBe(Math.round(caption.start * 100));
    caption.lines.forEach((line, index) => {
      const text = lines[index]!.text;
      const syllables = [...text.matchAll(/\{\\k(\d+)\}([^{]*)/g)].map((match) => ({ k: Number(match[1]), word: match[2]!.trim() }));
      let clock = start;
      const lit = new Map<string, number>();
      for (const syllable of syllables) {
        if (syllable.word) lit.set(syllable.word, clock);
        clock += syllable.k;
      }
      for (const word of line.words!) expect(lit.get(word.w), `${word.w} in line ${index}`).toBe(Math.round(word.s * 100));
      // The second line waits for its first word (1.5 s) with an empty syllable.
      if (index === 1) expect(syllables[0]).toEqual({ k: 100, word: '' });
      expect(syllables.filter((syllable) => syllable.word).map((syllable) => syllable.word).join(' ')).toBe(line.text);
    });
  });

  it('snaps off-grid times to the first output frame at or after them', () => {
    expect(frameSnappedCs(0.5, 30)).toBe(50);
    expect(frameSnappedCs(0.51, 30)).toBe(53); // frame 16 = 0.5333 s
    expect(frameSnappedCs(1.1, 30)).toBe(110);
    const words = [{ w: 'A', s: 0.51, e: 0.7, x: 0 }, { w: 'B', s: 0.69, e: 0.9, x: 10 }];
    const offGrid = { ...caption, start: 0.5, lines: [{ text: 'A B', x: 0, y: 100, width: 20, words }] } as PlanCaption;
    // A lights at frame 16 (53 cs), B at frame 21 (70 cs).
    expect(karaokeLineText(offGrid, words, 30)).toBe('{\\k3}{\\k17}A {\\k20}B');
  });

  it('writes a right-to-left or approximate karaoke line as one syllable', () => {
    const words = [{ w: 'שלום עולם', s: 1, e: 2, x: 40 }];
    expect(karaokeLineText({ ...caption, start: 0.5 }, words, 30)).toBe('{\\k50}{\\k100}שלום עולם');
  });

  it('writes plain captions in their colour, on lanes in order, each between its own times', () => {
    const multi = fixture('captions-multi-lane');
    const ordered = [...multi.captions].sort((left, right) => left.lane - right.lane || left.start - right.start);
    const text = planAss(multi, ordered.map((item) => ({ kind: 'caption' as const, caption: item })));
    const events = dialogues(text);
    expect(events).toHaveLength(ordered.reduce((sum, item) => sum + item.lines.length, 0));
    ordered.forEach((item, index) => {
      const event = events.find((entry) => entry.style === `Caption${index}`)!;
      expect(cs(event.start)).toBe(frameSnappedCs(item.start, multi.fps));
      expect(cs(event.end)).toBe(frameSnappedCs(item.end, multi.fps));
      expect(event.text).toContain(item.lines[0]!.text);
      expect(style(text, `Caption${index}`)[3]).toBe(assColour(item.color));
    });
    // Later lanes draw on higher layers.
    const layers = ordered.map((_, index) => events.find((entry) => entry.style === `Caption${index}`)!.layer);
    expect([...layers].sort((left, right) => left - right)).toEqual(layers);
  });

  it('escapes override braces, and keeps a backslash literal with a word joiner (libass has no \\\\ escape)', () => {
    const odd = { ...caption, lines: [{ text: 'a{b}\\c', x: 1, y: 2, width: 3 }] } as PlanCaption;
    expect(dialogues(planAss(plan, [{ kind: 'caption', caption: odd }]))[0]!.text).toContain('a\\{b\\}\\\u2060c');
  });

  it('puts a plan box on a BorderStyle 3 event under the text', () => {
    const boxed = { ...caption, box: { color: '#FFFFFF', opacity: 0.5, padPx: 12, radiusPx: 0 } } as PlanCaption;
    const text = planAss(plan, [{ kind: 'caption', caption: boxed }]);
    const fields = style(text, 'CaptionBox0');
    expect(Number(fields[15])).toBe(3);
    expect(Number(fields[16])).toBe(12);
    expect(fields[5]).toBe('&H80FFFFFF');
    const events = dialogues(text);
    expect(events.filter((event) => event.style === 'CaptionBox0')).toHaveLength(boxed.lines.length);
    expect(Math.max(...events.filter((event) => event.style === 'CaptionBox0').map((event) => event.layer)))
      .toBeLessThan(Math.min(...events.filter((event) => event.style === 'Caption0').map((event) => event.layer)));
  });
});

describe('ASS writer: callouts', () => {
  const plan = fixture('overlays');
  const overlay = plan.overlays.find((item) => item.kind === 'callout') as PlanOverlay & { callout: PlanCallout };
  const events = dialogues(planAss(plan, [{ kind: 'callout', overlay }]));
  const { box, callout } = overlay;
  const left = box.x - box.w / 2;
  const top = box.y - box.h / 2;

  it('draws card, glyph and label in that order, rotated about the box centre', () => {
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.layer)).toEqual([0, 1, 2]);
    for (const event of events) {
      expect(event.text).toContain(`\\org(${box.x},${box.y})`);
      expect(event.text).toContain(`\\frz${-box.rotationDeg}`); // ASS turns counter-clockwise
    }
  });

  it('draws the card as a rounded path the size of the card at its box-local origin, in its colour and alpha', () => {
    const card = events[0]!.text;
    const [x, y] = pos(card);
    expect(x).toBeCloseTo(left + callout.card.x, 3);
    expect(y).toBeCloseTo(top + callout.card.y, 3);
    expect(card).toContain('\\1c&H1B1414&');
    expect(card).toContain('\\1a&H0D&'); // F2 = 242/255 opaque
    const path = card.slice(card.indexOf('\\p1}') + 4, card.indexOf('{\\p0}'));
    const numbers = path.split(' ').map(Number).filter((value) => Number.isFinite(value));
    const xs = numbers.filter((_, index) => index % 2 === 0);
    const ys = numbers.filter((_, index) => index % 2 === 1);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBeCloseTo(callout.card.w, 3);
    expect(Math.max(...ys)).toBeCloseTo(callout.card.h, 3);
    expect(path).toContain(' b '); // Bezier corners
  });

  it('strokes the check glyph through its fractional points with round libass borders', () => {
    const glyph = callout.glyph!;
    const text = events[1]!.text;
    expect(text).toContain(`\\bord${Math.round((glyph.strokePx / 2) * 1000) / 1000}`);
    expect(text).toContain('\\1a&HFF&');
    expect(text).toContain('\\3c&H8AD939&');
    const [x, y] = pos(text);
    expect(x).toBeCloseTo(left + glyph.x + 0.05 * glyph.w, 3);
    expect(y).toBeCloseTo(top + glyph.y + 0.12 * glyph.h, 3);
  });

  it('sets the label in the bundled face with its baseline at the plan y', () => {
    const label = callout.label;
    const text = events[2]!.text;
    const [x, y] = pos(text);
    expect(x).toBeCloseTo(left + label.x, 3);
    expect(y).toBeCloseTo(top + cellTop(label.font, label.sizePx, label.y), 3);
    expect(text).toContain(`\\fs${Math.round(assFontSize(label.font, label.sizePx) * 1000) / 1000}`);
    expect(text.endsWith(label.text)).toBe(true);
  });
});
