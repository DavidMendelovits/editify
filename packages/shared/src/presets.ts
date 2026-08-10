import { z } from 'zod';

const rangeSchema = z.object({ min: z.number(), target: z.number(), max: z.number() });

export const presetSchema = z.object({
  name: z.enum(['talking_head_punchy', 'standup_clip', 'sketch_multicam', 'vlog_montage', 'podcast_clip_loop']),
  description: z.string().min(1),
  targetContent: z.array(z.string().min(1)).min(1),
  targetDurationSec: z.tuple([z.number().positive(), z.number().positive()]),
  maxShotSeconds: z.number().positive(),
  hook: z.object({ strategy: z.string().min(1) }),
  silenceTrim: z.object({
    enabled: z.boolean(),
    minSilenceSeconds: z.number().min(0),
    padSeconds: z.number().min(0),
    protectLoudGaps: z.boolean(),
    protectRegions: z.array(z.object({
      type: z.string().min(1),
      policy: z.string().min(1),
      beforeSec: z.number().min(0).optional(),
    })).default([]),
  }),
  captions: z.object({
    wordsPerChunk: rangeSchema,
    chunkDurationSec: rangeSchema,
    maxCharsPerSecond: z.number().positive(),
    verticalAnchorPct: z.number().min(0).max(100),
    safeAreaBottomPct: z.number().min(0).max(100),
    safeAreaTopPct: z.number().min(0).max(100),
    safeAreaRightPct: z.number().min(0).max(100),
    fontSizePct: z.number().positive(),
    uppercase: z.boolean(),
    fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    strokePx: z.number().min(0),
    strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    emphasisColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    emphasisMode: z.enum(['active_word_highlight', 'keyword_highlight']),
  }),
  punchIn: z.object({
    enabled: z.boolean(),
    alternateScalePct: z.number().positive().optional(),
    everyNCuts: z.number().int().positive().optional(),
    minHoldSeconds: z.number().positive().optional(),
  }),
  ending: z.object({ type: z.string().min(1) }),
  rationale: z.string().min(1),
});

export type EditingPreset = z.infer<typeof presetSchema>;
export type PresetName = EditingPreset['name'];

