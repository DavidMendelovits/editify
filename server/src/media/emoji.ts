import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanEmoji } from '@editify/shared';
import { dataRoot } from '../config.js';
import { runProcess } from './process.js';

const emojiRoot = join(dataRoot, 'emoji');
/** Emoji are forgiving of upscaling; 320px covers a third of a 1080-wide frame. */
const RASTER_PX = 320;

/**
 * JXA (osascript) renderer: draws the text with Apple Color Emoji via
 * NSAttributedString into a transparent PNG. libass/drawtext render emoji as
 * tofu boxes, so exported emoji stickers ride the image-overlay path instead.
 * ponytail: macOS-only; on other hosts render.ts falls back to ASS text.
 */
const JXA = `
function run(argv) {
  ObjC.import('Cocoa');
  const text = $(argv[0]);
  const px = Number(argv[1]);
  const out = argv[2];
  const font = $.NSFont.fontWithNameSize('Apple Color Emoji', px);
  const attributes = $.NSMutableDictionary.alloc.init;
  attributes.setObjectForKey(font, $.NSFontAttributeName);
  const size = text.sizeWithAttributes(attributes);
  const width = Math.max(2, Math.ceil(size.width));
  const height = Math.max(2, Math.ceil(size.height));
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(width, height));
  image.lockFocus;
  text.drawAtPointWithAttributes($.NSMakePoint(0, 0), attributes);
  image.unlockFocus;
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  png.writeToFileAtomically(out, true);
  return 'ok';
}
`;

const inFlight = new Map<string, Promise<string | null>>();

/**
 * Rasterize sticker text (emoji or short text) to a cached transparent PNG.
 * Returns the file path, or null when rasterization is unavailable — the
 * caller then falls back to the ASS pass.
 */
export async function rasterizeEmoji(text: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const path = join(emojiRoot, `${createHash('sha1').update(text).digest('hex')}.png`);
  if (existsSync(path)) return path;
  const pending = inFlight.get(path) ?? (async () => {
    await mkdir(emojiRoot, { recursive: true });
    try {
      await runProcess('osascript', ['-l', 'JavaScript', '-e', JXA, text, String(RASTER_PX), path]);
      return existsSync(path) ? path : null;
    } catch {
      return null;
    }
  })().finally(() => inFlight.delete(path));
  inFlight.set(path, pending);
  return await pending;
}

/*
 * Colour emoji for the plan render on hosts without Apple Color Emoji (the
 * Linux server): Noto Color Emoji (Debian's fonts-noto-color-emoji, CBDT
 * bitmaps at 109 px) drawn by Pillow with raqm (HarfBuzz) shaping, so skin
 * tones, ZWJ sequences, flags and keycaps form one glyph. Neither libass nor
 * ffmpeg 5.1/6.1 drawtext draws colour glyphs, and ffmpeg's librsvg decoder
 * fills SVG text as paths (monochrome).
 *
 * Geometry is the plan's: the raster is the box-local picture of the overlay
 * box (w x h), each emoji cluster drawn where Apple Color Emoji puts it with
 * its pen at (x + i * sizePx, y): Core Text gives every cluster a 1 em advance
 * and draws its square image from 0.875 em above the baseline to 0.125 em
 * below. Noto's glyphs are mapped onto that square by their own full-bleed
 * square (U+1F7E5, 120 px wide at 109 px, 8 px right of and 97 px above the
 * pen), so a Noto emoji covers the cell the phone's does. The designs differ;
 * the sizes and places match.
 */

/** Where Debian (and the runtime image) installs Noto Color Emoji; EMOJI_FONT overrides. */
const NOTO_COLOR_EMOJI = ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'];
/** Bumped whenever the drawing below changes, so cached rasters are redrawn (the font file's identity is in the key too). */
const NOTO_RASTER_VERSION = 2;
/** Largest raster side, px: the canvas resolution drops before a huge box can ask Pillow for a huge image. */
const NOTO_RASTER_MAX_SIDE = 8192;
/** Pillow draws a sticker in well under a second; a stuck interpreter is killed. */
const NOTO_RASTER_TIMEOUT_MS = 15_000;

