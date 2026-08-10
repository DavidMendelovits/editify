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
  const clips = captionClips(project);
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
  const styles = clips.map((clip, index) => {
    const style = clip.style ?? { font: fontFamily, size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold' };
    const alignment = style.anchorPct !== undefined ? 5 : style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2;
    const marginV = style.position === 'center' || style.anchorPct !== undefined ? 0 : safeMargin;
    const size = Math.max(10, Math.round(style.sizePct !== undefined ? height * style.sizePct / 100 : style.size * width / 1080));
    return `Style: Caption${index + 1},${fontFamily},${size},${assColor(style.color)},${assColor(style.emphasisColor ?? '#FACC15')},${assColor(style.strokeColor ?? '#000000')},&H64000000,${style.emphasis === 'none' ? 0 : -1},0,0,0,100,100,0,0,1,${style.strokePx ?? 3},1,${alignment},40,40,${marginV},1`;
  });
  const events = [
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...clips.map((clip, index) => {
      const end = clip.start + clipTimelineDuration(clip);
      const position = clip.style?.anchorPct !== undefined
        ? `{\\pos(${Math.round(width / 2)},${Math.round(height * clip.style.anchorPct / 100)})}` : '';
      return `Dialogue: 0,${formatAssTime(clip.start)},${formatAssTime(end)},Caption${index + 1},,0,0,0,,${position}${karaokeText(clip) ?? assText(clip.text ?? '')}`;
    }),
    '',
  ];
  return [...header, ...styles, ...events].join('\n');
}

export async function writeAssFile(project: Project, width: number, height: number, path: string): Promise<AssFont> {
  const font = await ensureAssFont();
  await writeFile(path, generateAss(project, width, height, { fontFamily: font.family }), 'utf8');
  return font;
}
