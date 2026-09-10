/**
 * Prompt improver (GitHub #19).
 *
 * Creators describe edits by feeling — "make it punchy", "add that whoosh" —
 * and the agent has to guess which operation, transition or sound was meant.
 * This rewrites the message into an explicit instruction *before* it is sent,
 * using a fixed rule table rather than a second model call: a deterministic
 * rewriter can be tested, is instant, and — critically for the issue's own
 * acceptance criterion — can never invent a transition, effect or sound the
 * platform does not have, because every term it can emit is listed below and
 * asserted against the real registries in server/test/prompt-improver.test.ts.
 */

/** Operation types the improver may name — a subset of shared's OPERATION_CATALOG. */
export const IMPROVER_OPERATIONS = [
  'add_clip', 'trim_clip', 'set_volume', 'set_speed', 'set_transform',
  'set_overlay', 'set_transition', 'add_caption', 'ripple_delete_ranges', 'set_format',
] as const;

/** Agent tool names the improver may name — must exist in createToolRegistry(). */
export const IMPROVER_TOOLS = [
  'remove_silence', 'close_gaps', 'cut_to_beats', 'caption_clip_from_transcript', 'remove_words',
] as const;

/** Transition types — must match shared's transitionSchema enum. */
export const IMPROVER_TRANSITIONS = ['crossfade', 'dip'] as const;

/** Library sound ids — must match the recipes in media/sound-library.ts. */
export const IMPROVER_SOUND_IDS = [
  'whoosh-soft', 'whoosh-fast', 'impact-boom', 'impact-hit', 'pop-bubble', 'pop-double',
  'ui-click', 'ui-ding', 'riser-sweep', 'riser-tape-stop', 'music-drive', 'music-dream',
] as const;

/** Preset names — must match shared's presetSchema enum. */
export const IMPROVER_PRESETS = [
  'talking_head_punchy', 'standup_clip', 'sketch_multicam', 'vlog_montage', 'podcast_clip_loop',
] as const;

/** Project formats — must match shared's projectFormatSchema enum. */
export const IMPROVER_FORMATS = ['9:16', '1:1', '16:9'] as const;

interface Rule {
  /** Casual phrasing that triggers this mapping. */
  test: RegExp;
  /** Only one rule per group fires, so "soft whoosh" does not also add the fast one. */
  group?: string;
  /** The explicit instruction this clause becomes. */
  clause: string;
  /** Human-readable "we changed this" line for the preview card. */
  change: string;
}

/**
 * Order matters twice over: the more specific variant of a sound or effect has
 * to sit above its generic sibling, and the emitted clauses come out in this
 * order when a rambling message is restructured into a sequence.
 */