const PILLOW = `
import json, sys
from PIL import Image, ImageDraw, ImageFont, features
spec = json.loads(sys.argv[1])
if not features.check('raqm'):
    sys.exit(3)
font = ImageFont.truetype(spec['font'], 109, layout_engine=ImageFont.Layout.RAQM)
q = 120.0 / spec['size']
Q = min(max(q, 1.0), spec['maxSide'] / max(spec['w'], spec['h']))
r = Q / q
canvas = Image.new('RGBA', (max(1, round(spec['w'] * Q)), max(1, round(spec['h'] * Q))), (0, 0, 0, 0))
for cluster in spec['clusters']:
    glyph = Image.new('RGBA', (144, 144), (0, 0, 0, 0))
    ImageDraw.Draw(glyph).text((4, 112), cluster['text'], font=font, embedded_color=True, anchor='ls')
    if r != 1.0:
        glyph = glyph.resize((max(1, round(144 * r)), max(1, round(144 * r))), Image.LANCZOS)
    layer = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    layer.paste(glyph, (round(Q * cluster['x'] - 12 * r), round(Q * spec['y'] - 120 * r)))
    canvas = Image.alpha_composite(canvas, layer)
canvas.save(spec['out'])
`;

/** A grapheme cluster Noto Color Emoji draws (or a space, which only advances). */
function drawable(cluster: string): boolean {
  return cluster === ' ' || /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(cluster);
}

const planInFlight = new Map<string, Promise<string | null>>();

/**
 * The plan render's emoji sticker picture: a transparent PNG to stretch over
 * the overlay box, or null when this host cannot draw it in colour (the
 * caller then draws it in monochrome with a QA note). macOS: Apple Color
 * Emoji (rasterizeEmoji, the text's own line box, which the builder fit to
 * the box). Elsewhere: Noto Color Emoji at the plan's geometry (above), when
 * the font, python3 and Pillow with raqm are there; only emoji (and spaces).
 */
export async function rasterizePlanEmoji(emoji: PlanEmoji, box: { w: number; h: number }): Promise<string | null> {
  if (process.platform === 'darwin') return await rasterizeEmoji(emoji.text);
  const font = [process.env.EMOJI_FONT, ...NOTO_COLOR_EMOJI].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!font) return null;
  const clusters = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(emoji.text)].map((part) => part.segment);
  if (clusters.length === 0 || !clusters.every(drawable)) return null;
  if (!(box.w > 0 && box.h > 0 && emoji.sizePx > 0)) return null;
  const spec = {
    font, size: emoji.sizePx, w: box.w, h: box.h, y: emoji.y, maxSide: NOTO_RASTER_MAX_SIDE,
    clusters: clusters.map((text, index) => ({ text, x: emoji.x + index * emoji.sizePx })).filter((cluster) => cluster.text !== ' '),
  };
  const fontFile = statSync(font);
  const key = createHash('sha1').update(JSON.stringify({ v: NOTO_RASTER_VERSION, ...spec, font: [font, fontFile.size, fontFile.mtimeMs] })).digest('hex');
  const path = join(emojiRoot, `noto-${key}.png`);
  if (existsSync(path)) return path;
  const pending = planInFlight.get(path) ?? (async () => {
    await mkdir(emojiRoot, { recursive: true });
    const partial = `${path}.${process.pid}.tmp.png`;
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('python3', ['-c', PILLOW, JSON.stringify({ ...spec, out: partial })], { timeout: NOTO_RASTER_TIMEOUT_MS, killSignal: 'SIGKILL' },
          (error) => (error ? reject(error) : resolve()));
      });
      await rename(partial, path);
      return path;
    } catch (error) {
      await rm(partial, { force: true });
      // No sticker text in the log (the error message carries the whole command line): only its shape.
      const failure = error as { code?: unknown; signal?: unknown; killed?: boolean };
      console.warn('[emoji] colour raster failed; the sticker falls back to monochrome', {
        code: failure.code, signal: failure.signal, timedOut: Boolean(failure.killed), clusters: spec.clusters.length, length: emoji.text.length,
      });
      return null;
    }
  })().finally(() => planInFlight.delete(path));
  planInFlight.set(path, pending);
  return await pending;
}
