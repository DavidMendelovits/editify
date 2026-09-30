import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { AssetMetadata, Callout, Clip } from '@editify/shared';
import { clipTimelineDuration } from '@editify/shared';
import { Filmstrip } from './Filmstrip';
import { useHorizontalDrag } from './useHorizontalDrag';
import { api, type WaveformEnvelope } from '../../lib/api';
import { sensitive } from '../../lib/sensitive';
import { colors, radius, space, type, fonts } from '../../lib/theme';
import { describeImport, importFraction, type ImportProgress } from '../../lib/upload-progress';
import { ProgressBar } from '../ProgressBar';

export type DragMode = 'move' | 'in' | 'out';

/**
 * Chip callbacks carry the clip id so the parent can hand every chip the same
 * stable handler — which is what lets the chips be `memo`ized: during a drag
 * the timeline re-renders on every move event, and without memo each clip's
 * filmstrip cells (up to 26 `<Image>`s) reconciled per event.
 */
interface ChipCallbacks {
  onSelect: (clipId: string) => void;
  onDragStart: (clipId: string, mode: DragMode) => void;
  onDragMove: (clipId: string, mode: DragMode, dx: number) => void;
  onDragEnd: (clipId: string, mode: DragMode, dx: number) => void;
}

interface Props extends ChipCallbacks {
  /** The clip as it should be drawn — already carrying any live drag preview. */
  clip: Clip;
  asset: AssetMetadata | undefined;
  index: number;
  pxPerSec: number;
  height: number;
  selected: boolean;
  dragging: boolean;
}

/**
 * One video/audio block on the timeline: filmstrip body plus the two trim
 * handles. All three gestures are horizontal drags — the parent decides whether
 * a release was a move, a trim, or (below the movement threshold) a selection.
 */
export const TimelineClip = memo(function TimelineClip({
  clip, asset, index, pxPerSec, height, selected, dragging,
  onSelect, onDragStart, onDragMove, onDragEnd,
}: Props) {
  const duration = clipTimelineDuration(clip);
  const width = Math.max(6, duration * pxPerSec);
  const speed = clip.speed ?? 1;
  const id = clip.id;
  // Unselected clips yield to the ScrollView (tap selects, drag scrolls);
  // selecting a clip is what arms move/trim — the CapCut model.
  const body = useHorizontalDrag({
    onStart: () => onDragStart(id, 'move'),
    onMove: (dx) => onDragMove(id, 'move', dx),
    onEnd: (dx) => onDragEnd(id, 'move', dx),
  }, { hold: selected });
  const leftHandle = useHorizontalDrag({
    onStart: () => onDragStart(id, 'in'),
    onMove: (dx) => onDragMove(id, 'in', dx),
    onEnd: (dx) => onDragEnd(id, 'in', dx),
  });
  const rightHandle = useHorizontalDrag({
    onStart: () => onDragStart(id, 'out'),
    onMove: (dx) => onDragMove(id, 'out', dx),
    onEnd: (dx) => onDragEnd(id, 'out', dx),
  });
  const roomy = width > 74;
  // Sound clips have no filmstrip to compete with, so their bars fill the body
  // below the label strip; a video's are a strip along its bottom edge.
  const soundOnly = !asset || asset.width === 0 || asset.height === 0;
  const waveHeight = Math.max(0, soundOnly ? height - 15 : Math.round(height * 0.35));

  return (
    <View
      {...body}
      accessibilityRole="button"
      accessibilityLabel={`clip ${index + 1}`}
      onAccessibilityTap={() => onSelect(id)}
      style={[
        styles.block,
        { left: clip.start * pxPerSec, width, height },
        selected && styles.blockSelected,
        dragging && styles.blockDragging,
      ]}
    >
      <Filmstrip asset={asset} in={clip.in} out={clip.out} width={width} height={height} />
      <View style={styles.scrim} pointerEvents="none" />
      {asset?.hasAudio && (
        <ClipWaveform assetId={asset.id} in={clip.in} out={clip.out} width={width} height={waveHeight} />
      )}
      <View style={styles.meta} pointerEvents="none">
        <Text style={styles.number}>{String(index + 1).padStart(2, '0')}</Text>
        {roomy && (
          <Text style={styles.name} {...sensitive} numberOfLines={1}>
            {(asset?.originalName ?? clip.assetId ?? clip.id).replace(/\.[^.]+$/, '')}
          </Text>
        )}
      </View>
      <View style={styles.badges} pointerEvents="none">
        {speed !== 1 && <View style={[styles.badge, styles.badgeAccent]}><Text style={styles.badgeText}>{speed}×</Text></View>}
        {clip.volume === 0 && <View style={styles.badge}><Text style={styles.badgeText}>MUTE</Text></View>}
        {roomy && <View style={styles.badge}><Text style={styles.badgeText}>{duration.toFixed(1)}s</Text></View>}
      </View>
      {/* The transition into this clip. Kept inside the body's left edge so the
          trim handle — same edge, mounted after this, so painted over it —
          still reads as the thing you can grab. */}
      {clip.transition && (
        <View style={styles.transition} pointerEvents="none">
          <Text style={styles.transitionGlyph}>◇</Text>
        </View>
      )}
      {/* Handles only mount when selected: on an unselected clip they used to
          swallow the taps landing within 10px of either edge. `hitSlop`
          stretches the touch target toward the 44pt guideline. */}
      {selected && (
        <>
          <View {...leftHandle} hitSlop={{ top: 10, bottom: 10, left: 12, right: 4 }} style={[styles.handle, styles.handleLeft, styles.handleVisible]}>
            <View style={styles.grip} />
          </View>
          <View {...rightHandle} hitSlop={{ top: 10, bottom: 10, left: 4, right: 12 }} style={[styles.handle, styles.handleRight, styles.handleVisible]}>
            <View style={styles.grip} />
          </View>
        </>
      )}
    </View>
  );
});

