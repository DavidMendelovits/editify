import { z } from 'zod';

/**
 * Typography the renderers ship (plan decision OV7). The server bundles
 * `server/fonts/Montserrat-Bold.ttf` for libass, and the native renderer
 * bundles the same file. A face is added here only once its font file ships
 * on every renderer.
 *
 * The document keeps `captionStyle.font` as free text on purpose: changing how
 * it parses would change stored projects, and with them the project hashes
 * that phones and servers on different versions compare. The render plan is
 * where the font becomes strict, through captionFaceFor().
 */

/** Families the caption style can name and actually get. */
export const CAPTION_FONTS = ['Montserrat'] as const;
export type CaptionFont = (typeof CAPTION_FONTS)[number];
export const DEFAULT_CAPTION_FONT: CaptionFont = 'Montserrat';

/**
 * The exact faces a render plan names (captions and callout labels): the
 * PostScript names of the bundled font files. Strict, so an executor that
 * meets a face it does not ship fails instead of substituting another.
 */
export const PLAN_FONT_FACES = ['Montserrat-Bold'] as const;
export type PlanFontFace = (typeof PLAN_FONT_FACES)[number];
export const planFontFaceSchema = z.enum(PLAN_FONT_FACES);

/**
 * The face each family draws with. Only the Bold cut is bundled, and libass
 * resolves Montserrat at any weight to it, so `emphasis: 'none'` draws Bold
 * today too; a family gains a lighter face here when one ships.
 */
export const CAPTION_FONT_FACE: Readonly<Record<CaptionFont, PlanFontFace>> = { Montserrat: 'Montserrat-Bold' };

/**
 * The plan face for a document's `captionStyle.font`:
 * `CAPTION_FONT_FACE[font] ?? CAPTION_FONT_FACE.Montserrat`. Any family that is
 * not bundled (legacy free text such as "Inter") draws in Montserrat Bold,
 * which is what every renderer has always drawn.
 */
export function captionFaceFor(font: string | undefined): PlanFontFace {
  return (font !== undefined && (CAPTION_FONTS as readonly string[]).includes(font)
    ? CAPTION_FONT_FACE[font as CaptionFont]
    : undefined) ?? CAPTION_FONT_FACE.Montserrat;
}
