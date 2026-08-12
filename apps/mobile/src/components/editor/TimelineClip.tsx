import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AssetMetadata, Clip } from '@editify/shared';
import { clipTimelineDuration } from '@editify/shared';
import { Filmstrip } from './Filmstrip';
import { useHorizontalDrag } from './useHorizontalDrag';
import { colors } from '../../lib/theme';

export type DragMode = 'move' | 'in' | 'out';

interface Props {
  /** The clip as it should be drawn — already carrying any live drag preview. */
  clip: Clip;
  asset: AssetMetadata | undefined;
  index: number;
  pxPerSec: number;
  height: number;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onDragStart: (mode: DragMode) => void;
  onDragMove: (mode: DragMode, dx: number) => void;
  onDragEnd: (mode: DragMode, dx: number) => void;
}

/**
 * One video/audio block on the timeline: filmstrip body plus the two trim
 * handles. All three gestures are horizontal drags — the parent decides whether
 * a release was a move, a trim, or (below the movement threshold) a selection.
 */
export function TimelineClip({
  clip, asset, index, pxPerSec, height, selected, dragging,
  onSelect, onDragStart, onDragMove, onDragEnd,
}: Props) {
  const duration = clipTimelineDuration(clip);
  const width = Math.max(6, duration * pxPerSec);
  const speed = clip.speed ?? 1;
  const body = useHorizontalDrag({
    onStart: () => onDragStart('move'),
    onMove: (dx) => onDragMove('move', dx),
    onEnd: (dx) => onDragEnd('move', dx),
  });
  const leftHandle = useHorizontalDrag({
    onStart: () => onDragStart('in'),
    onMove: (dx) => onDragMove('in', dx),
    onEnd: (dx) => onDragEnd('in', dx),
  });
  const rightHandle = useHorizontalDrag({
    onStart: () => onDragStart('out'),
    onMove: (dx) => onDragMove('out', dx),
    onEnd: (dx) => onDragEnd('out', dx),
  });
  const roomy = width > 74;

  return (
    <View
      {...body}
      accessibilityRole="button"
      accessibilityLabel={`clip ${index + 1}`}
      onAccessibilityTap={onSelect}
      style={[
        styles.block,
        { left: clip.start * pxPerSec, width, height },
        selected && styles.blockSelected,
        dragging && styles.blockDragging,
      ]}
    >
      <Filmstrip asset={asset} in={clip.in} out={clip.out} width={width} height={height} />
      <View style={styles.scrim} pointerEvents="none" />
      <View style={styles.meta} pointerEvents="none">
        <Text style={styles.number}>{String(index + 1).padStart(2, '0')}</Text>
        {roomy && (
          <Text style={styles.name} numberOfLines={1}>
            {(asset?.originalName ?? clip.assetId ?? clip.id).replace(/\.[^.]+$/, '')}
          </Text>
        )}
      </View>
      <View style={styles.badges} pointerEvents="none">
        {speed !== 1 && <View style={[styles.badge, styles.badgeAccent]}><Text style={styles.badgeText}>{speed}×</Text></View>}
        {clip.volume === 0 && <View style={styles.badge}><Text style={styles.badgeText}>MUTE</Text></View>}
        {roomy && <View style={styles.badge}><Text style={styles.badgeText}>{duration.toFixed(1)}s</Text></View>}
      </View>
      <View {...leftHandle} style={[styles.handle, styles.handleLeft, selected && styles.handleVisible]}>
        <View style={styles.grip} />
      </View>
      <View {...rightHandle} style={[styles.handle, styles.handleRight, selected && styles.handleVisible]}>
        <View style={styles.grip} />
      </View>
    </View>
  );
}

/**
 * Slim caption block. Rows are pre-assigned by `captionRows`, so chips that
 * overlap in time stack visibly (and turn amber) instead of hiding the bug.
 */
