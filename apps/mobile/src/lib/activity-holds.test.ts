import { describe, expect, it } from 'vitest';
import { ActivityHolds } from './activity-holds';

describe('ActivityHolds', () => {
  it('sends true for the first holder and false only when the last one lets go', () => {
    const sent: string[] = [];
    const holds = new ActivityHolds((kind, value) => sent.push(`${kind}:${value}`));
    const playing = holds.hold('playback');
    const dragging = holds.hold('playback');
    expect(sent).toEqual(['playback:true']);
    playing();
    expect(sent).toEqual(['playback:true']);
    playing(); // idempotent: a second release doesn't steal the drag's hold
    expect(holds.count('playback')).toBe(1);
    dragging();
    expect(sent).toEqual(['playback:true', 'playback:false']);
    expect(holds.count('playback')).toBe(0);
  });

  it('counts each kind on its own', () => {
    const sent: string[] = [];
    const holds = new ActivityHolds((kind, value) => sent.push(`${kind}:${value}`));
    const playback = holds.hold('playback');
    const exporting = holds.hold('export');
    playback();
    expect(sent).toEqual(['playback:true', 'export:true', 'playback:false']);
    exporting();
    expect(sent.at(-1)).toBe('export:false');
  });
});