const RULES: Rule[] = [
  {
    test: /\bdead air\b|\bdead space\b|\bcut the pauses\b|\bremove (the )?silence|\bsilent bits\b|\bums?\b|\bawkward pauses?\b/i,
    group: 'silence',
    clause: 'Run remove_silence over the timeline with padSeconds 0.15 and protectLoudGaps on, then close_gaps to repack the track.',
    change: 'dead air → remove_silence + close_gaps',
  },
  {
    test: /\bpunchy\b|\bsnappy\b|\btighten\b|\btighter\b|\bkeep it moving\b|\bno fat\b/i,
    group: 'silence',
    clause: 'Run remove_silence with padSeconds 0.15 to trim the gaps between words, then close_gaps to repack the track.',
    change: 'punchy/snappy → remove_silence + close_gaps',
  },
  {
    test: /\bsoft whoosh\b|\bgentle (whoosh|swoosh)\b|\bsubtle (whoosh|swoosh)\b/i,
    group: 'whoosh',
    clause: 'Add the whoosh-soft library sound with add_clip on the audio track at each cut.',
    change: 'soft whoosh → whoosh-soft library sound (add_clip)',
  },
  {
    test: /\bwhoosh\b|\bswoosh\b|\bswish\b/i,
    group: 'whoosh',
    clause: 'Add the whoosh-fast library sound with add_clip on the audio track at each cut.',
    change: 'whoosh → whoosh-fast library sound (add_clip)',
  },
  {
    test: /\bhard hit\b|\bsmack\b|\bstab\b|\bimpact hit\b/i,
    group: 'impact',
    clause: 'Add the impact-hit library sound with add_clip on the audio track on the accent.',
    change: 'hard hit → impact-hit library sound (add_clip)',
  },
  {
    test: /\bboom\b|\bimpact\b|\bbass drop\b|\bthump\b/i,
    group: 'impact',
    clause: 'Add the impact-boom library sound with add_clip on the audio track on the accent.',
    change: 'boom → impact-boom library sound (add_clip)',
  },
  {
    test: /\btape stop\b|\brewind\b|\bscratch\b/i,
    group: 'riser',
    clause: 'Add the riser-tape-stop library sound with add_clip on the audio track leading into the beat.',
    change: 'tape stop → riser-tape-stop library sound (add_clip)',
  },
  {
    test: /\briser\b|\bbuild ?-?up\b|\bbuilds? up\b|\bswell\b/i,
    group: 'riser',
    clause: 'Add the riser-sweep library sound with add_clip on the audio track leading into the beat.',
    change: 'riser/build-up → riser-sweep library sound (add_clip)',
  },
  {
    test: /\bdouble (pop|blip|beep)\b|\bblip blip\b/i,
    group: 'pop',
    clause: 'Add the pop-double library sound with add_clip on the audio track on the beat.',
    change: 'double blip → pop-double library sound (add_clip)',
  },
  {
    test: /\bpop\b|\bblip\b|\bbubble\b/i,
    group: 'pop',
    clause: 'Add the pop-bubble library sound with add_clip on the audio track on the beat.',
    change: 'pop → pop-bubble library sound (add_clip)',
  },
  {
    test: /\bding\b|\bchime\b|\bbell\b|\bnotification sound\b/i,
    group: 'ui',
    clause: 'Add the ui-ding library sound with add_clip on the audio track on the beat.',
    change: 'ding → ui-ding library sound (add_clip)',
  },
  {
    test: /\bclick(y)?\b|\btick\b|\bblip sound\b/i,
    group: 'ui',
    clause: 'Add the ui-click library sound with add_clip on the audio track on the beat.',
    change: 'click → ui-click library sound (add_clip)',
  },
  {
    test: /\bdreamy\b|\bchill\b|\bambient\b|\bmellow\b|\bsoft music\b/i,
    group: 'music',
    clause: 'Bed the music-dream library track under the video with add_clip on the audio track.',
    change: 'dreamy/chill → music-dream library track (add_clip)',
  },
  {
    test: /\b(background |bg )?music\b|\bsoundtrack\b|\bbeat under\b|\bbanger\b/i,
    group: 'music',
    clause: 'Bed the music-drive library track under the video with add_clip on the audio track.',
    change: 'music → music-drive library track (add_clip)',
  },
  {
    test: /\bfade (to|through) black\b|\bdip to black\b|\bblink to black\b/i,
    group: 'transition',
    clause: 'Set a dip transition of 0.4s with set_transition on the incoming clip.',
    change: 'fade to black → set_transition type "dip"',
  },
  {
    test: /\bfade between\b|\bdissolve\b|\bblend (the )?(clips|cuts|shots)\b|\bsmooth (transition|cut)\b|\bease between\b/i,
    group: 'transition',
    clause: 'Set a crossfade transition of 0.4s with set_transition on each incoming clip.',
    change: 'fade between → set_transition type "crossfade"',
  },
  {
    test: /\bzoom in\b|\bpunch ?-?in\b|\bpunch in\b|\bget closer\b|\bcloser on\b|\btighter framing\b/i,
    group: 'transform',
    clause: 'Apply a punch in with set_transform at scale 112 on the emphasised clip.',
    change: 'zoom in → set_transform (scale 112)',
  },
  {
    test: /\b(make it|turn it|turn the (audio|volume)) (way )?louder\b|\bmake it loud\b|\bboost the (audio|volume|sound)\b|\bcrank it\b/i,
    group: 'volume',
    clause: 'Raise the clip audio with set_volume to 1.4.',
    change: 'make it loud → set_volume 1.4',
  },
  {
    test: /\bquieter\b|\bturn it down\b|\bduck the (music|audio)\b|\blower the (volume|music)\b/i,
    group: 'volume',
    clause: 'Lower the clip audio with set_volume to 0.4.',
    change: 'quieter → set_volume 0.4',
  },
  {
    test: /\bslow ?-?mo\b|\bslow motion\b|\bslow it down\b/i,
    group: 'speed',
    clause: 'Slow the clip with set_speed to 0.5.',
    change: 'slow-mo → set_speed 0.5',
  },
  {
    test: /\bspeed (it|this) up\b|\bfaster\b|\bsped ?-?up\b|\bhyperlapse\b/i,
    group: 'speed',
    clause: 'Speed the clip up with set_speed to 1.5.',
    change: 'speed up → set_speed 1.5',
  },
  {
    test: /\bcut (to|on) the (beat|music|rhythm)\b|\bon beat\b|\bmontage\b/i,
    group: 'beats',
    clause: 'Split the clip on its measured onsets with cut_to_beats so the cuts land on the beat.',
    change: 'cut on the beat → cut_to_beats',
  },
  {
    test: /\bcaptions?\b|\bsubtitles?\b|\btext on screen\b|\bwords on screen\b/i,
    group: 'captions',
    clause: 'Caption every video clip with caption_clip_from_transcript at wordsPerChunk 3, then adjust styling with add_caption if a look is named.',
    change: 'captions → caption_clip_from_transcript (+ add_caption)',
  },
  {
    test: /\bsticker\b|\bemoji\b|\blogo\b|\boverlay\b|\bwatermark\b/i,
    group: 'overlay',
    clause: 'Place the graphic with set_overlay on the clip that should carry it.',
    change: 'sticker/logo → set_overlay',
  },
  {
    test: /\bcut (that|this|it) (bit|part|out)\b|\bremove that (bit|part)\b|\bget rid of\b|\bdrop the (bit|part)\b/i,
    group: 'delete',
    clause: 'Remove the named span with ripple_delete_ranges (or remove_words when it is easier to name by the words said) so the rest of the timeline pulls up.',
    change: 'cut that bit → ripple_delete_ranges / remove_words',
  },
  {
    test: /\btiktok\b|\breels?\b|\bshorts?\b|\bvertical\b/i,
    group: 'format',
    clause: 'Set the project to the 9:16 format with set_format and follow the talking_head_punchy preset.',
    change: 'tiktok/reels → set_format "9:16" + talking_head_punchy preset',
  },
  {
    test: /\bwidescreen\b|\byoutube\b|\bhorizontal\b|\blandscape\b/i,
    group: 'format',
    clause: 'Set the project to the 16:9 format with set_format.',
    change: 'widescreen/youtube → set_format "16:9"',
  },
  {
    test: /\bsquare\b|\bfeed post\b/i,
    group: 'format',
    clause: 'Set the project to the 1:1 format with set_format.',
    change: 'square → set_format "1:1"',
  },
  {
    test: /\bstand ?-?up\b|\bcrowd work\b|\bcomedy set\b/i,
    group: 'preset',
    clause: 'Follow the standup_clip preset, which protects the pauses before a punchline and the audience laughter.',
    change: 'stand-up → standup_clip preset',
  },
  {
    test: /\bsketch\b|\bskit\b|\bmulticam\b/i,
    group: 'preset',
    clause: 'Follow the sketch_multicam preset for performance beats and the reactions after a punch.',
    change: 'sketch → sketch_multicam preset',
  },
  {
    test: /\bvlog\b|\btravel (video|edit)\b/i,
    group: 'preset',
    clause: 'Follow the vlog_montage preset.',
    change: 'vlog → vlog_montage preset',
  },
  {
    test: /\bpodcast\b|\binterview clip\b/i,
    group: 'preset',
    clause: 'Follow the podcast_clip_loop preset.',
    change: 'podcast → podcast_clip_loop preset',
  },
];

