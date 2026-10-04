import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View, type GestureResponderHandlers } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { Clip, Operation, OverlayPlacement, PlanOverlay, Project, RenderPlan } from '@editify/shared';
import { clipEnd } from '../../lib/timeline';
import {
  captionViewRect, DEFAULT_PLACEMENT, HandleDrag, planFit, planToViewRect, type Size, type ViewRect,
} from '../../lib/preview-handles';
import type { PlanStore } from '../../lib/native-preview';
import { colors, fonts, radius, type } from '../../lib/theme';
import { usePlayheadSelector, type PlayheadClock } from './usePlayback';

/**
 * Selection boxes and grips over the native preview (plan P5, decision 6A). The native view
 * draws every pixel; this layer only draws outlines and handles, placed from the plan's own
 * overlay boxes and caption lines (planToViewRect), so they sit on what the renderer drew.
 *
 * Every overlay on screen gets an invisible hit box (tap selects, drag moves); the selected
 * one gets an outline and the RN preview's three corner grips (delete, duplicate,
 * resize-and-rotate). A selected caption gets an outline. While a finger moves, `onDrag`
 * sends a parameter-only plan update (the overlay's box); the patched plan comes back through
 * `plans`, so the outline follows what native draws. The release commits one set_overlay,
 * as PreviewPlayer's Sticker does.
 */
interface Props {
  /** The last plan sent to native (drag patches included): this layer re-renders per plan, the preview doesn't. */
  plans: PlanStore;
  project: Project;
  clock: PlayheadClock;
  /** The native view's size in points (the plan is aspect-fitted inside it). */
  view: Size;
  selectedId: string | undefined;
  onSelect: (clipId: string | undefined) => void;
  onApply: (ops: Operation[]) => void;
  /** A handle moved: send the parameter-only update (the next plan carries the patched box). */
  onDrag: (clip: Clip, placement: OverlayPlacement) => void;
  /** `committed`: a set_overlay was just applied for it. */
  onDragEnd: (committed: boolean) => void;
}

const HANDLE = 28;

/** Ids of the plan items on screen at `time`, as one string (a coarse selector: it changes at boundaries only). */
function visibleAt(items: ReadonlyArray<{ id: string; start: number; end: number }>, time: number): string {
  let ids = '';
  for (const item of items) if (time >= item.start - 1e-6 && time < item.end - 1e-6) ids += ids ? `,${item.id}` : item.id;
  return ids;
}

export function PreviewHandles({ plans, project, clock, view, selectedId, onSelect, onApply, onDrag, onDragEnd }: Props) {
  const plan = useSyncExternalStore(plans.subscribe, plans.get, plans.get);
  const overlayItems = plan?.overlays;
  const captionItems = plan?.captions;
  const overlayIds = usePlayheadSelector(clock, useCallback((time: number) => visibleAt(overlayItems ?? [], time), [overlayItems]));
  const captionIds = usePlayheadSelector(clock, useCallback((time: number) => visibleAt(captionItems ?? [], time), [captionItems]));
  const clips = useMemo(() => {
    const byId = new Map<string, Clip>();
    for (const track of project.tracks) if (track.kind === 'overlay') for (const clip of track.clips) byId.set(clip.id, clip);
    return byId;
  }, [project.tracks]);
  const shown = plan;

  if (!shown || view.width <= 0) return null;
  const visible = new Set(overlayIds ? overlayIds.split(',') : []);
  const overlays = shown.overlays.filter((overlay) => visible.has(overlay.id) && clips.has(overlay.id));
  const caption = selectedId && captionIds.split(',').includes(selectedId) ? shown.captions.find((item) => item.id === selectedId) : undefined;
  const captionRect = caption ? captionViewRect(caption, shown.size, view) : undefined;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {overlays.map((overlay) => (
        <OverlayHandle
          key={overlay.id}
          overlay={overlay}
          clip={clips.get(overlay.id)!}
          planSize={shown.size}
          view={view}
          selected={overlay.id === selectedId}
          onSelect={onSelect}
          onApply={onApply}
          onDrag={onDrag}
          onDragEnd={onDragEnd}
        />
      ))}
      {captionRect && <View pointerEvents="none" style={[styles.outline, rectStyle(captionRect)]} />}
    </View>
  );
}

function rectStyle(rect: ViewRect) {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, transform: [{ rotate: `${rect.rotationDeg}deg` }] };
}

