import { describe, expect, it } from 'vitest';
// ponytail: the client has no test runner of its own, so this pure summarizer
// is exercised from the server's vitest rather than adding one to apps/mobile.
import { editSummary } from '../../apps/mobile/src/lib/agent.js';

describe('editSummary', () => {
  it('digests standing assistant edits and drops reverted turns', () => {
    expect(editSummary([
      { role: 'user' },
      {
        role: 'assistant',
        ops: [
          { type: 'split_clip', params: { at: 1 } },
          { type: 'split_clip', params: { at: 2 } },
          { type: 'ripple_delete_ranges', params: { ranges: [{ start: 0, end: 1 }, { start: 4, end: 5 }] } },
          { type: 'add_caption', params: {} },
          { type: 'set_transform', params: {} },
          { type: 'undo', params: {} },
        ],
      },
      { role: 'assistant', reverted: true, ops: [{ type: 'split_clip', params: { at: 9 } }] },
    ])).toEqual([
      'Made 2 cuts to tighten pacing',
      'Removed 2 sections',
      'Added captions (1)',
      'Added 1 zoom-in on the action',
    ]);
  });

  it('summarises an untouched project as nothing', () => {
    expect(editSummary([{ role: 'user' }, { role: 'assistant', ops: [] }])).toEqual([]);
  });
});
