import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clip, Project } from '@editify/shared';
import { clipTimelineDuration, DEFAULT_CAPTION_STYLE } from '@editify/shared';
import { CALLOUT_ACCENT, CALLOUT_BG, CALLOUT_GLYPH } from './callout.js';

export interface AssFont {
  family: string;
  directory?: string;
}

function firstMatchingFont(directory: string, pattern: RegExp): string | undefined {
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory).find((name) => pattern.test(name));
}

const bundledFontsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../fonts');
const montserratPath = join(bundledFontsDirectory, 'Montserrat-Bold.ttf');
// The static Bold cut. The variable font (Montserrat[wght]) makes libass fall
// back to Helvetica-Bold for weight 700: `fontselect: (Montserrat, 700, 0) -> Helvetica-Bold`.
const montserratUrl = 'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Bold.ttf';

export function locateAssFont(): AssFont {
  if (existsSync(montserratPath)) return { family: 'Montserrat', directory: bundledFontsDirectory };
  const directories = [join(homedir(), 'Library', 'Fonts'), '/Library/Fonts'];
  for (const directory of directories) {
    const match = firstMatchingFont(directory, /^Montserrat.*\.(?:ttf|otf|ttc)$/i);
    if (match) return { family: 'Montserrat', directory };
  }
  return { family: 'Helvetica' };
}

async function ensureAssFont(): Promise<AssFont> {
  const located = locateAssFont();
  if (located.family === 'Montserrat') return located;
  try {
    const response = await fetch(montserratUrl);
    if (!response.ok) throw new Error(`font download returned ${response.status}`);
    await mkdir(bundledFontsDirectory, { recursive: true });
    await writeFile(montserratPath, new Uint8Array(await response.arrayBuffer()));
    return { family: 'Montserrat', directory: bundledFontsDirectory };
  } catch {
    return located;
  }
}

export function formatAssTime(seconds: number): string {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

/** `#RRGGBB` (opaque) or `#RRGGBBAA` → ASS `&HAABBGGRR`; ASS alpha is inverted. */
function assColor(hex: string): string {
  const match = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i);
  if (!match) return '&H00FFFFFF';
  const alpha = match[4] ? (255 - Number.parseInt(match[4], 16)).toString(16).padStart(2, '0') : '00';
  return `&H${alpha}${match[3]}${match[2]}${match[1]}`.toUpperCase();
}

/** An inline `\c` override takes `&HBBGGRR&` — no alpha byte, trailing ampersand. */
function assInlineColor(hex: string): string {
  return `&H${assColor(hex).slice(4)}&`;
}

function assText(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}').replace(/\r?\n/g, '\\N');
}

function karaokeText(clip: Clip): string | undefined {
  const words = clip.style?.words;
  if (!words?.length) return undefined;
  return words.map((word, index) => {
    const next = words[index + 1];
    const durationCs = Math.max(1, Math.round(((next?.s ?? word.e) - word.s) * 100));
    return `{\\k${durationCs}}${assText(word.w)}`;
  }).join(' ');
}

function captionClips(project: Project): Clip[] {
  return project.tracks.filter((track) => track.kind === 'caption')
    .flatMap((track) => track.clips)
    .filter((clip) => Boolean(clip.text))
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
}

/**
 * Emoji stickers and callout cards riding the ASS pass. Normally both are
 * rasterized to PNG overlays; only clips in `stickerClipIds` (rasterization
 * unavailable — e.g. a non-macOS host) render here, monochrome fallback and
 * all. `undefined` keeps the standalone-generateAss behaviour of including
 * every text overlay clip.
 */
function overlayTextClips(project: Project, stickerClipIds: readonly string[] | undefined): Clip[] {
  return project.tracks.filter((track) => track.kind === 'overlay')
    .flatMap((track) => track.clips)
    .filter((clip) => !clip.assetId && Boolean(clip.text))
    .filter((clip) => stickerClipIds === undefined || stickerClipIds.includes(clip.id))
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
}

/**
 * Emoji ride the subtitle pass: one centred ASS event per sticker, positioned
 * with \pos and sized so the glyph width tracks `overlay.width` of the frame.
 * libass falls back to the platform emoji font for emoji codepoints.
 *
 * Callouts use the boxed Callout style instead — BorderStyle=3 paints the card
 * behind the line, so the fallback still reads as a card — and prefix the
 * verdict glyph in its accent colour. Their size comes off the frame height,
 * not `overlay.width`: the box grows with the text the way the PNG card does.
 */
function overlayTextDialogue(project: Project, width: number, height: number, stickerClipIds: readonly string[] | undefined): string[] {
  return overlayTextClips(project, stickerClipIds).map((clip) => {
    const placement = clip.overlay ?? { x: 0.5, y: 0.35, width: 0.28, rotation: 0 };
    const callout = clip.callout;
    const size = Math.max(12, Math.round(callout ? height * 0.038 : placement.width * width));
    const x = Math.round(placement.x * width);
    const y = Math.round(placement.y * height);
    // ASS \frz is counter-clockwise; document rotation is clockwise.
    const rotate = placement.rotation ? `\\frz${(-placement.rotation).toFixed(1)}` : '';
    const end = clip.start + clipTimelineDuration(clip);
    const glyph = callout ? CALLOUT_GLYPH[callout.variant] : '';
    const prefix = callout && glyph
      ? `{\\c${assInlineColor(callout.color ?? CALLOUT_ACCENT[callout.variant])}}${glyph} {\\c&HFFFFFF&}`
      : '';
    return `Dialogue: 1,${formatAssTime(clip.start)},${formatAssTime(end)},${callout ? 'Callout' : 'Sticker'},,0,0,0,,`
      + `{\\pos(${x},${y})\\fs${size}${rotate}}${prefix}${assText(clip.text ?? '')}`;
  });
}

