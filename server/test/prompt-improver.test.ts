import { describe, expect, it } from 'vitest';
import { EDITING_PRESETS, OPERATION_CATALOG, projectFormatSchema, transitionSchema } from '@editify/shared';
import {
  IMPROVER_FORMATS, IMPROVER_OPERATIONS, IMPROVER_PRESETS, IMPROVER_SOUND_IDS,
  IMPROVER_TOOLS, IMPROVER_TRANSITIONS, improvePrompt,
} from '../src/agent/improve.js';
import { createToolRegistry } from '../src/agent/tools.js';
import { SOUND_LIBRARY_IDS } from '../src/media/sound-library.js';

describe('improvePrompt maps casual language to real operations', () => {
  it('turns "punchy" into the silence-trim pair', () => {
    const result = improvePrompt('make it punchy');
    expect(result?.improved).toContain('remove_silence');
    expect(result?.improved).toContain('close_gaps');
    expect(result?.changes).toContain('punchy/snappy → remove_silence + close_gaps');
  });

  it('names a real library sound for "that whoosh"', () => {
    const result = improvePrompt('add that whoosh on the cuts');
    expect(result?.improved).toContain('whoosh-fast');
    expect(result?.improved).toContain('add_clip');
  });

  it('prefers the specific variant when the user qualifies it', () => {
    expect(improvePrompt('put a soft whoosh there')?.improved).toContain('whoosh-soft');
    expect(improvePrompt('give me a tape stop before the drop')?.improved).toContain('riser-tape-stop');
  });

  it('maps "fade between" to a supported transition type', () => {
    const result = improvePrompt('fade between the shots');
    expect(result?.improved).toContain('crossfade');
    expect(result?.improved).not.toContain('wipe');
  });

  it('restructures a rambling multi-clause message into a numbered sequence', () => {
    const result = improvePrompt('make it punchy and add that whoosh and zoom in on the good part');
    expect(result?.improved).toContain('1. ');
    expect(result?.improved).toContain('2. ');
    expect(result?.improved).toContain('3. ');
    expect(result?.changes[0]).toBe('restructured into a numbered sequence of 3 operations');
  });

  it('appends an explicit scope clause when the target is vague', () => {
    expect(improvePrompt('make it snappy')?.changes).toContain('added an explicit scope clause');
    // A message that already names its target keeps the scope it was given.
    expect(improvePrompt('make the first clip snappy')?.changes).not.toContain('added an explicit scope clause');
  });

  it('returns null for a prompt that is already explicit', () => {
    expect(improvePrompt('Set a crossfade transition of 0.4s with set_transition on clip-b')).toBeNull();
    expect(improvePrompt('Run remove_silence on the timeline with padSeconds 0.15')).toBeNull();
    expect(improvePrompt('')).toBeNull();
  });
});

describe('layered follow-ups refine rather than reset', () => {
  it('restates a follow-up as a refinement of the previous instruction', () => {
    const previous = 'make it punchy';
    const result = improvePrompt('more of that but faster', previous);
    expect(result?.improved).toContain('Refine the previous instruction');
    expect(result?.improved).toContain(previous);
    expect(result?.changes).toContain('kept as a refinement of the previous instruction');
  });

  it('layers a new mapped operation onto the previous instruction', () => {
    const result = improvePrompt('also add a riser before the punchline', 'make it punchy');
    expect(result?.improved).toContain('Refine the previous instruction');
    expect(result?.improved).toContain('riser-sweep');
  });

  it('treats the same message as a fresh brief when there is no previous turn', () => {
    expect(improvePrompt('more of that')).toBeNull();
    expect(improvePrompt('make it punchy')?.improved).toContain('Original request');
  });
});

describe('the improver vocabulary exists in the real registries', () => {
  it('only names operation types the platform implements', () => {
    for (const operation of IMPROVER_OPERATIONS) {
      expect(OPERATION_CATALOG as readonly string[]).toContain(operation);
    }
  });

  it('only names agent tools the registry defines', () => {
    const tools = new Set(createToolRegistry().map((tool) => tool.name));
    for (const tool of IMPROVER_TOOLS) expect(tools).toContain(tool);
  });

  it('only names supported transition types', () => {
    const supported = transitionSchema.shape.type.options as readonly string[];
    expect([...IMPROVER_TRANSITIONS].sort()).toEqual([...supported].sort());
  });

  it('only names sounds the built-in library synthesizes', () => {
    for (const id of IMPROVER_SOUND_IDS) expect(SOUND_LIBRARY_IDS).toContain(id);
  });

  it('only names presets and formats that exist', () => {
    const presets = EDITING_PRESETS.map((preset) => preset.name) as readonly string[];
    for (const name of IMPROVER_PRESETS) expect(presets).toContain(name);
    for (const format of IMPROVER_FORMATS) expect(projectFormatSchema.options as readonly string[]).toContain(format);
  });

  it('never emits a term outside that vocabulary for a broad sweep of casual prompts', () => {
    const vocabulary = new Set<string>([
      ...IMPROVER_OPERATIONS, ...IMPROVER_TOOLS, ...IMPROVER_TRANSITIONS,
      ...IMPROVER_SOUND_IDS, ...IMPROVER_PRESETS, ...IMPROVER_FORMATS,
    ]);
    const casual = [
      'make it punchy', 'add that swoosh', 'boom on the hit', 'give it a riser',
      'fade between the shots', 'fade to black at the end', 'make it loud',
      'zoom in on the reaction', 'cut the dead air', 'make it a tiktok',
      'slow-mo that bit', 'cut to the beat', 'put captions on it', 'add a sticker',
      'stick some music under it', 'this is a stand-up set',
    ];
    for (const message of casual) {
      // Skip the first line: it quotes the user's own words back verbatim.
      const improved = (improvePrompt(message)?.improved ?? '').split('\n').slice(1).join('\n');
      // Every snake_case / hyphenated identifier the improver emits must be known.
      for (const token of improved.match(/\b[a-z]+(?:[_-][a-z0-9]+)+\b/g) ?? []) {
        expect(vocabulary.has(token), `${token} (from "${message}") is not in the improver vocabulary`).toBe(true);
      }
    }
  });
});
