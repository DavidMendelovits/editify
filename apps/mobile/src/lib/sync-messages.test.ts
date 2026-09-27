import { describe, expect, it } from 'vitest';
import type { SyncAudioResult } from '@editify/shared';
import { describeSync } from './sync-messages';

function result(overrides: Partial<Extract<SyncAudioResult, { ok: true }>>): Extract<SyncAudioResult, { ok: true }> {
  return {
    ok: true, ops: [], version: 1, videoClipId: 'shot', offsetSec: 0, speed: 1, confidence: 12, pieces: 1, notes: [], ...overrides,
  };
}

describe('describeSync', () => {
  it('says which recorder started first, by how much', () => {
    // A negative offset means memo second 0 plays before the camera's first frame.
    expect(describeSync(result({ offsetSec: -21.98475 }))).toBe('Synced: the memo started 21.98s before the camera.');
    expect(describeSync(result({ offsetSec: 7.25 }))).toBe('Synced: the memo started 7.25s after the camera.');
  });

  it('does not report a sub-frame offset as a number', () => {
    expect(describeSync(result({ offsetSec: 0.002 }))).toBe('Synced: the memo and the camera already line up.');
  });

  it('mentions pieces only when the footage was cut', () => {
    expect(describeSync(result({ offsetSec: 3, pieces: 4 }))).toBe('Synced: the memo started 3.00s after the camera. Lined up across 4 clips.');
  });

  it('mentions drift only when a speed correction was applied', () => {
    expect(describeSync(result({ offsetSec: 3, speed: 1.00006, driftMs: -72 })))
      .toBe('Synced: the memo started 3.00s after the camera. Clock drift of 72ms corrected.');
    // Measured but not corrected (under a frame): nothing to tell the user.
    expect(describeSync(result({ offsetSec: 3, speed: 1, driftMs: -6 }))).toBe('Synced: the memo started 3.00s after the camera.');
  });
});
