import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/**
 * The playhead lives outside React state: it changes ~60 times a second, and
 * routing that through a `useState` in the editor screen re-rendered the whole
 * editor — timeline lanes, filmstrips, chat — on every frame. Components that
 * actually paint the playhead subscribe to this instead; everyone else reads it
 * imperatively with `get()` inside event handlers.
 */
export interface PlayheadClock {
  get: () => number;
  subscribe: (listener: () => void) => () => void;
}

export interface Playback {
  clock: PlayheadClock;
  playing: boolean;
  seek: (time: number) => void;
  toggle: () => void;
  stop: () => void;
}

/** Per-frame playhead, for the few leaves that draw it. */
export function usePlayhead(clock: PlayheadClock): number {
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get);
}

/**
 * A derived value of the playhead. The selector runs on every tick but only
 * re-renders when its result actually changes, so coarse state (is the playhead
 * inside the selected clip?) costs nothing per frame.
 */
export function usePlayheadSelector<T>(clock: PlayheadClock, select: (playhead: number) => T): T {
  const snapshot = useCallback(() => select(clock.get()), [clock, select]);
  return useSyncExternalStore(clock.subscribe, snapshot, snapshot);
}

/**
 * The transport clock. The playhead — not the video element — is the source of
 * truth for timeline playback: it advances on wall-clock time inside a
 * requestAnimationFrame loop, so gaps between clips keep running and the
 * preview only has to follow. Playback stops at the end of the project.
 */
export function usePlayback(duration: number): Playback {
  const [playing, setPlaying] = useState(false);
  const store = useRef({ position: 0, listeners: new Set<() => void>() }).current;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const clock = useMemo<PlayheadClock>(() => ({
    get: () => store.position,
    subscribe: (listener) => {
      store.listeners.add(listener);
      return () => { store.listeners.delete(listener); };
    },
  }), [store]);

  const publish = useCallback((time: number): void => {
    store.position = time;
    for (const listener of store.listeners) listener();
  }, [store]);

  const seek = useCallback((time: number) => {
    publish(Math.max(0, Math.min(time, Math.max(0, durationRef.current))));
  }, [publish]);

  const toggle = useCallback(() => {
    setPlaying((current) => {
      if (current) return false;
      if (store.position >= durationRef.current - 0.02) seek(0);
      return durationRef.current > 0;
    });
  }, [seek, store]);

  const stop = useCallback(() => setPlaying(false), []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = Date.now();
    const tick = (): void => {
      const now = Date.now();
      const next = store.position + (now - last) / 1000;
      last = now;
      if (next >= durationRef.current) {
        publish(durationRef.current);
        setPlaying(false);
        return;
      }
      publish(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, publish, store]);

  return { clock, playing, seek, toggle, stop };
}