/** Any of these means the user already said which clip/track/range they mean. */
const EXPLICIT_SCOPE = /\bclip-|\bclips?\b|\btrack\b|\bfirst\b|\blast\b|\bevery\b|\beach\b|\ball of\b|\bwhole\b|\bentire\b|\bintro\b|\boutro\b|\bending\b|\bhook\b|\b\d+\s?(s|sec|secs|seconds?|m|min|minutes?)\b|\b\d+:\d{2}\b/i;

/** A message that reads as "keep going from the last one" rather than a fresh brief. */
const REFINEMENT = /^(more of that\b|more\b|again\b|also\b|now\b|and\b|then\b|but\b|same but\b|do it again\b)|\bmake it (shorter|longer|faster|slower|louder|quieter|punchier)\b|\ba bit more\b|\bless of that\b/i;

const SCOPE_CLAUSE = 'Scope: apply this to every clip on the main video track in timeline order, and leave each resulting operation as its own editable timeline item.';

export interface PromptImprovement {
  improved: string;
  /** One line per mapping applied, shown in the preview card. */
  changes: string[];
}

/**
 * Rewrites `message` into an explicit editing instruction, or returns null when
 * there is nothing to add — an already-technical prompt must pass through
 * untouched so the preview card never gets in the way.
 *
 * `previous` is the user's last message: when this one reads as a follow-up
 * ("more of that", "also add a riser"), the rewrite is phrased as a refinement
 * of that instruction instead of a fresh brief, which is what keeps layered
 * editing from resetting context.
 */
