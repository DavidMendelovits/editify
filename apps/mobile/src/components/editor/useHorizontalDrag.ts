import { useMemo, useRef } from 'react';
import { PanResponder, type GestureResponderHandlers } from 'react-native';

export interface DragCallbacks {
  /** Called on grab with the touch position relative to the responder view. */
  onStart?: (localX: number) => void;
  onMove?: (dx: number) => void;
  /** Called on release *and* on termination; `dx` is the total horizontal travel. */
  onEnd?: (dx: number) => void;
}

/**
 * Horizontal drag plumbing shared by clip moves, trim handles and the playhead.
 *
 * PanResponder is created once and reads the latest callbacks through a ref, so
 * a gesture in progress never runs against a stale closure even though the
 * timeline re-renders on every frame of the drag. Termination requests are
 * refused so the enclosing horizontal ScrollView cannot steal a live drag.
 */
export function useHorizontalDrag(callbacks: DragCallbacks): GestureResponderHandlers {
  const latest = useRef(callbacks);
  latest.current = callbacks;

  return useMemo(() => PanResponder.create({
    // Bubble phase only: responder negotiation starts at the deepest view, so a
    // trim handle wins over the clip body it sits inside, and the clip body wins
    // over the enclosing horizontal ScrollView.
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: (event) => latest.current.onStart?.(event.nativeEvent.locationX),
    onPanResponderMove: (_event, gesture) => latest.current.onMove?.(gesture.dx),
    onPanResponderRelease: (_event, gesture) => latest.current.onEnd?.(gesture.dx),
    onPanResponderTerminate: (_event, gesture) => latest.current.onEnd?.(gesture.dx),
  }), []).panHandlers;
}