interface CaptionEvent {
  clip: Clip;
  style: NonNullable<Clip['style']>;
  alignment: number;
  marginV: number;
  size: number;
  end: number;
}

// Last line of defence against stacked captions: two events sharing a vertical anchor cannot
// overlap in time. Events at different anchors (top vs bottom) legitimately coexist.
function captionEvents(clips: Clip[], width: number, height: number, safeMargin: number): CaptionEvent[] {
  const events = clips.map<CaptionEvent>((clip) => {
    const style = clip.style ?? DEFAULT_CAPTION_STYLE;
    const alignment = style.anchorPct !== undefined ? 5 : style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2;
    return {
      clip,
      style,
      alignment,
      marginV: style.position === 'center' || style.anchorPct !== undefined ? 0 : safeMargin,
      size: Math.max(10, Math.round(style.sizePct !== undefined ? height * style.sizePct / 100 : style.size * width / 1080)),
      end: clip.start + clipTimelineDuration(clip),
    };
  });
  const byAnchor = new Map<string, CaptionEvent[]>();
  for (const event of events) {
    const key = `${event.alignment}:${event.style.anchorPct ?? ''}:${event.marginV}`;
    const lane = byAnchor.get(key) ?? [];
    const previous = lane.at(-1);
    if (previous && previous.end > event.clip.start) previous.end = Math.max(previous.clip.start, event.clip.start);
    lane.push(event);
    byAnchor.set(key, lane);
  }
  return events;
}

export function generateAss(
  project: Project,
  width: number,
  height: number,
  options: { fontFamily?: string; safeAreaBottomPct?: number; stickerClipIds?: readonly string[] } = {},
): string {
  const fontFamily = options.fontFamily ?? 'Montserrat';
  const configuredSafeArea = options.safeAreaBottomPct
    ?? Number(process.env.SAFE_AREA_BOTTOM_PCT ?? 12);
  const safeAreaBottomPct = Number.isFinite(configuredSafeArea) ? configuredSafeArea : 12;
  const safeMargin = Math.max(0, Math.round(height * safeAreaBottomPct / 100));
  const events = captionEvents(captionClips(project), width, height, safeMargin);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  ];
  const styles = events.map((event, index) => {
    // ASS karaoke paints SecondaryColour before a word is sung and
    // PrimaryColour after. We want unsung text in the base color and sung
    // words in the emphasis color, so karaoke events swap the two.
    const karaoke = Boolean(event.style.words?.length);
    const primary = assColor(karaoke ? event.style.emphasisColor ?? '#FACC15' : event.style.color);
    const secondary = assColor(karaoke ? event.style.color : event.style.emphasisColor ?? '#FACC15');
    return `Style: Caption${index + 1},${fontFamily},${event.size},${primary},${secondary},${assColor(event.style.strokeColor ?? '#000000')},&H64000000,${event.style.emphasis === 'none' ? 0 : -1},0,0,0,100,100,0,0,1,${event.style.strokePx ?? 3},1,${event.alignment},40,40,${event.marginV},1`;
  });
  // Emoji sticker style: centred anchor, no border/shadow so the glyph stays clean.
  styles.push(`Style: Sticker,${fontFamily},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`);
  // Callout fallback style: BorderStyle=3 paints an opaque box in OutlineColour
  // (the card background), Outline is its padding — the closest ASS gets to the
  // rasterized rounded card. Bold to match the card's bold system face.
  styles.push(`Style: Callout,${fontFamily},64,&H00FFFFFF,&H00FFFFFF,${assColor(CALLOUT_BG)},&H00000000,-1,0,0,0,100,100,0,0,3,8,0,5,40,40,0,1`);
  const dialogue = [
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events.map((event, index) => {
      const position = event.style.anchorPct !== undefined
        ? `{\\pos(${Math.round(width / 2)},${Math.round(height * event.style.anchorPct / 100)})}` : '';
      return `Dialogue: 0,${formatAssTime(event.clip.start)},${formatAssTime(event.end)},Caption${index + 1},,0,0,0,,${position}${karaokeText(event.clip) ?? assText(event.clip.text ?? '')}`;
    }),
    ...overlayTextDialogue(project, width, height, options.stickerClipIds),
    '',
  ];
  return [...header, ...styles, ...dialogue].join('\n');
}

export async function writeAssFile(
  project: Project,
  width: number,
  height: number,
  path: string,
  stickerClipIds: readonly string[] = [],
): Promise<AssFont> {
  const font = await ensureAssFont();
  await writeFile(path, generateAss(project, width, height, { fontFamily: font.family, stickerClipIds }), 'utf8');
  return font;
}
