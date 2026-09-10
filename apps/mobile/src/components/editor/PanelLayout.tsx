import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { colors, fonts, radius } from '../../lib/theme';

/** Sizes the wide editor: dock column width, and preview height inside the edit column. */
export interface EditorLayout {
  dockWidth: number;
  previewHeight: number;
}

/** Grab area of a divider; also the gap it occupies between two panels. */
export const DIVIDER_SIZE = 10;

/** Nothing may be dragged past these, so no panel collapses into a sliver. */
const LIMITS = { dockMin: 300, dockMax: 620, editMin: 420, previewMin: 260, timelineMin: 180 };

export const DEFAULT_LAYOUT: EditorLayout = { dockWidth: 372, previewHeight: 420 };

/** The three modes the editor is actually used in (see issue #20). */
export const LAYOUT_PRESETS: Record<'review' | 'prompt' | 'edit', EditorLayout> = {
  review: { dockWidth: 300, previewHeight: 620 },
  prompt: { dockWidth: 620, previewHeight: 380 },
  edit: { dockWidth: 320, previewHeight: 260 },
};
export type LayoutPreset = keyof typeof LAYOUT_PRESETS;

const KEY_PREFIX = 'editify.layout.v1.';
const storageKey = (scope: string): string => `${KEY_PREFIX}${scope}`;

/** Measured size of the workspace; zero until the first onLayout lands. */
export interface LayoutBounds {
  width: number;
  height: number;
}

const clampTo = (value: number, min: number, max: number): number => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

/** Applies the panel minimums against whatever room the window currently has. */
export function clampLayout(layout: EditorLayout, bounds: LayoutBounds): EditorLayout {
  const dockMax = bounds.width > 0
    ? Math.min(LIMITS.dockMax, bounds.width - LIMITS.editMin - DIVIDER_SIZE)
    : LIMITS.dockMax;
  const previewMax = bounds.height > 0 ? bounds.height - LIMITS.timelineMin - DIVIDER_SIZE : Infinity;
  return {
    dockWidth: clampTo(layout.dockWidth, LIMITS.dockMin, dockMax),
    previewHeight: clampTo(layout.previewHeight, LIMITS.previewMin, previewMax),
  };
}

function parseLayout(raw: string | null): EditorLayout | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { dockWidth, previewHeight } = parsed as Partial<EditorLayout>;
    if (typeof dockWidth !== 'number' || typeof previewHeight !== 'number') return undefined;
    return { dockWidth, previewHeight };
  } catch {
    return undefined;
  }
}

export interface EditorLayoutControl {
  /** Already clamped to the current bounds — safe to hand straight to a style. */
  layout: EditorLayout;
  /** Live drag update; nothing is written until `commit`. */
  resize: (next: Partial<EditorLayout>) => void;
  /** Drag end / preset: persists the project override and the user default. */
  commit: () => void;
  preset: (name: LayoutPreset) => void;
  reset: () => void;
}

/**
 * Panel sizes for one project: the stored project override wins, then the
 * per-user default, then the built-in defaults.
 *
 * The layout lives in this hook's state and reaches the editor as plain style
 * props, so dragging a divider only restyles the preview and dock views — the
 * player and timeline subtrees are never rebuilt.
 */
export function useEditorLayout(projectId: string, bounds: LayoutBounds): EditorLayoutControl {
  const [layout, setLayout] = useState<EditorLayout>(DEFAULT_LAYOUT);
  const latest = useRef(layout);
  latest.current = layout;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await AsyncStorage.multiGet([storageKey(projectId), storageKey('default')]);
      const stored = parseLayout(entries[0]?.[1] ?? null) ?? parseLayout(entries[1]?.[1] ?? null);
      if (!cancelled && stored) setLayout(stored);
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // Writes are debounced so a drag that ends in a flurry of taps (presets) or a
  // resize settling does not hammer storage.
  const writeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const write = useCallback((next: EditorLayout | undefined) => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      if (!next) {
        // Reset drops the user default too, so a reload really does come back
        // to the built-in proportions rather than the last thing dragged.
        void AsyncStorage.multiRemove([storageKey(projectId), storageKey('default')]);
        return;
      }
      // Saving a project's layout also moves the user's default.
      void AsyncStorage.multiSet([
        [storageKey(projectId), JSON.stringify(next)],
        [storageKey('default'), JSON.stringify(next)],
      ]);
    }, 250);
  }, [projectId]);
  useEffect(() => () => { if (writeTimer.current) clearTimeout(writeTimer.current); }, []);

  const clamped = useMemo(() => clampLayout(layout, bounds), [layout, bounds]);

  // A hook the demo/QA harness can read the live layout from.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    (window as unknown as { __editifyLayout?: EditorLayout }).__editifyLayout = clamped;
  }, [clamped]);

  const resize = useCallback((next: Partial<EditorLayout>) => {
    setLayout((current) => clampLayout({ ...current, ...next }, bounds));
  }, [bounds]);

  return {
    layout: clamped,
    resize,
    commit: useCallback(() => write(clampLayout(latest.current, bounds)), [write, bounds]),
    preset: useCallback((name: LayoutPreset) => {
      const next = clampLayout(LAYOUT_PRESETS[name], bounds);
      setLayout(next);
      write(next);
    }, [write, bounds]),
    reset: useCallback(() => { setLayout(DEFAULT_LAYOUT); write(undefined); }, [write]),
  };
}