/** Bar pitch in px — a 2px bar plus its 1px gap. */
const BAR_PITCH = 3;
/** Even a fully zoomed-in clip stops here; past it the bars only get fatter. */
const MAX_BARS = 120;

/**
 * The clip's own audio, drawn as low-contrast bars behind its labels. The
 * envelope covers the whole source, so the clip's [in, out] window is sliced
 * out and peak-reduced to however many bars fit — speed needs no handling of
 * its own, since the chip's pixel width already accounts for it.
 */
const ClipWaveform = memo(function ClipWaveform({
  assetId, in: inPoint, out, width, height,
}: {
  assetId: string | undefined;
  in: number;
  out: number;
  width: number;
  height: number;
}) {
  const { data } = useQuery({
    queryKey: ['waveform', assetId],
    queryFn: async () => await api.getWaveform(assetId as string),
    staleTime: Infinity,
    enabled: Boolean(assetId),
  });
  const bars = useMemo(() => barHeights(data, inPoint, out, width, height), [data, inPoint, out, width, height]);
  if (bars.length === 0) return null;
  return (
    <View pointerEvents="none" style={[styles.waveform, { height }]}>
      {bars.map((barHeight, index) => (
        <View key={index} style={[styles.waveformBar, { height: barHeight }]} />
      ))}
    </View>
  );
});

/**
 * Peak-reduce the cells covering [in, out] into one pixel height per bar.
 * Peak rather than mean: quiet passages stay legible next to loud ones, which
 * is the whole point of glancing at a waveform.
 */