function OverlayHandle({ overlay, clip, planSize, view, selected, onSelect, onApply, onDrag, onDragEnd }: {
  overlay: PlanOverlay;
  clip: Clip;
  planSize: RenderPlan['size'];
  view: Size;
  selected: boolean;
  onSelect: Props['onSelect'];
  onApply: Props['onApply'];
  onDrag: (clip: Clip, placement: OverlayPlacement) => void;
  onDragEnd: (committed: boolean) => void;
}) {
  const rect = planToViewRect(overlay.box, planSize, view);
  const fit = planFit(planSize, view);
  const [guides, setGuides] = useState<{ x: boolean; y: boolean }>();
  // Stable responders, live values.
  const latest = useRef({ clip, fit, onSelect, onApply, onDrag, onDragEnd });
  latest.current = { clip, fit, onSelect, onApply, onDrag, onDragEnd };
  const drag = useRef<HandleDrag | null>(null);

  const start = (mode: 'move' | 'grip'): void => {
    const current = latest.current;
    const snapped = { x: false, y: false };
    drag.current = new HandleDrag({
      clipId: current.clip.id,
      start: current.clip.overlay ?? DEFAULT_PLACEMENT,
      stage: { width: current.fit.width, height: current.fit.height },
      mode,
      onPreview: (placement) => {
        if (mode === 'move') {
          const now = { x: placement.x === 0.5, y: placement.y === 0.5 };
          if (Platform.OS !== 'web' && ((now.x && !snapped.x) || (now.y && !snapped.y))) void Haptics.selectionAsync();
          snapped.x = now.x;
          snapped.y = now.y;
          setGuides(now.x || now.y ? now : undefined);
        }
        latest.current.onDrag(latest.current.clip, placement);
      },
      onCommit: (ops) => latest.current.onApply(ops),
      onEnd: (committed) => { setGuides(undefined); latest.current.onDragEnd(committed); },
    });
  };

  const mover = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      latest.current.onSelect(latest.current.clip.id);
      start('move');
    },
    onPanResponderMove: (_event, gesture) => { drag.current?.move(gesture.dx, gesture.dy); },
    onPanResponderRelease: (_event, gesture) => { drag.current?.release(gesture.dx, gesture.dy); drag.current = null; },
    onPanResponderTerminate: () => { drag.current?.cancel(); drag.current = null; },
  })).current;

  const grip = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => start('grip'),
    onPanResponderMove: (_event, gesture) => { drag.current?.move(gesture.dx, gesture.dy); },
    onPanResponderRelease: (_event, gesture) => { drag.current?.release(gesture.dx, gesture.dy); drag.current = null; },
    onPanResponderTerminate: () => { drag.current?.cancel(); drag.current = null; },
  })).current;

  const removeSelf = (): void => {
    onApply([{ type: 'remove_clip', params: { clipId: clip.id } }]);
    onSelect(undefined);
  };
  /** A copy of the sticker, landing right after it so both are reachable. */
  const duplicateSelf = (): void => {
    const copy: Clip = { ...clip, id: `${clip.id}-copy-${Date.now()}`, start: Math.round(clipEnd(clip) * 1000) / 1000 };
    onApply([{ type: 'add_clip', params: { trackId: 'overlays', clip: copy } }]);
    onSelect(copy.id);
  };

  // Grips on the unrotated corners, at least HANDLE apart, slid back inside the frame (as the RN preview does).
  const gw = Math.max(rect.width, HANDLE);
  const gh = Math.max(rect.height, HANDLE);
  const frame = { left: fit.offsetX, top: fit.offsetY, right: fit.offsetX + fit.width, bottom: fit.offsetY + fit.height };
  const gLeft = rect.centerX - gw / 2;
  const gRight = gLeft + gw;
  const gTop = rect.centerY - gh / 2;
  const gBottom = gTop + gh;
  const gDx = Math.max(0, frame.left + HANDLE / 2 - gLeft) - Math.max(0, gRight + HANDLE / 2 - frame.right);
  const gDy = Math.max(0, frame.top + HANDLE / 2 - gTop) - Math.max(0, gBottom + HANDLE / 2 - frame.bottom);

  return (
    <>
      {guides?.x && <View pointerEvents="none" style={[styles.guide, styles.guideVertical, { left: frame.left + fit.width / 2, top: frame.top, height: fit.height }]} />}
      {guides?.y && <View pointerEvents="none" style={[styles.guide, styles.guideHorizontal, { top: frame.top + fit.height / 2, left: frame.left, width: fit.width }]} />}
      <View
        {...mover.panHandlers}
        testID={`overlay-handle-${clip.id}`}
        style={[styles.box, rectStyle(rect), selected && styles.outline]}
      />
      {selected && (
        <>
          <Grip label="delete sticker" glyph="✕" testID="sticker-delete" danger left={gLeft + gDx} top={gTop + gDy} onPress={removeSelf} />
          <Grip label="duplicate sticker" glyph="⧉" testID="sticker-duplicate" left={gLeft + gDx} top={gBottom + gDy} onPress={duplicateSelf} />
          <Grip label="resize and rotate sticker" glyph="⤡" testID="sticker-grip" left={gRight + gDx} top={gBottom + gDy} handlers={grip.panHandlers} />
        </>
      )}
    </>
  );
}

/** One round grip centred on a corner of the selected box. */
function Grip({ label, glyph, testID, left, top, danger, onPress, handlers }: {
  label: string;
  glyph: string;
  testID: string;
  left: number;
  top: number;
  danger?: boolean;
  onPress?: () => void;
  handlers?: GestureResponderHandlers;
}) {
  const style = [styles.handle, { left: left - HANDLE / 2, top: top - HANDLE / 2 }, danger && styles.handleDanger];
  const face = <Text style={styles.handleGlyph}>{glyph}</Text>;
  // A drag grip is a plain View: Pressable would claim the gesture before the pan responder sees the move.
  return handlers
    ? <View {...handlers} testID={testID} accessibilityLabel={label} style={style}>{face}</View>
    : <Pressable testID={testID} accessibilityLabel={label} onPress={onPress} style={style}>{face}</Pressable>;
}

const styles = StyleSheet.create({
  box: { position: 'absolute' },
  outline: { position: 'absolute', borderWidth: 1, borderColor: colors.accent, borderRadius: radius.md },
  handle: {
    position: 'absolute', width: HANDLE, height: HANDLE, borderRadius: HANDLE / 2, zIndex: 6,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(17,17,19,0.92)', borderWidth: 1, borderColor: colors.accent,
  },
  handleDanger: { borderColor: colors.danger },
  handleGlyph: { color: '#FFFFFF', fontFamily: fonts.bold, fontSize: type.base },
  guide: { position: 'absolute', backgroundColor: colors.accent, opacity: 0.8, zIndex: 5 },
  guideVertical: { width: 1 },
  guideHorizontal: { height: 1 },
});
