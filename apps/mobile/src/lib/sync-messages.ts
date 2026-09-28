import type { SyncAudioResult } from '@editify/shared';

/** Under a frame at 60fps: "0.00s after the camera" would read as a glitch, not a result. */
const ALREADY_LINED_UP_SECONDS = 1 / 120;

/** The line the Inspector shows under a clip once its sync has been applied. */
export function describeSync(result: Extract<SyncAudioResult, { ok: true }>): string {
  const offset = Math.abs(result.offsetSec);
  const lead = offset < ALREADY_LINED_UP_SECONDS
    ? 'the memo and the camera already line up'
    : `the memo started ${offset.toFixed(2)}s ${result.offsetSec < 0 ? 'before' : 'after'} the camera`;
  const pieces = result.pieces > 1 ? ` Lined up across ${result.pieces} clips.` : '';
  const drift = result.speed !== 1 && result.driftMs !== undefined ? ` Clock drift of ${Math.abs(result.driftMs)}ms corrected.` : '';
  return `Synced: ${lead}.${pieces}${drift}`;
}
