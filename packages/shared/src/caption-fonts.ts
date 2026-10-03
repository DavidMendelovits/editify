import { z } from 'zod';

/**
 * Caption typography is constrained to fonts both renderers ship (plan
 * decision OV7): the server bundles `server/fonts/Montserrat-Bold.ttf` for
 * libass, and the native CaptionRenderer bundles the same file. A family is
 * added here only once its font files ship on every renderer.
 */
export const CAPTION_FONTS = ['Montserrat'] as const;
export type CaptionFont = (typeof CAPTION_FONTS)[number];
export const DEFAULT_CAPTION_FONT: CaptionFont = 'Montserrat';

/**
 * `captionStyle.font`. Documents written before the enum carried free text
 * ("Inter", "Space Grotesk", whatever the agent typed), and no renderer ever
 * honoured it: the export always drew the bundled Montserrat. So any value
 * outside the list, or none, parses as the default and old projects still load
 * and look exactly as they did.
 */
export const captionFontSchema = z.preprocess(
  (value) => (typeof value === 'string' && (CAPTION_FONTS as readonly string[]).includes(value) ? value : DEFAULT_CAPTION_FONT),
  z.enum(CAPTION_FONTS),
);

/**
 * The exact faces a render plan names: PostScript names of the bundled font
 * files. Unlike `captionStyle.font` this is strict, because an executor that
 * meets a face it does not ship must fail rather than substitute one.
 */
export const CAPTION_FACES = ['Montserrat-Bold'] as const;
export type CaptionFace = (typeof CAPTION_FACES)[number];
export const captionFaceSchema = z.enum(CAPTION_FACES);

/**
 * The face each family draws captions with. Only the Bold cut is bundled, and
 * libass resolves Montserrat at any weight to it, so `emphasis: 'none'` draws
 * Bold today too; a family gains a lighter face here when one ships.
 */
export const CAPTION_FONT_FACE: Readonly<Record<CaptionFont, CaptionFace>> = { Montserrat: 'Montserrat-Bold' };
