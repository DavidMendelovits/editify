import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import type { AssetDissection, AssetMetadata, Clip, Operation, Project, Track } from '@editify/shared';
import { clipTimelineDuration } from '@editify/shared';
import { CaptionChip, DragGhost, DragTooltip, EmptyLane, StickerChip, TimelineClip, type DragMode } from './TimelineClip';
import { Inspector } from './Inspector';
import { useHorizontalDrag } from './useHorizontalDrag';
import { usePlayhead, usePlayheadSelector, type PlayheadClock } from './usePlayback';
import { colors } from '../../lib/theme';
import {
  CAPTION_ROW_HEIGHT, LANE_GUTTER, MAX_PX_PER_SEC, MIN_PX_PER_SEC, SNAP_PX, VIDEO_LANE_HEIGHT,
  beatTargets, captionRows, clampStart, clipEnd, closeGapUpdates, findClip, formatTimecode, patchClip, patchStarts,
  removeClip, snapTargets, snapTime, sortClips, tickStep, trackOfClip, trimInPreview, trimOutPreview,
} from '../../lib/timeline';

const RULER_HEIGHT = 24;
const LANE_PADDING = 6;
/** Below this much travel a release counts as a click, not a drag. */
const CLICK_SLOP = 4;

interface Props {
  project: Project;
  assets: Record<string, AssetMetadata | undefined>;
  clock: PlayheadClock;
  playing: boolean;
  selectedId: string | undefined;
  pending: boolean;
  errorMessage: string | undefined;
  onSeek: (time: number) => void;
  /** Ruler grab / release — the preview swaps to filmstrip posters in between. */
  onScrub: (scrubbing: boolean) => void;
  onSelect: (clipId: string | undefined) => void;
  /** Applies ops on the server; `optimistic` paints the result before the round trip. */
  onApply: (ops: Operation[], optimistic?: (project: Project) => Project) => void;
  onImport: () => void;
  onAddSound: () => void;
  onAddSticker: () => void;
  onCleanup: () => void;
  onRecordVoice: () => void;
  onStyle: () => void;
}

interface DragState { clipId: string; mode: DragMode; dx: number }

interface Lane { track: Track; height: number; label: string; sublabel: string; rowCount: number }

const round6 = (value: number): number => Number(value.toFixed(6));

/**
 * The timeline: ruler, one lane per track, absolutely positioned clip blocks,
 * a draggable playhead, and the edit toolbar.
 *
 * Zoom is `pxPerSec`; every block is `left = start * pxPerSec` wide
 * `timelineDuration * pxPerSec`. Drags are previewed locally (ghost + tooltip)
 * and only committed as operations on release.
 *
 * The playhead is deliberately not a prop: only `PlayheadCursor` subscribes to
 * it per frame, so the lanes and their filmstrips are untouched during
 * playback. Everything here reads the current time imperatively.
 */
