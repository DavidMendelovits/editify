import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * A style packet is a creator's repeatable look, captured as data: one
 * typography system, one music treatment, one transition habit, and the
 * density of the recurring devices (callouts, b-roll, punch-ins). Applying a
 * packet sweeps the deterministic parts over the timeline and briefs the
 * agent on the creative parts.
 */
export const stylePacketSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Where the look was learned from — attribution, not a dependency. */
  source: z.object({ creator: z.string(), url: z.string() }).optional(),
  typography: z.object({
    sizePct: z.number().min(1).max(25),
    color: hex,
    emphasisColor: hex.optional(),
    strokeColor: hex.optional(),
    strokePx: z.number().min(0).max(20).optional(),
    anchorPct: z.number().min(0).max(100),
    emphasis: z.enum(['none', 'bold', 'highlight']),
    uppercase: z.boolean(),
    /** Word-timed karaoke captions; needs a transcript to realize. */
    karaoke: z.boolean(),
  }),
  colors: z.object({ accent: hex, good: hex.optional(), bad: hex.optional() }),
  music: z.object({
    /** A library sound id (`sound-music-*`) or null for no bed. */
    soundId: z.string().nullable(),
    volume: z.number().min(0).max(1),
  }),
  transition: z.object({
    type: z.enum(['cut', 'crossfade', 'dip']),
    duration: z.number().min(0.1).max(2),
    /** Small SFX repeated at every cut (`sound-*`), or null. */
    soundId: z.string().nullable(),
    soundVolume: z.number().min(0).max(1).default(0.5),
  }),
  zoom: z.object({
    cadence: z.enum(['off', 'sparse', 'every-shot']),
    scale: z.number().min(1).max(1.3),
  }),
  callouts: z.object({ density: z.enum(['off', 'sparse', 'every-line']) }),
  broll: z.object({ density: z.enum(['off', 'sparse', 'frequent']) }),
  pacing: z.object({ targetShotSeconds: z.number().positive().nullable() }),
});
export type StylePacket = z.infer<typeof stylePacketSchema>;

/**
 * Callout content for an overlay-track clip: the text lives in `clip.text`,
 * placement in `clip.overlay`; this picks the card treatment. `check`/`x`
 * carry the verdict glyph — the "wrong vs right" vocabulary.
 */
export const calloutSchema = z.object({
  variant: z.enum(['check', 'x', 'card']),
  /** Glyph/accent color; defaults per variant (green check, red x, packet accent). */
  color: hex.optional(),
  bg: hex.optional(),
});
export type Callout = z.infer<typeof calloutSchema>;

/** Built-in looks, learned from the reference reels the team studies. */
export const STYLE_PACKETS: readonly StylePacket[] = [
  {
    id: 'daily-vlog',
    name: 'Daily vlog',
    description: 'Day-in-my-life: quiet lowercase captions, a dreamy bed mixed low under narration, soft crossfades with the same gentle whoosh, frequent b-roll cutaways.',
    source: { creator: '@cocohdzz', url: 'https://www.instagram.com/reel/Da8snveyt1e/' },
    typography: {
      sizePct: 3.6, color: '#FFFFFF', strokeColor: '#000000', strokePx: 2,
      anchorPct: 78, emphasis: 'none', uppercase: false, karaoke: false,
    },
    colors: { accent: '#8B5CF6' },
    music: { soundId: 'sound-music-dream', volume: 0.22 },
    transition: { type: 'crossfade', duration: 0.4, soundId: 'sound-whoosh-soft', soundVolume: 0.4 },
    zoom: { cadence: 'sparse', scale: 1.06 },
    callouts: { density: 'off' },
    broll: { density: 'frequent' },
    pacing: { targetShotSeconds: 2.8 },
  },
  {
    id: 'branded-explainer',
    name: 'Branded explainer',
    description: 'Template-tight explainer: bold uppercase karaoke captions in one color system, hard cuts with a pop, punch-ins on emphasis, and check/x callouts punctuating nearly every line.',
    source: { creator: '@taliadoux', url: 'https://www.instagram.com/reel/Db3ZJ87AfIL/' },
    typography: {
      sizePct: 4.6, color: '#FFFFFF', emphasisColor: '#FACC15', strokeColor: '#000000', strokePx: 4,
      anchorPct: 58, emphasis: 'highlight', uppercase: true, karaoke: true,
    },
    colors: { accent: '#FACC15', good: '#39D98A', bad: '#FF5C70' },
    music: { soundId: 'sound-music-drive', volume: 0.15 },
    transition: { type: 'cut', duration: 0.3, soundId: 'sound-pop-bubble', soundVolume: 0.5 },
    zoom: { cadence: 'every-shot', scale: 1.1 },
    callouts: { density: 'every-line' },
    broll: { density: 'sparse' },
    pacing: { targetShotSeconds: 1.6 },
  },
];

export const PACKETS_BY_ID: ReadonlyMap<string, StylePacket> = new Map(STYLE_PACKETS.map((packet) => [packet.id, packet]));