function barHeights(
  envelope: WaveformEnvelope | undefined,
  inPoint: number,
  out: number,
  width: number,
  height: number,
): number[] {
  if (!envelope?.cellSeconds || envelope.rmsDb.length === 0 || width < BAR_PITCH || height <= 0) return [];
  const first = Math.max(0, Math.floor(inPoint / envelope.cellSeconds));
  const last = Math.min(envelope.rmsDb.length, Math.ceil(out / envelope.cellSeconds));
  if (last - first <= 0) return [];
  const count = Math.max(1, Math.min(MAX_BARS, Math.round(width / BAR_PITCH)));
  const cellsPerBar = (last - first) / count;
  const bars: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const from = first + Math.floor(index * cellsPerBar);
    const to = Math.min(last, Math.max(from + 1, first + Math.floor((index + 1) * cellsPerBar)));
    let peak = -100;
    for (let cell = from; cell < to; cell += 1) peak = Math.max(peak, envelope.rmsDb[cell] ?? -100);
    bars.push(Math.round(energyPct(peak) * height));
  }
  return bars;
}

/** Map RMS dB (~-60..0) onto a 0..1 bar height, as the dissect panel does. */
function energyPct(db: number): number {
  return Math.max(0.04, Math.min(1, (db + 60) / 60));
}

/**
 * Slim caption block. Rows are pre-assigned by `captionRows`, so chips that
 * overlap in time stack visibly (and turn amber) instead of hiding the bug.
 * Trim handles appear when selected — a caption's on-screen window is dragged
 * at either edge, like a sticker's.
 */
export const CaptionChip = memo(function CaptionChip({
  clip, pxPerSec, row, overlapping, selected, height, onSelect, onDragStart, onDragMove, onDragEnd,
}: ChipCallbacks & {
  clip: Clip;
  pxPerSec: number;
  row: number;
  overlapping: boolean;
  selected: boolean;
  height: number;
}) {
  const width = Math.max(4, clipTimelineDuration(clip) * pxPerSec);
  const id = clip.id;
  const drag = useHorizontalDrag({
    onStart: () => onDragStart(id, 'move'),
    onMove: (dx) => onDragMove(id, 'move', dx),
    onEnd: (dx) => onDragEnd(id, 'move', dx),
  }, { hold: selected });
  const leftHandle = useHorizontalDrag({
    onStart: () => onDragStart(id, 'in'),
    onMove: (dx) => onDragMove(id, 'in', dx),
    onEnd: (dx) => onDragEnd(id, 'in', dx),
  });
  const rightHandle = useHorizontalDrag({
    onStart: () => onDragStart(id, 'out'),
    onMove: (dx) => onDragMove(id, 'out', dx),
    onEnd: (dx) => onDragEnd(id, 'out', dx),
  });
  return (
    <View
      {...drag}
      accessibilityRole="button"
      onAccessibilityTap={() => onSelect(id)}
      style={[
        styles.caption,
        { left: clip.start * pxPerSec, width, top: row * (height + 2), height },
        overlapping && styles.captionOverlap,
        selected && styles.captionSelected,
      ]}
    >
      <Text numberOfLines={1} {...sensitive} style={[styles.captionText, overlapping && styles.captionTextOverlap]}>
        {clip.text ?? 'n/a'}
      </Text>
      {selected && (
        <>
          <View {...leftHandle} hitSlop={{ top: 10, bottom: 10, left: 12, right: 4 }} style={[styles.handle, styles.handleLeft, styles.handleVisible]} />
          <View {...rightHandle} hitSlop={{ top: 10, bottom: 10, left: 4, right: 12 }} style={[styles.handle, styles.handleRight, styles.handleVisible]} />
        </>
      )}
    </View>
  );
});

/** Chip prefix per callout variant — the card's verdict, at chip size. */
const CALLOUT_GLYPH: Record<Callout['variant'], string> = { check: '✓', x: '✗', card: '▢' };

/**
 * A sticker's timeline chip: emoji, callout line, or image name on a slim row. Trim
 * handles appear when selected so its display window is draggable like any
 * clip; overlapping stickers stack rows without an error tint — simultaneous
 * stickers are a feature, not bad data.
 */
