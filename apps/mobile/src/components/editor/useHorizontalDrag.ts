import { useMemo, useRef } from 'react';
import { PanResponder, type GestureResponderHandlers } from 'react-native';

export interface DragCallbacks {
  /** Called on grab with the touch position relative to the responder view. */
  onStart?: (localX: number) => void;
  onMove?: (dx: number) => void;
  /** Called on release *and* on termination; `dx` is the total horizontal travel. */
  onEnd?: (dx: number) => void;
}

export interface DragOptions {
  /**
   * When true (ruler, trim handles, a *selected* clip) the gesture is held
   * against the enclosing ScrollView. When false (unselected clips) the
   * ScrollView may take the touch over for scrolling once it moves — the
   * release path then reports zero travel so a stolen drag can never commit
   * an accidental clip move; a plain tap still lands as a selection. This is
   * what keeps the timeline scrollable on a phone.
   */
  hold?: boolean;
}

/**
 * Horizontal drag plumbing shared by clip moves, trim handles and the playhead.
 *
 * PanResponder is created once and reads the latest callbacks through a ref, so
 * a gesture in progress never runs against a stale closure even though the
 * timeline re-renders on every frame of the drag.
 */
export function useHorizontalDrag(callbacks: DragCallbacks, options: DragOptions = {}): GestureResponderHandlers {
  const latest = useRef({ callbacks, hold: options.hold ?? true });
  latest.current = { callbacks, hold: options.hold ?? true };

  return useMemo(() => PanResponder.create({
    // Bubble phase only: responder negotiation starts at the deepest view, so a
    // trim handle wins over the clip body it sits inside, and the clip body wins
    // over the enclosing horizontal ScrollView.
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => !latest.current.hold,
    onShouldBlockNativeResponder: () => latest.current.hold,
    onPanResponderGrant: (event) => latest.current.callbacks.onStart?.(event.nativeEvent.locationX),
    onPanResponderMove: (_event, gesture) => latest.current.callbacks.onMove?.(gesture.dx),
    onPanResponderRelease: (_event, gesture) => latest.current.callbacks.onEnd?.(gesture.dx),
    // The ScrollView took the touch for scrolling: report zero travel so the
    // aborted drag reads as a click, never as a move/trim commit.
    onPanResponderTerminate: () => latest.current.callbacks.onEnd?.(0),
  }), []).panHandlers;
}
