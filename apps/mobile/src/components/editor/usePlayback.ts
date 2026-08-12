import { useCallback, useEffect, useRef, useState } from 'react';

export interface Playback {
  playhead: number;
  playing: boolean;
  seek: (time: number) => void;
  toggle: () => void;
  stop: () => void;
}

/**
 * The transport clock. The playhead — not the video element — is the source of
 * truth for timeline playback: it advances on wall-clock time inside a
 * requestAnimationFrame loop, so gaps between clips keep running and the
 * preview only has to follow. Playback stops at the end of the project.
 */
export function usePlayback(duration: number): Playback {
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const position = useRef(0);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const seek = useCallback((time: number) => {
    const clamped = Math.max(0, Math.min(time, Math.max(0, durationRef.current)));
    position.current = clamped;
    setPlayhead(clamped);
  }, []);

  const toggle = useCallback(() => {
    setPlaying((current) => {
      if (current) return false;
      if (position.current >= durationRef.current - 0.02) seek(0);
      return durationRef.current > 0;
    });
  }, [seek]);

  const stop = useCallback(() => setPlaying(false), []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = Date.now();
    const tick = (): void => {
      const now = Date.now();
      const next = position.current + (now - last) / 1000;
      last = now;
      if (next >= durationRef.current) {
        position.current = durationRef.current;
        setPlayhead(durationRef.current);
        setPlaying(false);
        return;
      }
      position.current = next;
      setPlayhead(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  return { playhead, playing, seek, toggle, stop };
}
