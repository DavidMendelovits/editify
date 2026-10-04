import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModalPresence, deferredVisible, MODAL_SETTLE_MS } from './modal-presence';

describe('the speech sheet waits for other sheets (modal presence)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('defers the wanted sheet while another is up and shows it once that one has gone and settled', () => {
    const presence = createModalPresence();
    const changes: boolean[] = [];
    presence.subscribe(() => changes.push(presence.busy()));
    const visible = (): boolean => deferredVisible(true, presence.busy());

    expect(visible()).toBe(true); // nothing up: shows at once
    const closeImport = presence.open(); // ImportSheet, open through the upload
    expect(visible()).toBe(false);
    closeImport(); // dismissed: still animating away
    expect(visible()).toBe(false);
    vi.advanceTimersByTime(MODAL_SETTLE_MS - 1);
    expect(visible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(visible()).toBe(true);
    expect(changes).toEqual([true, false]);
  });

  it('counts nested sheets, ignores a double release, and restarts the wait if one reopens while settling', () => {
    const presence = createModalPresence({ settleMs: 100 });
    const closeImport = presence.open();
    const closeSound = presence.open();
    closeImport();
    closeImport();
    expect(presence.busy()).toBe(true); // SoundSheet still up
    closeSound();
    vi.advanceTimersByTime(50);
    const reopened = presence.open();
    vi.advanceTimersByTime(100);
    expect(presence.busy()).toBe(true);
    reopened();
    vi.advanceTimersByTime(100);
    expect(presence.busy()).toBe(false);
  });

  it('never shows a sheet the flow did not ask for', () => {
    expect(deferredVisible(false, false)).toBe(false);
    expect(deferredVisible(false, true)).toBe(false);
  });
});
