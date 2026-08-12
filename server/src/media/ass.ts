import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clip, Project } from '@editify/shared';
import { clipTimelineDuration } from '@editify/shared';

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
const montserratUrl = 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf';

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

function assColor(hex: string): string {
  const match = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!match) return '&H00FFFFFF';
  return `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase();
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
function captionEvents(clips: Clip[], fontFamily: string, width: number, height: number, safeMargin: number): CaptionEvent[] {
  const events = clips.map<CaptionEvent>((clip) => {
    const style = clip.style ?? { font: fontFamily, size: 52, color: '#FFFFFF', position: 'bottom' as const, emphasis: 'bold' as const };
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
  options: { fontFamily?: string; safeAreaBottomPct?: number } = {},
): string {
  const fontFamily = options.fontFamily ?? 'Montserrat';
  const configuredSafeArea = options.safeAreaBottomPct
    ?? Number(process.env.safeAreaBottomPct ?? process.env.SAFE_AREA_BOTTOM_PCT ?? 12);
  const safeAreaBottomPct = Number.isFinite(configuredSafeArea) ? configuredSafeArea : 12;
  const safeMargin = Math.max(0, Math.round(height * safeAreaBottomPct / 100));
  const events = captionEvents(captionClips(project), fontFamily, width, height, safeMargin);
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
  const styles = events.map((event, index) =>
    `Style: Caption${index + 1},${fontFamily},${event.size},${assColor(event.style.color)},${assColor(event.style.emphasisColor ?? '#FACC15')},${assColor(event.style.strokeColor ?? '#000000')},&H64000000,${event.style.emphasis === 'none' ? 0 : -1},0,0,0,100,100,0,0,1,${event.style.strokePx ?? 3},1,${event.alignment},40,40,${event.marginV},1`);
  const dialogue = [
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events.map((event, index) => {
      const position = event.style.anchorPct !== undefined
        ? `{\\pos(${Math.round(width / 2)},${Math.round(height * event.style.anchorPct / 100)})}` : '';
      return `Dialogue: 0,${formatAssTime(event.clip.start)},${formatAssTime(event.end)},Caption${index + 1},,0,0,0,,${position}${karaokeText(event.clip) ?? assText(event.clip.text ?? '')}`;
    }),
    '',
  ];
  return [...header, ...styles, ...dialogue].join('\n');
}

export async function writeAssFile(project: Project, width: number, height: number, path: string): Promise<AssFont> {
  const font = await ensureAssFont();
  await writeFile(path, generateAss(project, width, height, { fontFamily: font.family }), 'utf8');
  return font;
}