export function improvePrompt(message: string, previous?: string): PromptImprovement | null {
  const text = message.trim();
  if (!text) return null;

  const seenGroups = new Set<string>();
  const clauses: string[] = [];
  const changes: string[] = [];
  for (const rule of RULES) {
    if (rule.group && seenGroups.has(rule.group)) continue;
    if (!rule.test.test(text)) continue;
    // Nothing to translate if the user already typed the technical term we
    // would have introduced — that prompt is explicit as it stands.
    if (namedTerms(rule.clause).some((term) => text.toLowerCase().includes(term))) {
      if (rule.group) seenGroups.add(rule.group);
      continue;
    }
    if (rule.group) seenGroups.add(rule.group);
    clauses.push(rule.clause);
    changes.push(rule.change);
  }

  const refining = Boolean(previous?.trim()) && REFINEMENT.test(text);
  if (clauses.length === 0 && !refining) return null;

  if (clauses.length > 1) changes.unshift(`restructured into a numbered sequence of ${clauses.length} operations`);
  const vagueScope = !EXPLICIT_SCOPE.test(text);
  if (vagueScope) changes.push('added an explicit scope clause');

  const body = clauses.length > 1
    ? clauses.map((clause, index) => `${index + 1}. ${clause}`).join('\n')
    : (clauses[0] ?? `Keep the previous instruction and adjust it: ${text}`);

  const head = refining
    ? `Refine the previous instruction ("${previous?.trim()}") rather than starting a new edit: keep everything it produced and layer this on top:`
    : `Original request: "${text}". Do this:`;
  if (refining) changes.unshift('kept as a refinement of the previous instruction');

  const improved = [head, body, vagueScope ? SCOPE_CLAUSE : ''].filter(Boolean).join('\n');
  return { improved, changes };
}

/** The technical terms a clause introduces, used to detect already-explicit prompts. */
function namedTerms(clause: string): string[] {
  const vocabulary = [
    ...IMPROVER_OPERATIONS, ...IMPROVER_TOOLS, ...IMPROVER_TRANSITIONS,
    ...IMPROVER_SOUND_IDS, ...IMPROVER_PRESETS, ...IMPROVER_FORMATS,
  ];
  return vocabulary.filter((term) => clause.includes(term)).map((term) => term.toLowerCase());
}