export const EDITING_PRESETS = [
  {
    name: 'talking_head_punchy',
    description: 'Straight-to-camera take with silence-trimmed jump cuts and restrained alternating punch-ins.',
    targetContent: ['talking_head', 'advice', 'rant'], targetDurationSec: [21, 34], maxShotSeconds: 5,
    hook: { strategy: 'pull_highest_energy_window_to_front' },
    silenceTrim: { enabled: true, minSilenceSeconds: 0.2, padSeconds: 0.2, protectLoudGaps: false, protectRegions: [] },
    captions: { wordsPerChunk: { min: 3, target: 4, max: 7 }, chunkDurationSec: { min: 0.83, target: 2, max: 3 }, maxCharsPerSecond: 17, verticalAnchorPct: 62, safeAreaBottomPct: 22, safeAreaTopPct: 12, safeAreaRightPct: 17, fontSizePct: 7.2, uppercase: false, fill: '#FFFFFF', strokePx: 6, strokeColor: '#000000', emphasisColor: '#FACC15', emphasisMode: 'active_word_highlight' },
    punchIn: { enabled: true, alternateScalePct: 112, everyNCuts: 2, minHoldSeconds: 1.5 },
    ending: { type: 'hard_cut_on_last_stressed_syllable' },
    rationale: '21-34 seconds is the strongest completion band; 5 seconds is the static-shot ceiling; 0.2 second trim margins preserve speech onsets.',
  },
  {
    name: 'standup_clip',
    description: 'Stand-up cut that tightens setup while protecting pre-punch pauses and audience reactions.',
    targetContent: ['standup', 'crowd_work'], targetDurationSec: [15, 45], maxShotSeconds: 6,
    hook: { strategy: 'open_on_setup_line_preceding_biggest_laugh' },
    silenceTrim: { enabled: true, minSilenceSeconds: 0.6, padSeconds: 0.3, protectLoudGaps: true, protectRegions: [{ type: 'pre_punchline', beforeSec: 1.2, policy: 'never_trim' }, { type: 'laugh', policy: 'trim_to_peak_plus_0.4s' }] },
    captions: { wordsPerChunk: { min: 2, target: 3, max: 5 }, chunkDurationSec: { min: 0.83, target: 1.6, max: 3 }, maxCharsPerSecond: 17, verticalAnchorPct: 65, safeAreaBottomPct: 22, safeAreaTopPct: 12, safeAreaRightPct: 17, fontSizePct: 6.5, uppercase: false, fill: '#FFFFFF', strokePx: 6, strokeColor: '#000000', emphasisColor: '#FACC15', emphasisMode: 'active_word_highlight' },
    punchIn: { enabled: true, alternateScalePct: 110, everyNCuts: 3, minHoldSeconds: 2 },
    ending: { type: 'hard_cut_on_laugh_peak' },
    rationale: 'Comedy tolerates longer holds; a 0.6 second silence floor and loud-gap protection preserve timing and laughter, while captions reveal words only as spoken.',
  },
  {
    name: 'sketch_multicam',
    description: 'Scripted multi-angle comedy cut for performance beats and post-punch reactions.',
    targetContent: ['sketch', 'skit', 'character_bit'], targetDurationSec: [20, 60], maxShotSeconds: 4,
    hook: { strategy: 'cold_open_on_first_line_of_conflict' },
    silenceTrim: { enabled: true, minSilenceSeconds: 0.35, padSeconds: 0.25, protectLoudGaps: true, protectRegions: [{ type: 'beat_pause', policy: 'never_trim' }] },
    captions: { wordsPerChunk: { min: 2, target: 4, max: 6 }, chunkDurationSec: { min: 0.83, target: 1.8, max: 3 }, maxCharsPerSecond: 17, verticalAnchorPct: 60, safeAreaBottomPct: 22, safeAreaTopPct: 12, safeAreaRightPct: 17, fontSizePct: 6.5, uppercase: false, fill: '#FFFFFF', strokePx: 6, strokeColor: '#000000', emphasisColor: '#FACC15', emphasisMode: 'active_word_highlight' },
    punchIn: { enabled: false }, ending: { type: 'hard_cut_on_reaction' },
    rationale: 'Dialogue exchanges support roughly two-second shots; performance pauses stay protected and real angle changes replace synthetic zoom variety.',
  },
  {
    name: 'vlog_montage',
    description: 'Music-led day-in-the-life montage with brisk shots and short uppercase caption bursts.',
    targetContent: ['vlog', 'bts', 'process'], targetDurationSec: [20, 40], maxShotSeconds: 3,
    hook: { strategy: 'highest_motion_2s_to_front' },
    silenceTrim: { enabled: true, minSilenceSeconds: 0.3, padSeconds: 0.15, protectLoudGaps: false, protectRegions: [] },
    captions: { wordsPerChunk: { min: 2, target: 3, max: 5 }, chunkDurationSec: { min: 0.83, target: 1.5, max: 2.5 }, maxCharsPerSecond: 17, verticalAnchorPct: 58, safeAreaBottomPct: 22, safeAreaTopPct: 12, safeAreaRightPct: 17, fontSizePct: 6, uppercase: true, fill: '#FFFFFF', strokePx: 5, strokeColor: '#000000', emphasisColor: '#EC4899', emphasisMode: 'active_word_highlight' },
    punchIn: { enabled: true, alternateScalePct: 108, everyNCuts: 4, minHoldSeconds: 1.2 }, ending: { type: 'loop_back' },
    rationale: 'Montage footage binds to the 2-3 second visual-change rule; compact uppercase bursts remain readable and the ending is designed to loop.',
  },
  {
    name: 'podcast_clip_loop',
    description: 'Long-form interview excerpt with a self-contained hook, face-biased crop, and loop-friendly ending.',
    targetContent: ['podcast', 'interview', 'long_form_excerpt'], targetDurationSec: [20, 25], maxShotSeconds: 5,
    hook: { strategy: 'score_candidate_windows_then_open_on_winner' },
    silenceTrim: { enabled: true, minSilenceSeconds: 0.25, padSeconds: 0.2, protectLoudGaps: false, protectRegions: [] },
    captions: { wordsPerChunk: { min: 3, target: 4, max: 7 }, chunkDurationSec: { min: 0.83, target: 2, max: 3 }, maxCharsPerSecond: 17, verticalAnchorPct: 60, safeAreaBottomPct: 22, safeAreaTopPct: 12, safeAreaRightPct: 17, fontSizePct: 6.5, uppercase: false, fill: '#FFFFFF', strokePx: 6, strokeColor: '#000000', emphasisColor: '#8B5CF6', emphasisMode: 'keyword_highlight' },
    punchIn: { enabled: true, alternateScalePct: 112, everyNCuts: 2, minHoldSeconds: 2 }, ending: { type: 'loop_back' },
    rationale: 'The 20-25 second band favors completion and looping; five-second shot caps and four-word captions keep a static interview visually active.',
  },
] as const satisfies readonly EditingPreset[];

export const PRESETS_BY_NAME: Readonly<Record<PresetName, EditingPreset>> = Object.fromEntries(
  EDITING_PRESETS.map((preset) => [preset.name, presetSchema.parse(preset)]),
) as Record<PresetName, EditingPreset>;
