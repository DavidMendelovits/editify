import { describe, expect, it } from 'vitest';
import { ALL_TOOL_NEEDS, createToolRegistry, toolsFor, type ToolNeed } from '../src/agent/tools.js';

describe('tool capability contract', () => {
  it('offers every tool when every need is available (today\'s chat turn)', () => {
    expect(toolsFor(ALL_TOOL_NEEDS).map((tool) => tool.name)).toEqual(createToolRegistry().map((tool) => tool.name));
  });

  it('leaves media-bound tools out of a stateless turn built from the phone\'s analysis', () => {
    // What a device snapshot can carry (plan P3): words, loudness, the pairwise sync result.
    const snapshot = new Set<ToolNeed>(['assets', 'transcripts', 'energy', 'sync']);
    const offered = new Set(toolsFor(snapshot).map((tool) => tool.name));
    for (const name of ['dissect_asset', 'cut_to_beats', 'apply_style_packet', 'get_render_qa', 'get_insights']) {
      expect(offered.has(name)).toBe(false);
    }
    for (const name of ['remove_silence', 'remove_words', 'caption_clip_from_transcript', 'place_captions', 'sync_audio', 'split_clip', 'add_clips']) {
      expect(offered.has(name)).toBe(true);
    }
  });

  it('keeps the pure tools when nothing but the project is available', () => {
    const offered = toolsFor(new Set()).map((tool) => tool.name);
    expect(offered).toContain('get_project');
    expect(offered).toContain('split_clip');
    expect(offered).not.toContain('get_transcript');
  });
});