export const StickerChip = memo(function StickerChip({
  clip, asset, pxPerSec, row, selected, height, onSelect, onDragStart, onDragMove, onDragEnd,
}: ChipCallbacks & {
  clip: Clip;
  asset: AssetMetadata | undefined;
  pxPerSec: number;
  row: number;
  selected: boolean;
  height: number;
}) {
  const width = Math.max(4, clipTimelineDuration(clip) * pxPerSec);
  const id = clip.id;
  const drag = useHorizontalDrag({
    onStart: () => onDragStart(id, 'move'),
    onMove: (dx) => onDragMove(id, 'move', dx),
    onEnd: (dx) => onDragEnd(id, 'move', dx),
  }, { hold: selected });
  const leftHandle = useHorizontalDrag({
    onStart: () => onDragStart(id, 'in'),
    onMove: (dx) => onDragMove(id, 'in', dx),
    onEnd: (dx) => onDragEnd(id, 'in', dx),
  });
  const rightHandle = useHorizontalDrag({
    onStart: () => onDragStart(id, 'out'),
    onMove: (dx) => onDragMove(id, 'out', dx),
    onEnd: (dx) => onDragEnd(id, 'out', dx),
  });
  const label = clip.callout
    ? `${CALLOUT_GLYPH[clip.callout.variant]} ${clip.text ?? ''}`.trim()
    : clip.text ?? (asset?.label ?? asset?.originalName ?? 'sticker').replace(/\.[^.]+$/, '');
  return (
    <View
      {...drag}
      accessibilityRole="button"
      accessibilityLabel={`sticker ${label}`}
      onAccessibilityTap={() => onSelect(id)}
      style={[
        styles.sticker,
        { left: clip.start * pxPerSec, width, top: row * (height + 2), height },
        selected && styles.stickerSelected,
      ]}
    >
      <Text numberOfLines={1} {...sensitive} style={styles.stickerText}>{label}</Text>
      {selected && (
        <>
          <View {...leftHandle} hitSlop={{ top: 10, bottom: 10, left: 12, right: 4 }} style={[styles.handle, styles.handleLeft, styles.handleVisible]} />
          <View {...rightHandle} hitSlop={{ top: 10, bottom: 10, left: 4, right: 12 }} style={[styles.handle, styles.handleRight, styles.handleVisible]} />
        </>
      )}
    </View>
  );
});

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

interface EmptyLaneProps {
  /** Opens the file picker; also the retry affordance after a failed import. */
  onPress: () => void;
  /** Files dropped on the lane. Never called off web, where nothing can be dropped. */
  onDropFiles: (files: File[]) => void;
  uploading: boolean;
  progress: ImportProgress | undefined;
  error: string | undefined;
}

/**
 * Empty-state block shown when a video track has no clips at all: a press opens
 * the file picker, and on web a dropped file uploads through the same path.
 */
