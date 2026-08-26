import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