export function Timeline({
  project, assets, clock, playing, selectedId, pending, errorMessage, onSeek, onScrub, onSelect, onApply, onImport, onAddSound, onAddSticker, onCleanup, onRecordVoice, onStyle,
}: Props) {
  const [pxPerSec, setPxPerSec] = useState(40);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [drag, setDrag] = useState<DragState>();
  const scrollRef = useRef<ScrollView>(null);
  const scrollX = useRef(0);
  const scrubStart = useRef(0);
  const fitted = useRef(false);
  // Culling window anchor, in content px. Updated with a half-buffer
  // hysteresis so ordinary scrolling re-renders the lanes only once per
  // half-screen of travel, not once per scroll event.
  const [cullStart, setCullStart] = useState(0);
  const cullAnchor = useRef(0);

  // Viewport culling: a long, zoomed-in project renders only what intersects
  // the visible window plus one screen of buffer on each side. Selected and
  // dragged clips always render — unmounting a chip mid-gesture kills it.
  const cullBuffer = Math.max(viewportWidth, 600);
  const cullFrom = cullStart - cullBuffer;
  const cullTo = cullStart + viewportWidth + cullBuffer;
  const inWindow = (left: number, width: number): boolean => left + width >= cullFrom && left <= cullTo;
  const chipVisible = (clip: Clip): boolean =>
    inWindow(clip.start * pxPerSec, Math.max(6, clipTimelineDuration(clip) * pxPerSec))
    || clip.id === selectedId || clip.id === drag?.clipId;

  const lanes = useMemo<Lane[]>(() => project.tracks.flatMap((track) => {
    // Support lanes appear once they have content; the video lane always shows.
    if ((track.kind === 'audio' || track.kind === 'overlay') && track.clips.length === 0) return [];
    if (track.kind === 'caption' || track.kind === 'overlay') {
      const rowCount = captionRows(track.clips).rowCount;
      return [{
        track,
        height: rowCount * CAPTION_ROW_HEIGHT + (rowCount - 1) * 2,
        label: track.kind === 'caption' ? 'CC' : 'ST',
        sublabel: track.kind === 'caption' ? 'CAPTIONS' : 'STICKERS',
        rowCount,
      }];
    }
    return [{
      track,
      height: VIDEO_LANE_HEIGHT,
      label: track.kind === 'video' ? 'V1' : 'A1',
      sublabel: track.kind.toUpperCase(),
      rowCount: 1,
    }];
  }), [project.tracks]);

  const videoTrack = project.tracks.find((track) => track.kind === 'video');

  // Measured audio onsets, in timeline seconds, for snapping and the lane ticks.
  // Cache-only: dissection is expensive, so the timeline shows beats once
  // something else (the dissect panel, the agent) has measured the asset.
  // ponytail: read at render time, so beats appear on the next render after
  // that query resolves rather than the instant it does.
  const queryClient = useQueryClient();
  const beats = useMemo(
    () => beatTargets(videoTrack?.clips ?? [], (assetId) =>
      queryClient.getQueryData<AssetDissection>(['dissect', assetId])?.energyPeaks),
    [queryClient, videoTrack?.clips],
  );
  // Memoized so a drag, which re-renders the lanes on every move, reconciles
  // the same elements instead of rebuilding up to MAX_BEAT_TARGETS views.
  // Only the ticks inside the culling window become views at all; the full
  // beat list still feeds snapping regardless of what is on screen.
  const beatTicks = useMemo(() => beats
    .filter((time) => time * pxPerSec >= cullFrom && time * pxPerSec <= cullTo)
    .map((time) => (
      <View key={time.toFixed(4)} pointerEvents="none" style={[styles.beatTick, { left: time * pxPerSec }]} />
    )), [cullFrom, cullTo, beats, pxPerSec]);

  const selected = findClip(project, selectedId);
  const selectedTrack = selectedId ? trackOfClip(project, selectedId) : undefined;
  const duration = Math.max(project.duration, 1);
  const contentWidth = Math.max(viewportWidth, duration * pxPerSec + 160);
  const lanesHeight = lanes.reduce((total, lane) => total + lane.height + LANE_PADDING * 2, 0);

  // Default zoom fits the whole project into the viewport, once per project.
  useEffect(() => {
    if (fitted.current || viewportWidth <= 0 || project.duration <= 0) return;
    fitted.current = true;
    setPxPerSec(clampZoom((viewportWidth - 24) / project.duration));
  }, [project.duration, viewportWidth]);

  const ruler = useHorizontalDrag({
    onStart: (localX) => { onScrub(true); scrubStart.current = localX / pxPerSec; onSeek(Math.max(0, scrubStart.current)); },
    onMove: (dx) => onSeek(Math.max(0, scrubStart.current + dx / pxPerSec)),
    onEnd: () => onScrub(false),
  });

  function moveTarget(track: Track | undefined, clip: Clip, deltaSeconds: number): number {
    const tolerance = SNAP_PX / pxPerSec;
    const targets = snapTargets(track, clip.id, clock.get(), beats);
    const raw = Math.max(0, clip.start + deltaSeconds);
    const span = clipTimelineDuration(clip);
    const byStart = snapTime(raw, targets, tolerance);
    const byEnd = snapTime(raw + span, targets, tolerance) - span;
    const chosen = Math.abs(byStart - raw) <= Math.abs(byEnd - raw) ? byStart : byEnd;
    return clampStart(track, clip, Math.max(0, chosen));
  }

  /** Snapped edge travel for a trim, in timeline seconds. */
  function trimDelta(track: Track | undefined, clip: Clip, mode: DragMode, deltaSeconds: number): number {
    const tolerance = SNAP_PX / pxPerSec;
    const targets = snapTargets(track, clip.id, clock.get(), beats);
    const edge = mode === 'in' ? clip.start : clipEnd(clip);
    return snapTime(edge + deltaSeconds, targets, tolerance) - edge;
  }

  /**
   * The trim ceiling for a clip's right edge. Stickers and captions have no
   * source to run out of; a video clip whose asset has not loaded yet is
   * locked (extending into unknown footage used to commit out-of-range trims).
   */
  function sourceCeiling(track: Track, clip: Clip): number | undefined {
    if (track.kind === 'overlay' || track.kind === 'caption') return Number.POSITIVE_INFINITY;
    return clip.assetId ? assets[clip.assetId]?.duration : Number.POSITIVE_INFINITY;
  }

  /** The clip as it should be drawn right now — drag preview applied. */
  function previewClip(clip: Clip, track: Track): Clip {
    if (!drag || drag.clipId !== clip.id) return clip;
    const delta = drag.dx / pxPerSec;
    if (drag.mode === 'move') return { ...clip, start: moveTarget(track, clip, delta) };
    const trim = drag.mode === 'in'
      ? trimInPreview(track, clip, trimDelta(track, clip, 'in', delta))
      : trimOutPreview(track, clip, trimDelta(track, clip, 'out', delta), sourceCeiling(track, clip));
    return { ...clip, in: trim.in, out: trim.out, start: trim.start };
  }

  // A light haptic tick each time a dragged edge magnets onto a new snap
  // target (FCP-for-iPad's signature detail) — beats included, since they are
  // just more targets. Web has no haptics.
  const lastSnap = useRef<number | undefined>(undefined);
  function feelSnap(clip: Clip, track: Track, mode: DragMode, dx: number): void {
    if (Platform.OS === 'web') return;
    const delta = dx / pxPerSec;
    const edge = mode === 'out' ? clipEnd(clip) : clip.start;
    const raw = edge + delta;
    const snapped = snapTime(raw, snapTargets(track, clip.id, clock.get(), beats), SNAP_PX / pxPerSec);
    const hit = Math.abs(snapped - raw) > 1e-9 ? snapped : undefined;
    if (hit !== undefined && hit !== lastSnap.current) void Haptics.selectionAsync();
    lastSnap.current = hit;
  }

  function commit(clip: Clip, track: Track, mode: DragMode, dx: number): void {
    setDrag(undefined);
    onSelect(clip.id);
    if (Math.abs(dx) < CLICK_SLOP) return;
    const delta = dx / pxPerSec;

    if (mode === 'move') {
      const start = round6(moveTarget(track, clip, delta));
      if (Math.abs(start - clip.start) < 1e-4) return;
      const operation: Operation = track.kind === 'caption'
        ? { type: 'update_caption', params: { clipId: clip.id, start } }
        : { type: 'set_clip_properties', params: { updates: [{ clipId: clip.id, start }] } };
      onApply([operation], (current) => patchClip(current, clip.id, { start }));
      return;
    }

    const trim = mode === 'in'
      ? trimInPreview(track, clip, trimDelta(track, clip, 'in', delta))
      : trimOutPreview(track, clip, trimDelta(track, clip, 'out', delta), sourceCeiling(track, clip));
    if (Math.abs(trim.in - clip.in) < 1e-4 && Math.abs(trim.out - clip.out) < 1e-4) return;
    const ops: Operation[] = [{
      type: 'trim_clip',
      params: mode === 'in' ? { clipId: clip.id, in: round6(trim.in) } : { clipId: clip.id, out: round6(trim.out) },
    }];
    if (Math.abs(trim.start - clip.start) > 1e-6) {
      ops.push({ type: 'set_clip_properties', params: { updates: [{ clipId: clip.id, start: round6(trim.start) }] } });
    }
    onApply(ops, (current) => patchClip(current, clip.id, { in: trim.in, out: trim.out, start: trim.start }));
  }

  // Stable chip callbacks: the chips are memoized, so these must keep one
  // identity for the life of the timeline. They read the live implementations
  // through a ref and resolve the clip and track by id at event time.
  const chipImpl = { project, onSelect, setDrag, feelSnap, commit };
  const chipImplRef = useRef(chipImpl);
  chipImplRef.current = chipImpl;
  const chipSelect = useCallback((clipId: string) => chipImplRef.current.onSelect(clipId), []);
  const chipDragStart = useCallback((clipId: string, mode: DragMode) => {
    chipImplRef.current.onSelect(clipId);
    chipImplRef.current.setDrag({ clipId, mode, dx: 0 });
  }, []);
  const chipDragMove = useCallback((clipId: string, mode: DragMode, dx: number) => {
    const { project: current, feelSnap: feel, setDrag: set } = chipImplRef.current;
    const clip = findClip(current, clipId);
    const track = trackOfClip(current, clipId);
    if (clip && track) feel(clip, track, mode, dx);
    set({ clipId, mode, dx });
  }, []);
  const chipDragEnd = useCallback((clipId: string, mode: DragMode, dx: number) => {
    const { project: current, commit: commitDrag } = chipImplRef.current;
    const clip = findClip(current, clipId);
    const track = trackOfClip(current, clipId);
    if (clip && track) commitDrag(clip, track, mode, dx);
  }, []);

  // A boolean, not a time: the selector runs on every tick but only re-renders
  // the toolbar when the playhead enters or leaves the selected clip.
  const splittable = usePlayheadSelector(clock, useCallback(
    (time: number) => Boolean(
      selected && selectedTrack?.kind !== 'caption'
      && time > selected.start + 0.05 && time < clipEnd(selected) - 0.05,
    ),
    [selected, selectedTrack],
  ));
  const gapUpdates = closeGapUpdates(videoTrack);

  function split(): void {
    const at = clock.get();
    if (!selected || selectedTrack?.kind === 'caption') return;
    if (at <= selected.start + 0.05 || at >= clipEnd(selected) - 0.05) return;
    onApply([{ type: 'split_clip', params: { clipId: selected.id, at: round6(at), newClipId: `${selected.id}-s${Date.now()}` } }]);
  }
  function remove(): void {
    if (!selected || !selectedTrack) return;
    const operation: Operation = selectedTrack.kind === 'caption'
      ? { type: 'remove_caption', params: { clipId: selected.id } }
      : { type: 'remove_clip', params: { clipId: selected.id } };
    onApply([operation], (current) => removeClip(current, selected.id));
    onSelect(undefined);
  }
  function closeGaps(): void {
    if (!videoTrack || gapUpdates.length === 0) return;
    onApply(
      [{ type: 'set_clip_properties', params: { updates: gapUpdates } }],
      (current) => patchStarts(current, gapUpdates),
    );
  }
  function zoom(factor: number): void {
    setPxPerSec((current) => clampZoom(current * factor));
  }
  function fit(): void {
    if (viewportWidth > 0 && project.duration > 0) setPxPerSec(clampZoom((viewportWidth - 24) / project.duration));
  }

  const step = tickStep(pxPerSec);
  const firstTick = Math.max(0, Math.floor(cullFrom / pxPerSec / step));
  const lastTick = Math.min(Math.ceil(contentWidth / pxPerSec / step), Math.ceil(cullTo / pxPerSec / step)) + 1;

  return (
    <View style={styles.panel}>
      <View style={styles.toolbar}>
        <Text style={styles.zoneLabel}>TIMELINE</Text>
        <View style={styles.toolGroup}>
          <Tool label="split" hint="at playhead" onPress={split} disabled={!splittable || pending} />
          <Tool label="delete" hint="selected" onPress={remove} disabled={!selected || pending} danger />
          <Tool label="close gaps" hint={gapUpdates.length ? `${gapUpdates.length} moves` : 'none'} onPress={closeGaps} disabled={gapUpdates.length === 0 || pending} />
          {/* `undo` is an operation, not a route — POST /projects/:id/ops carries it. */}
          <Tool label="undo" hint="last batch" onPress={() => onApply([{ type: 'undo', params: {} }])} disabled={pending} />
        </View>
        <View style={styles.toolGroup}>
          <Tool label="♪ sound" hint="at playhead" onPress={onAddSound} disabled={pending} />
          <Tool label="✦ sticker" hint="at playhead" onPress={onAddSticker} disabled={pending} />
          <Tool label="✂ cleanup" hint="fillers & silence" onPress={onCleanup} disabled={pending} />
          <Tool label="⏺ voice" hint="record at playhead" onPress={onRecordVoice} disabled={pending} />
          <Tool label="✨ style" hint="apply a packet" onPress={onStyle} disabled={pending} />
        </View>
        <View style={styles.toolGroup}>
          <Tool label="−" hint="zoom" compact onPress={() => zoom(1 / 1.6)} disabled={pxPerSec <= MIN_PX_PER_SEC} />
          <Text style={styles.zoomValue}>{Math.round(pxPerSec)} px/s</Text>
          <Tool label="+" hint="zoom" compact onPress={() => zoom(1.6)} disabled={pxPerSec >= MAX_PX_PER_SEC} />
          <Tool label="fit" hint="viewport" compact onPress={fit} />
          <Tool label="import" hint="media" compact onPress={onImport} />
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.gutter}>
          <View style={{ height: RULER_HEIGHT }} />
          {lanes.map((lane) => (
            <View key={lane.track.id} style={[styles.gutterLane, { height: lane.height + LANE_PADDING * 2 }]}>
              <Text style={styles.laneName}>{lane.label}</Text>
              <Text style={styles.laneKind}>{lane.sublabel}</Text>
            </View>
          ))}
        </View>

        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator
          scrollEventThrottle={16}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const x = event.nativeEvent.contentOffset.x;
            scrollX.current = x;
            if (Math.abs(x - cullAnchor.current) > cullBuffer / 2) {
              cullAnchor.current = x;
              setCullStart(x);
            }
          }}
          onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
          style={styles.scroll}
          contentContainerStyle={{ width: contentWidth }}
        >
          <View style={{ width: contentWidth }}>
            <View {...ruler} style={[styles.ruler, { width: contentWidth }]}>
              {Array.from({ length: Math.max(0, lastTick - firstTick) }, (_unused, index) => (firstTick + index) * step).map((time) => (
                // Ticks must not become the touch target: the scrub position is
                // read from `locationX`, which is relative to whatever was hit.
                <View key={time} pointerEvents="none" style={[styles.tick, { left: time * pxPerSec }]}>
                  <View style={styles.tickMark} />
                  <Text style={styles.tickLabel}>{formatTimecode(time, step < 1)}</Text>
                </View>
              ))}
            </View>

            {lanes.map((lane) => (
              <View key={lane.track.id} style={[styles.lane, { height: lane.height + LANE_PADDING * 2 }]}>
                <View style={[styles.laneInner, { height: lane.height }]}>
                  {lane.track.kind === 'caption' && captionRows(lane.track.clips).rows.filter(({ clip }) => chipVisible(clip)).map(({ clip, row, overlapping }) => (
                    <CaptionChip
                      key={clip.id}
                      clip={previewClip(clip, lane.track)}
                      pxPerSec={pxPerSec}
                      row={row}
                      height={CAPTION_ROW_HEIGHT}
                      overlapping={overlapping}
                      selected={clip.id === selectedId}
                      onSelect={chipSelect}
                      onDragStart={chipDragStart}
                      onDragMove={chipDragMove}
                      onDragEnd={chipDragEnd}
                    />
                  ))}
                  {lane.track.kind === 'overlay' && captionRows(lane.track.clips).rows.filter(({ clip }) => chipVisible(clip)).map(({ clip, row }) => (
                    <StickerChip
                      key={clip.id}
                      clip={previewClip(clip, lane.track)}
                      asset={clip.assetId ? assets[clip.assetId] : undefined}
                      pxPerSec={pxPerSec}
                      row={row}
                      height={CAPTION_ROW_HEIGHT}
                      selected={clip.id === selectedId}
                      onSelect={chipSelect}
                      onDragStart={chipDragStart}
                      onDragMove={chipDragMove}
                      onDragEnd={chipDragEnd}
                    />
                  ))}
                  {(lane.track.kind === 'video' || lane.track.kind === 'audio') && sortClips(lane.track.clips)
                    .map((clip, index) => ({ clip, index }))
                    .filter(({ clip }) => chipVisible(clip))
                    .map(({ clip, index }) => (
                    <TimelineClip
                      key={clip.id}
                      clip={previewClip(clip, lane.track)}
                      asset={clip.assetId ? assets[clip.assetId] : undefined}
                      index={index}
                      pxPerSec={pxPerSec}
                      height={lane.height}
                      selected={clip.id === selectedId}
                      dragging={drag?.clipId === clip.id}
                      onSelect={chipSelect}
                      onDragStart={chipDragStart}
                      onDragMove={chipDragMove}
                      onDragEnd={chipDragEnd}
                    />
                  ))}
                  {/* Beat ruler along the lane's top edge: what a drag will magnet to. */}
                  {lane.track.kind === 'video' && beatTicks}
                  {lane.track.kind === 'video' && lane.track.clips.length === 0 && <EmptyLane onPress={onImport} />}
                  {lane.track.kind === 'caption' && lane.track.clips.length === 0 && (
                    <Text style={styles.laneHint}>ask the agent to “add captions”</Text>
                  )}
                  {drag && drag.clipId && lane.track.clips.some((clip) => clip.id === drag.clipId) && (() => {
                    const original = lane.track.clips.find((clip) => clip.id === drag.clipId) as Clip;
                    return (
                      <DragGhost
                        left={original.start * pxPerSec}
                        width={Math.max(6, clipTimelineDuration(original) * pxPerSec)}
                        height={lane.track.kind === 'caption' ? CAPTION_ROW_HEIGHT : lane.height}
                      />
                    );
                  })()}
                </View>
              </View>
            ))}

            <PlayheadCursor
              clock={clock}
              pxPerSec={pxPerSec}
              height={RULER_HEIGHT + lanesHeight}
              playing={playing}
              viewportWidth={viewportWidth}
              scrollRef={scrollRef}
              scrollX={scrollX}
            />

            {drag && (() => {
              const clip = findClip(project, drag.clipId);
              const track = trackOfClip(project, drag.clipId);
              if (!clip || !track) return null;
              const preview = previewClip(clip, track);
              const label = drag.mode === 'move'
                ? formatTimecode(preview.start)
                : `${clipTimelineDuration(preview).toFixed(2)}s`;
              return <DragTooltip left={preview.start * pxPerSec} label={label} />;
            })()}
          </View>
        </ScrollView>
      </View>

      <Inspector
        clip={selected}
        asset={selected?.assetId ? assets[selected.assetId] : undefined}
        kind={selectedTrack?.kind}
        pending={pending}
        onApply={(ops, patch) => onApply(ops, (current) => (selected ? patchClip(current, selected.id, patch) : current))}
      />
      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
    </View>
  );
}