export function CaptionChip({
  clip, pxPerSec, row, overlapping, selected, height, onSelect, onDragStart, onDragMove, onDragEnd,
}: {
  clip: Clip;
  pxPerSec: number;
  row: number;
  overlapping: boolean;
  selected: boolean;
  height: number;
  onSelect: () => void;
  onDragStart: (mode: DragMode) => void;
  onDragMove: (mode: DragMode, dx: number) => void;
  onDragEnd: (mode: DragMode, dx: number) => void;
}) {
  const width = Math.max(4, clipTimelineDuration(clip) * pxPerSec);
  const drag = useHorizontalDrag({
    onStart: () => onDragStart('move'),
    onMove: (dx) => onDragMove('move', dx),
    onEnd: (dx) => onDragEnd('move', dx),
  });
  return (
    <View
      {...drag}
      accessibilityRole="button"
      onAccessibilityTap={onSelect}
      style={[
        styles.caption,
        { left: clip.start * pxPerSec, width, top: row * (height + 2), height },
        overlapping && styles.captionOverlap,
        selected && styles.captionSelected,
      ]}
    >
      <Text numberOfLines={1} style={[styles.captionText, overlapping && styles.captionTextOverlap]}>
        {clip.text ?? '—'}
      </Text>
    </View>
  );
}

/** Dashed outline left behind at a dragged clip's original position. */
export function DragGhost({ left, width, height }: { left: number; width: number; height: number }) {
  return <View pointerEvents="none" style={[styles.ghost, { left, width, height }]} />;
}

/** Live start-time readout that follows a drag. */
export function DragTooltip({ left, label }: { left: number; label: string }) {
  return (
    <View pointerEvents="none" style={[styles.tooltip, { left: Math.max(0, left) }]}>
      <Text style={styles.tooltipText}>{label}</Text>
    </View>
  );
}

/** Empty-state block shown when a video track has no clips at all. */
export function EmptyLane({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.empty} accessibilityRole="button">
      <Text style={styles.emptyText}>+  IMPORT MEDIA TO START THE TIMELINE</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    position: 'absolute', top: 0, borderRadius: 5, overflow: 'hidden',
    borderWidth: 1, borderColor: '#3A3850', backgroundColor: '#0A0A0F',
  },
  blockSelected: { borderColor: colors.purple, borderWidth: 1 },
  blockDragging: { opacity: 0.92, borderColor: colors.pink },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#05040A40' },
  meta: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 15, paddingHorizontal: 6,
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#05040ACC',
  },
  number: { color: '#FFFFFF', fontFamily: 'Montserrat_800ExtraBold', fontSize: 8, letterSpacing: 0.4 },
  name: { flex: 1, color: '#FFFFFFCC', fontFamily: 'Montserrat_600SemiBold', fontSize: 8 },
  badges: { position: 'absolute', bottom: 4, left: 6, right: 6, flexDirection: 'row', alignItems: 'center', gap: 4 },
  badge: { borderRadius: 3, backgroundColor: '#00000099', paddingHorizontal: 4, paddingVertical: 2 },
  badgeAccent: { backgroundColor: '#6D28D9CC' },
  badgeText: { color: '#FFFFFF', fontFamily: 'Montserrat_700Bold', fontSize: 7, letterSpacing: 0.4 },
  handle: {
    position: 'absolute', top: 0, bottom: 0, width: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#0B0B0F55',
  },
  handleVisible: { backgroundColor: colors.purple },
  handleLeft: { left: 0 },
  handleRight: { right: 0 },
  grip: { width: 2, height: 16, borderRadius: 1, backgroundColor: '#FFFFFFAA' },
  caption: {
    position: 'absolute', borderRadius: 4, justifyContent: 'center', paddingHorizontal: 6,
    backgroundColor: '#3B2C63', borderWidth: 1, borderColor: '#54427F',
  },
  captionOverlap: { backgroundColor: '#5A3D18', borderColor: '#C98A2B' },
  captionSelected: { borderColor: colors.purple, backgroundColor: '#4B3785' },
  captionText: { color: '#E7E1FF', fontFamily: 'Montserrat_600SemiBold', fontSize: 8 },
  captionTextOverlap: { color: '#FFD79A' },
  ghost: {
    position: 'absolute', top: 0, borderRadius: 5, borderWidth: 1,
    borderColor: '#FFFFFF33', borderStyle: 'dashed', backgroundColor: '#FFFFFF08',
  },
  tooltip: {
    position: 'absolute', top: -2, borderRadius: 4, backgroundColor: colors.pink,
    paddingHorizontal: 5, paddingVertical: 2, zIndex: 40,
  },
  tooltipText: { color: '#FFFFFF', fontFamily: 'Montserrat_700Bold', fontSize: 8 },
  empty: {
    position: 'absolute', left: 0, top: 8, height: 44, width: 320, borderRadius: 6,
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyText: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1 },
});
