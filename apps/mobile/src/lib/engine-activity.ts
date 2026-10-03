import { useEffect } from 'react';
import { EditifyEngine } from '../../modules/editify-engine';
import { ActivityHolds, type ActivityKind } from './activity-holds';

/**
 * One counter for every toggle this JS context sends: the calls aren't awaited in order,
 * so the native side keeps the newest sequence per control and drops older ones (a late
 * "true" must not undo the "false" that followed it). Native resets it with each new context.
 */
let sequence = 0;

/**
 * Several parts of a screen can hold the same flag at once (the editor's play/scrub state
 * and the native preview's handle drags both hold `playback`): native hears true when the
 * first holder starts and false when the last one stops.
 */
const holds = new ActivityHolds((kind, value) => {
  const engine = EditifyEngine;
  if (!engine) return;
  sequence += 1;
  const sent = kind === 'playback' ? engine.setPlaybackActive(value, sequence) : engine.setExportActive(value, sequence);
  void sent.catch(() => undefined);
});

/**
 * Tells the device engine the user is playing/scrubbing, or exporting, so its heavy
 * work gets out of the way (decision 8A, OV9): words and faces pause, and a preview
 * proxy being written is cancelled and only restarted once things have been idle for
 * a few seconds (the debounce is native). Clears itself when `active` turns false or
 * the screen unmounts. A no-op without the engine (web, Android).
 */
export function useEngineActivity(kind: ActivityKind, active: boolean): void {
  useEffect(() => {
    if (!EditifyEngine || !active) return undefined;
    return holds.hold(kind);
  }, [kind, active]);
}
