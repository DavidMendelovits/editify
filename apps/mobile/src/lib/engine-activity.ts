import { useEffect } from 'react';
import { EditifyEngine } from '../../modules/editify-engine';

/**
 * Tells the device engine the user is playing/scrubbing, or exporting, so its heavy
 * work gets out of the way (decision 8A, OV9): words and faces pause, and a preview
 * proxy being written is cancelled and only restarted once things have been idle for
 * a few seconds (the debounce is native). Clears itself when `active` turns false or
 * the screen unmounts. A no-op without the engine (web, Android).
 */
export function useEngineActivity(kind: 'playback' | 'export', active: boolean): void {
  useEffect(() => {
    const engine = EditifyEngine;
    if (!engine || !active) return undefined;
    const set = (value: boolean): Promise<void> =>
      kind === 'playback' ? engine.setPlaybackActive(value) : engine.setExportActive(value);
    void set(true).catch(() => undefined);
    return () => { void set(false).catch(() => undefined); };
  }, [kind, active]);
}
