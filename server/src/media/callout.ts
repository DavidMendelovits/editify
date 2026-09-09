import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Callout } from '@editify/shared';
import { dataRoot } from '../config.js';
import { runProcess } from './process.js';

const calloutRoot = join(dataRoot, 'callouts');

/**
 * Card face size in a 1080-wide frame, rasterized at 2x so the overlay `scale`
 * only ever downsamples. `lockFocus` multiplies by the screen backing scale on
 * top of this, so a Retina host gets 4x for free — it only affects sharpness,
 * never layout, since the PNG is always scaled to `overlay.width` downstream.
 */
const FACE_FONT_PX = 44;
const RASTER_SCALE = 2;
const RASTER_FONT_PX = FACE_FONT_PX * RASTER_SCALE;

/** Verdict glyph per variant — `card` is text only. */
export const CALLOUT_GLYPH: Record<Callout['variant'], string> = { check: '✓', x: '✗', card: '' };
/** Accent defaults: green verdict, red rebuttal, plain white for a bare card. */
export const CALLOUT_ACCENT: Record<Callout['variant'], string> = { check: '#39D98A', x: '#FF5C70', card: '#FFFFFF' };
/** Dark and slightly translucent, so frame detail still reads under the card. */
export const CALLOUT_BG = '#14141BF2';

export interface CalloutRequest extends Callout {
  text: string;
}

export interface CalloutDrawSpec {
  text: string;
  glyph: string;
  fontPx: number;
  padding: number;
  radius: number;
  gap: number;
  glyphColor: [number, number, number, number];
  bgColor: [number, number, number, number];
}

/** `#RRGGBB` (opaque) or `#RRGGBBAA` → the 0..1 sRGB components NSColor wants. */
export function srgbComponents(hex: string): [number, number, number, number] {
  const digits = /^#?([\da-f]{6}(?:[\da-f]{2})?)$/i.exec(hex.trim())?.[1] ?? 'FFFFFF';
  const channel = (at: number): number => Number((Number.parseInt(digits.slice(at, at + 2), 16) / 255).toFixed(4));
  return [channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) : 1];
}

/**
 * Card geometry, all derived from the font size so the card scales as one
 * piece: ~0.6em padding, ~0.45em corner radius, ~0.35em glyph gap. Single
 * line — the mobile UI keeps callouts short, and a long one just grows wide.
 */
export function calloutDrawSpec(request: CalloutRequest, fontPx: number = RASTER_FONT_PX): CalloutDrawSpec {
  return {
    text: request.text,
    glyph: CALLOUT_GLYPH[request.variant],
    fontPx,
    padding: Math.round(fontPx * 0.6),
    radius: Math.round(fontPx * 0.45),
    gap: Math.round(fontPx * 0.35),
    glyphColor: srgbComponents(request.color ?? CALLOUT_ACCENT[request.variant]),
    bgColor: srgbComponents(request.bg ?? CALLOUT_BG),
  };
}

/** Raster size is part of the key so bumping RASTER_SCALE invalidates the cache. */
export function calloutCacheKey(request: CalloutRequest): string {
  const inputs = {
    text: request.text,
    variant: request.variant,
    color: request.color ?? null,
    bg: request.bg ?? null,
    fontPx: RASTER_FONT_PX,
  };
  return createHash('sha1').update(JSON.stringify(inputs)).digest('hex');
}

/**
 * JXA (osascript) renderer: fills a rounded card with NSBezierPath, then draws
 * the verdict glyph and the label with the NSString drawing category. libass
 * has no rounded-box primitive, so exported callouts ride the image-overlay
 * path like emoji stickers do.
 * ponytail: macOS-only; on other hosts render.ts falls back to ASS text.
 */
const JXA = `
function run(argv) {
  ObjC.import('Cocoa');
  // The spec rides in as JSON so the argument can never start with '-' and trip
  // osascript's option parsing, which callout text like "-50% edit time" would do.
  const spec = JSON.parse(argv[0]);
  const out = argv[1];
  // ponytail: system font. Montserrat (the caption face) ships as a fontsdir
  // file for libass, not an installed face, so CoreText would silently substitute.
  const font = $.NSFont.boldSystemFontOfSize(spec.fontPx);
  function color(components) {
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(components[0], components[1], components[2], components[3]);
  }
  function attributes(foreground) {
    const dictionary = $.NSMutableDictionary.alloc.init;
    dictionary.setObjectForKey(font, $.NSFontAttributeName);
    dictionary.setObjectForKey(foreground, $.NSForegroundColorAttributeName);
    return dictionary;
  }
  const textAttributes = attributes(color([1, 1, 1, 1]));
  const glyphAttributes = attributes(color(spec.glyphColor));
  const hasGlyph = spec.glyph.length > 0;
  const text = $(spec.text);
  const glyph = $(spec.glyph);
  const textSize = text.sizeWithAttributes(textAttributes);
  const glyphSize = hasGlyph ? glyph.sizeWithAttributes(glyphAttributes) : { width: 0, height: 0 };
  const lead = hasGlyph ? glyphSize.width + spec.gap : 0;
  const line = Math.max(textSize.height, glyphSize.height);
  const width = Math.max(2, Math.ceil(lead + textSize.width + spec.padding * 2));
  const height = Math.max(2, Math.ceil(line + spec.padding * 2));
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(width, height));
  image.lockFocus;
  color(spec.bgColor).set;
  const card = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(0, 0, width, height), spec.radius, spec.radius);
  card.fill;
  if (hasGlyph) {
    glyph.drawAtPointWithAttributes($.NSMakePoint(spec.padding, spec.padding + (line - glyphSize.height) / 2), glyphAttributes);
  }
  text.drawAtPointWithAttributes($.NSMakePoint(spec.padding + lead, spec.padding + (line - textSize.height) / 2), textAttributes);
  image.unlockFocus;
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  png.writeToFileAtomically(out, true);
  return 'ok';
}
`;

const inFlight = new Map<string, Promise<string | null>>();

/**
 * Rasterize a callout card to a cached transparent PNG. Returns the file path,
 * or null when rasterization is unavailable — the caller then falls back to
 * the ASS pass.
 */
export async function rasterizeCallout(request: CalloutRequest): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const path = join(calloutRoot, `${calloutCacheKey(request)}.png`);
  if (existsSync(path)) return path;
  const pending = inFlight.get(path) ?? (async () => {
    await mkdir(calloutRoot, { recursive: true });
    try {
      const spec = JSON.stringify(calloutDrawSpec(request));
      await runProcess('osascript', ['-l', 'JavaScript', '-e', JXA, spec, path]);
      return existsSync(path) ? path : null;
    } catch {
      return null;
    }
  })().finally(() => inFlight.delete(path));
  inFlight.set(path, pending);
  return await pending;
}
