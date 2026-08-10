/**
 * Local mirror of the preset contract (SPEC-WAVE2.md §D).
 *
 * These types live in `apps/mobile` rather than `@editify/shared` so the UI can
 * ship against `GET /presets` before the server package settles. The list the
 * server returns is authoritative; everything below is presentation only.
 */

/** One row of `GET /presets` — the summary shape, not the full preset body. */
export interface EditPreset {
  name: string;
  description: string;
  targetContent: string[];
}

/**
 * LOCAL FALLBACK — used only when `GET /presets` 404s (the server-side preset
 * routes may not be deployed yet). Transcribed verbatim from
 * `research/social-editing-presets.md` §2; the server list always wins when it
 * answers. Keep in sync with that research file, not with any server default.
 */
export const FALLBACK_PRESETS: EditPreset[] = [
  {
    name: 'talking_head_punchy',
    description: 'Straight-to-camera micro-influencer take. Silence-trimmed jump cuts plus alternating punch-in so a single angle reads as multi-cam.',
    targetContent: ['talking_head', 'advice', 'rant'],
  },
  {
    name: 'standup_clip',
    description: 'Stand-up set to social clip. Tightens the setup, protects the pause before the punch, cuts on the laugh peak, and never lets the caption arrive early.',
    targetContent: ['standup', 'crowd_work'],
  },
  {
    name: 'sketch_multicam',
    description: 'Scripted sketch with multiple angles/characters. Cut for performance, not for silence; reaction shots after every punch.',
    targetContent: ['sketch', 'skit', 'character_bit'],
  },
  {
    name: 'vlog_montage',
    description: 'Day-in-the-life / BTS. Music-led, loose sync, pattern interrupt on a clock so the retention curve stays flat.',
    targetContent: ['vlog', 'bts', 'process'],
  },
  {
    name: 'podcast_clip_loop',
    description: 'Long-form interview to 9:16 clip, Opus-Clip style: mine the best self-contained moment, static face-biased crop, loop-friendly close.',
    targetContent: ['podcast', 'interview', 'long_form_excerpt'],
  },
];

/** Readable phrase for the five known presets; unknown names fall back to the snake_case words. */
const PRESET_TITLE: Record<string, string> = {
  talking_head_punchy: 'punchy talking head',
  standup_clip: 'standup clip',
  sketch_multicam: 'multicam sketch',
  vlog_montage: 'vlog montage',
  podcast_clip_loop: 'looping podcast clip',
};

/** `standup_clip` → `standup clip`. Lowercase, matching the brand voice. */
export function presetTitle(name: string): string {
  return PRESET_TITLE[name] ?? name.replaceAll('_', ' ').trim().toLowerCase();
}

/** `standup_clip` → `cut this as a standup clip` — what tapping a preset card types for you. */
export function presetPrompt(name: string): string {
  const title = presetTitle(name);
  const article = /^[aeiou]/.test(title) ? 'an' : 'a';
  return `cut this as ${article} ${title}`;
}

/** `talking_head` → `talking head` — the content tags shown under a preset name. */
export function contentTagLabel(tag: string): string {
  return tag.replaceAll('_', ' ').trim().toLowerCase();
}