export function EmptyLane({ onPress, onDropFiles, uploading, progress, error }: EmptyLaneProps) {
  const ref = useRef<View>(null);
  const [dropping, setDropping] = useState(false);

  // react-native-web 0.21 picks View props from a whitelist that has no drag
  // events, so the DOM node has to be wired by hand. Native has no drop target
  // at all, hence the platform guard rather than a no-op listener.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;
    // Without preventDefault the browser navigates to the dropped file.
    const onOver = (event: DragEvent): void => { event.preventDefault(); setDropping(true); };
    // Moving onto the label inside fires a bubbling dragleave; only a pointer
    // that actually left the block should clear the highlight.
    const onLeave = (event: DragEvent): void => {
      if (!node.contains(event.relatedTarget as Node | null)) setDropping(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      setDropping(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onDropFiles(files);
    };
    node.addEventListener('dragover', onOver);
    node.addEventListener('dragleave', onLeave);
    node.addEventListener('drop', onDrop);
    return () => {
      node.removeEventListener('dragover', onOver);
      node.removeEventListener('dragleave', onLeave);
      node.removeEventListener('drop', onDrop);
    };
  }, [onDropFiles]);

  const label = dropping ? 'DROP TO IMPORT'
    : progress ? `UPLOADING ${describeImport(progress).toUpperCase()}`
    : uploading ? 'UPLOADING…'
    : '+  IMPORT MEDIA TO START THE TIMELINE';
  const fraction = progress ? importFraction(progress) : undefined;
  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      disabled={uploading}
      style={[styles.empty, dropping ? styles.emptyDropping : null, error ? styles.emptyError : null]}
      accessibilityRole="button"
    >
      <Text style={styles.emptyText}>{label}</Text>
      {fraction !== undefined && <ProgressBar fraction={fraction} style={styles.emptyProgress} />}
      {error ? <Text style={styles.emptyErrorText} numberOfLines={2}>{error} · TAP TO RETRY</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    position: 'absolute', top: 0, borderRadius: radius.md, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.panelSunken,
  },
  blockSelected: { borderColor: colors.accent, borderWidth: 1 },
  blockDragging: { opacity: 0.92, borderColor: colors.text },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#05040A40' },
  waveform: {
    position: 'absolute', left: 2, right: 2, bottom: 0,
    flexDirection: 'row', alignItems: 'flex-end', gap: 1, opacity: 0.38,
  },
  waveformBar: { flex: 1, minWidth: 1, backgroundColor: colors.muted },
  meta: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 15, paddingHorizontal: space.md,
    flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: '#05040ACC',
  },
  number: { color: '#FFFFFF', fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.4 },
  name: { flex: 1, color: '#FFFFFFCC', fontFamily: fonts.semibold, fontSize: type.xs },
  badges: { position: 'absolute', bottom: 4, left: 6, right: 6, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  badge: { borderRadius: radius.md, backgroundColor: '#00000099', paddingHorizontal: space.sm, paddingVertical: space.xs },
  badgeAccent: { backgroundColor: colors.accentStrong },
  badgeText: { color: '#FFFFFF', fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.4 },
  transition: {
    position: 'absolute', left: 0, top: 15, width: 10, height: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#05040A99', borderBottomRightRadius: radius.md,
  },
  transitionGlyph: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.sm },
  handle: {
    position: 'absolute', top: 0, bottom: 0, width: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#0B0B0F55',
  },
  handleVisible: { backgroundColor: colors.accent },
  handleLeft: { left: 0 },
  handleRight: { right: 0 },
  grip: { width: 2, height: 16, borderRadius: radius.sm, backgroundColor: '#FFFFFFAA' },
  caption: {
    position: 'absolute', borderRadius: radius.md, justifyContent: 'center', paddingHorizontal: space.md,
    backgroundColor: '#26303A', borderWidth: 1, borderColor: '#3A4A58',
  },
  captionOverlap: { backgroundColor: colors.warnSoft, borderColor: colors.warn },
  captionSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  captionText: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.xs },
  captionTextOverlap: { color: colors.warn },
  sticker: {
    position: 'absolute', borderRadius: radius.md, justifyContent: 'center', paddingHorizontal: space.md,
    backgroundColor: '#332B26', borderWidth: 1, borderColor: '#4E4238',
  },
  stickerSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  stickerText: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.sm },
  ghost: {
    position: 'absolute', top: 0, borderRadius: radius.md, borderWidth: 1,
    borderColor: '#FFFFFF33', borderStyle: 'dashed', backgroundColor: '#FFFFFF08',
  },
  tooltip: {
    position: 'absolute', top: -2, borderRadius: radius.sm, backgroundColor: colors.accentStrong,
    paddingHorizontal: space.sm, paddingVertical: space.xs, zIndex: 40,
  },
  tooltipText: { color: '#FFFFFF', fontFamily: fonts.bold, fontSize: type.xs },
  empty: {
    position: 'absolute', left: 0, top: 8, minHeight: 44, width: 320, borderRadius: radius.md,
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 6,
  },
  emptyDropping: { borderColor: colors.accent, borderStyle: 'solid', backgroundColor: colors.accentSoft },
  emptyError: { borderColor: colors.danger },
  emptyText: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1 },
  emptyProgress: { marginTop: space.md, width: '60%', maxWidth: 280 },
  emptyErrorText: { color: colors.danger, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.6, marginTop: space.sm, textAlign: 'center' },
});