/**
 * The only part of the timeline that follows the playhead. It re-renders on
 * every transport tick — a line, a head, and the auto-scroll that keeps them on
 * screen — while the lanes above it stay put.
 */
function PlayheadCursor({ clock, pxPerSec, height, playing, viewportWidth, scrollRef, scrollX }: {
  clock: PlayheadClock;
  pxPerSec: number;
  height: number;
  playing: boolean;
  viewportWidth: number;
  scrollRef: { current: ScrollView | null };
  scrollX: { current: number };
}) {
  const x = usePlayhead(clock) * pxPerSec;

  // Keep the playhead on screen while the transport is running.
  useEffect(() => {
    if (!playing || viewportWidth <= 0) return;
    if (x < scrollX.current + 40 || x > scrollX.current + viewportWidth - 90) {
      scrollRef.current?.scrollTo({ x: Math.max(0, x - viewportWidth * 0.35), animated: false });
    }
  }, [playing, scrollRef, scrollX, viewportWidth, x]);

  return (
    <View pointerEvents="none" style={[styles.playhead, { left: x, height }]}>
      <View style={styles.playheadHead} />
      <View style={styles.playheadLine} />
    </View>
  );
}

function Tool({ label, hint, onPress, disabled, danger, compact }: {
  label: string; hint: string; onPress: () => void; disabled?: boolean; danger?: boolean; compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} ${hint}`}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.tool, compact && styles.toolCompact, danger && styles.toolDanger,
        pressed && styles.pressed, disabled && styles.toolDisabled,
      ]}
    >
      <Text style={[styles.toolLabel, danger && styles.toolLabelDanger]}>{label}</Text>
      {!compact && <Text style={styles.toolHint}>{hint}</Text>}
    </Pressable>
  );
}

function clampZoom(value: number): number {
  return Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, value));
}

const styles = StyleSheet.create({
  panel: { borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 10, gap: 8, minHeight: 0 },
  toolbar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  zoneLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5, marginRight: 'auto' },
  // Wraps so a narrow phone stacks tools instead of clipping the row's tail.
  toolGroup: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap', flexShrink: 1 },
  tool: {
    minWidth: 62, borderRadius: 7, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, paddingHorizontal: 8, paddingVertical: 5,
  },
  toolCompact: { minWidth: 30, alignItems: 'center', justifyContent: 'center' },
  toolDanger: { borderColor: '#5A2836' },
  toolDisabled: { opacity: 0.38 },
  toolLabel: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 10 },
  toolLabelDanger: { color: colors.danger },
  toolHint: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 7, marginTop: 1 },
  zoomValue: { color: colors.muted, fontFamily: 'Montserrat_600SemiBold', fontSize: 8, minWidth: 46, textAlign: 'center' },
  body: { flexDirection: 'row', borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: '#0D0D13', overflow: 'hidden' },
  gutter: { width: LANE_GUTTER, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: '#101017' },
  gutterLane: { justifyContent: 'center', paddingLeft: 8, borderTopWidth: 1, borderTopColor: '#1E1D2A' },
  laneName: { color: colors.purple, fontFamily: 'Montserrat_800ExtraBold', fontSize: 9 },
  laneKind: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 6, letterSpacing: 0.8, marginTop: 2 },
  scroll: { flex: 1 },
  ruler: { height: RULER_HEIGHT, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: '#101017' },
  tick: { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row', alignItems: 'flex-end', paddingBottom: 3 },
  tickMark: { width: 1, height: 7, backgroundColor: '#3A3850' },
  tickLabel: { color: colors.muted, fontFamily: 'Montserrat_600SemiBold', fontSize: 8, marginLeft: 4, fontVariant: ['tabular-nums'] },
  lane: { justifyContent: 'center', paddingVertical: LANE_PADDING, borderTopWidth: 1, borderTopColor: '#1E1D2A' },
  laneInner: { position: 'relative' },
  laneHint: { position: 'absolute', left: 6, top: 4, color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 9 },
  beatTick: { position: 'absolute', top: 0, width: 1, height: 6, backgroundColor: '#4A4767', zIndex: 20 },
  playhead: { position: 'absolute', top: 0, width: 1, alignItems: 'center', zIndex: 30 },
  playheadLine: { flex: 1, width: 1, backgroundColor: colors.pink },
  playheadHead: { width: 9, height: 9, borderRadius: 2, backgroundColor: colors.pink, transform: [{ rotate: '45deg' }], marginBottom: -3 },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 10 },
  pressed: { opacity: 0.65 },
});
