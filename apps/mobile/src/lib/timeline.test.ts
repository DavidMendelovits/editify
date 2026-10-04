import { describe, expect, it } from 'vitest';
import { playheadStart } from './timeline';

describe('playheadStart', () => {
  it('starts on or before the frame on screen, in whole milliseconds', () => {
    // Frame 320 at 30 fps is 10.6667 s; rounding up to 10.667 would start on frame 321.
    for (const time of [320 / 30, 10.667, 10.6668]) {
      const start = playheadStart(time, 30);
      expect(start).toBe(10.666);
      // Drawn on frame 320 ([start, end) against t = k / fps) and not on 319.
      expect(320 / 30 >= start).toBe(true);
      expect(319 / 30 >= start).toBe(false);
    }
    expect(playheadStart(1, 30)).toBe(1);
    expect(playheadStart(2.5, 24)).toBe(2.5);
    expect(playheadStart(-0.2, 30)).toBe(0);
  });
});