interface DividerProps {
  orientation: 'vertical' | 'horizontal';
  testID: string;
  accessibilityLabel: string;
  onDragStart: () => void;
  /** Travel along the divider's axis since the grab started, in pixels. */
  onDrag: (delta: number) => void;
  onDragEnd: () => void;
}

/** A drag handle between two panels: 10px of grab area around a 2px hairline. */
export function PanelDivider({ orientation, testID, accessibilityLabel, onDragStart, onDrag, onDragEnd }: DividerProps) {
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const vertical = orientation === 'vertical';
  const latest = useRef({ onDragStart, onDrag, onDragEnd });
  latest.current = { onDragStart, onDrag, onDragEnd };

  // Created once and reading callbacks through a ref, so the gesture in flight
  // never runs against a stale closure while the editor re-renders.
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { setActive(true); latest.current.onDragStart(); },
    onPanResponderMove: (_event, gesture) => latest.current.onDrag(vertical ? gesture.dx : gesture.dy),
    onPanResponderRelease: () => { setActive(false); latest.current.onDragEnd(); },
    onPanResponderTerminate: () => { setActive(false); latest.current.onDragEnd(); },
  }), [vertical]).panHandlers;

  return (
    <View
      {...pan}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={[styles.divider, vertical ? styles.dividerVertical : styles.dividerHorizontal, cursorFor(vertical)]}
    >
      <View style={[styles.grip, vertical ? styles.gripVertical : styles.gripHorizontal, (hovered || active) && styles.gripActive]} />
    </View>
  );
}

/** RN's style types have no resize cursors, but react-native-web passes them through. */
function cursorFor(vertical: boolean): ViewStyle | null {
  if (Platform.OS !== 'web') return null;
  return { cursor: vertical ? 'col-resize' : 'row-resize' } as unknown as ViewStyle;
}

interface PresetsProps {
  onPreset: (name: LayoutPreset) => void;
  onReset: () => void;
}

/** review / prompt / edit / reset, sized to sit next to the header buttons. */
export function LayoutPresets({ onPreset, onReset }: PresetsProps) {
  return (
    <View style={styles.presets}>
      <Text style={styles.presetLabel}>LAYOUT</Text>
      {(Object.keys(LAYOUT_PRESETS) as LayoutPreset[]).map((name) => (
        <Pressable
          key={name}
          testID={`layout-preset-${name}`}
          accessibilityRole="button"
          onPress={() => onPreset(name)}
          style={({ pressed }) => [styles.presetButton, pressed && styles.presetPressed]}
        >
          <Text style={styles.presetText}>{name}</Text>
        </Pressable>
      ))}
      <Pressable
        testID="layout-reset"
        accessibilityRole="button"
        onPress={onReset}
        style={({ pressed }) => [styles.presetButton, pressed && styles.presetPressed]}
      >
        <Text style={styles.presetText}>reset</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  divider: { alignItems: 'center', justifyContent: 'center' },
  dividerVertical: { width: DIVIDER_SIZE, alignSelf: 'stretch' },
  dividerHorizontal: { height: DIVIDER_SIZE, alignSelf: 'stretch' },
  grip: { backgroundColor: colors.border, borderRadius: 1 },
  gripVertical: { width: 2, height: '100%' },
  gripHorizontal: { height: 2, width: '100%' },
  gripActive: { backgroundColor: colors.accent },
  presets: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  presetLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: 8, letterSpacing: 1.2, marginRight: 2 },
  presetButton: {
    minHeight: 26,
    paddingHorizontal: 10,
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  },
  presetPressed: { opacity: 0.7 },
  presetText: { color: colors.text, fontFamily: fonts.medium, fontSize: 10 },
});
