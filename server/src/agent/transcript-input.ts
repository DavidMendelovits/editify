/**
 * Parses a transcript the user pasted into chat. Unlike stored asset
 * transcripts, pasted text arrives in whatever shape the user's tool exported —
 * SRT, VTT, or timestamped notes — so the timecodes have to be recovered before
 * anything can be mapped onto the timeline.
 */

export interface TranscriptInputSegment {
  start: number;
  /** null when the format only marks where a line begins (timestamped notes). */
  end: number | null;
  text: string;
}

export type TranscriptInputFormat = 'srt' | 'vtt' | 'timestamped-text';

export type TranscriptInputResult =
  | { ok: true; format: TranscriptInputFormat; segments: TranscriptInputSegment[] }
  | { ok: false; code: 'no-timecodes' | 'unrecognized' | 'empty'; error: string };

/** `00:00:01,000`, `00:01.000`, `1:02:03.5` — hours optional, comma or dot decimals. */
const CUE_TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?`;
const CUE_LINE = new RegExp(String.raw`^\s*${CUE_TIME}\s*-->\s*${CUE_TIME}`);
/** A leading `[0:01:02.5]`, `(1:02)`, or bare `01:02` before the line's text. */
const PREFIX_LINE = new RegExp(String.raw`^\s*(?:\[\s*${CUE_TIME}\s*\]|\(\s*${CUE_TIME}\s*\)|${CUE_TIME})\s*[-–—:]?\s*(.*)$`);

function toSeconds(hours: string | undefined, minutes: string, seconds: string, fraction: string | undefined): number {
  const fractional = fraction ? Number(fraction) / 10 ** fraction.length : 0;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + fractional;
}

function pushSegment(segments: TranscriptInputSegment[], start: number, end: number | null, lines: string[]): void {
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (text) segments.push({ start, end, text });
}

/** SRT/VTT cue blocks: a `-->` line, optional cue id above it, text below. */
function parseCues(lines: string[]): TranscriptInputSegment[] {
  const segments: TranscriptInputSegment[] = [];
  let current: { start: number; end: number; lines: string[] } | null = null;
  for (const [index, line] of lines.entries()) {
    const cue = CUE_LINE.exec(line);
    if (cue) {
      if (current) pushSegment(segments, current.start, current.end, current.lines);
      current = {
        start: toSeconds(cue[1], cue[2] ?? '0', cue[3] ?? '0', cue[4]),
        end: toSeconds(cue[5], cue[6] ?? '0', cue[7] ?? '0', cue[8]),
        lines: [],
      };
      continue;
    }
    if (!current || !line.trim()) continue;
    // A line immediately above a cue line is that cue's id, not dialogue.
    if (CUE_LINE.test(lines[index + 1] ?? '')) continue;
    current.lines.push(line.trim());
  }
  if (current) pushSegment(segments, current.start, current.end, current.lines);
  return segments;
}

/** Lines that open with a timestamp; the rest of the line is that segment's text. */
function parsePrefixed(lines: string[]): TranscriptInputSegment[] {
  const segments: TranscriptInputSegment[] = [];
  for (const line of lines) {
    const match = PREFIX_LINE.exec(line);
    if (!match) {
      // A line with no timestamp continues the previous timestamped line.
      const previous = segments.at(-1);
      if (previous && line.trim()) previous.text = `${previous.text} ${line.trim()}`.replace(/\s+/g, ' ');
      continue;
    }
    // The three timestamp forms occupy groups 1-4, 5-8, and 9-12 respectively.
    const offset = match[2] !== undefined ? 1 : match[6] !== undefined ? 5 : 9;
    pushSegment(segments, toSeconds(match[offset], match[offset + 1] ?? '0', match[offset + 2] ?? '0', match[offset + 3]), null, [match[13] ?? '']);
  }
  return segments;
}

export function parseTranscriptInput(text: string): TranscriptInputResult {
  if (!text.trim()) {
    return { ok: false, code: 'empty', error: 'No transcript text was provided.' };
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const isVtt = /^\s*WEBVTT\b/.test(text) || lines.some((line) => /-->/.test(line) && /\d\.\d/.test(line));

  if (lines.some((line) => CUE_LINE.test(line))) {
    const segments = parseCues(lines);
    if (!segments.length) {
      return { ok: false, code: 'unrecognized', error: 'The cue timecodes parsed but no caption text followed them. Paste the full transcript including the caption lines.' };
    }
    return { ok: true, format: isVtt ? 'vtt' : 'srt', segments };
  }

  const prefixed = parsePrefixed(lines);
  if (prefixed.length) return { ok: true, format: 'timestamped-text', segments: prefixed };

  if (/[A-Za-z]/.test(text)) {
    return {
      ok: false,
      code: 'no-timecodes',
      error: 'This transcript has no timecodes. Provide SRT, VTT, or lines prefixed with timestamps like [00:01:02] so segments can be mapped to the timeline.',
    };
  }
  return { ok: false, code: 'unrecognized', error: 'This text is not a transcript I can read. Provide SRT, VTT, or lines prefixed with timestamps like [00:01:02].' };
}
