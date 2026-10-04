import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AppState, PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AssetMetadata, Clip, Operation, OverlayPlacement, Project, RenderPlan } from '@editify/shared';
import { EditifyEngine, editifyPlayerView, type EditifyPlayerViewHandle } from '../../../modules/editify-engine';
import { API_URL, assetOriginalUrl, assetProxyUrl, onAccessTokenChange } from '../../lib/api';
import { useEngineActivity } from '../../lib/engine-activity';
import { leaseMedia, type MediaLease } from '../../lib/local-media';
import { localMedia } from '../../lib/local-media-native';
import {
  createPlanStore, followsNativeTime, isExternalSeek, MediaRecovery, PlanFeeder, previewPlanSize, projectAssetRefs, redactMediaToken,
  resolvePreviewMedia, serverPreviewMedia, urlOrigin, type PreviewMedia,
} from '../../lib/native-preview';
import { freshSession } from '../../lib/supabase';
import { tokenClockOffset } from '../../lib/token-clock';
import { colors, fonts, radius, space, type } from '../../lib/theme';
import { formatTimecode } from '../../lib/timeline';
import { PreviewHandles } from './PreviewHandles';
import { usePlayhead, type PlayheadClock } from './usePlayback';

/**
 * The native preview (plan P5, D1 + 6A), behind the `nativePreview` flag on iOS. Same props as
 * PreviewPlayer plus the clock hooks: EditifyPlayerView draws every pixel with the export's
 * renderer, PreviewHandles lays only selection boxes and grips over it.
 *
 *   project ─▶ PlanFeeder (preview plans: revision = version, buildSeq + 1 per send,
 *              edits coalesced, drags patched in place) ─▶ setPlan(plan JSON, media map)
 *   native time events (while playing) ─▶ onTimeUpdate ─▶ the editor's playhead
 *   playhead moved by the user (tap, scrub) ─▶ exact seek (native coalesces a scrub's seeks)
 *   playing ─▶ play() / pause(); native end or interruption ─▶ onEnded
 *   server copies failed (native 'mediaExpired', e.g. a token that expired in the background)
 *     ─▶ refresh the session, resolve the media again, send it as a plan tagged mediaRetry (native
 *        retries on that plan only; edits landing meanwhile apply as usual)
 *   any other native failure, a failed retry, or a project that can't become a plan ─▶
 *     onUnavailable (the editor falls back to PreviewPlayer)
 *
 * Media (resolvePreviewMedia): 1080p proxies when ready, the local original otherwise, the
 * user's server copy for anything not on this iPhone; the local ones stay leased while this
 * is mounted (a new lease is taken before the old one goes), and a proxy finishing (or going
 * away) or a new auth token (server URLs carry it) re-resolves.
 *
 * Scrubbing seeks with a tolerance; the scrub's end lands one exact seek. Native stalls show
 * a small "Buffering" tag.
 */
export interface NativePreviewProps {
  project: Project;
  assets: Record<string, AssetMetadata | undefined>;
  clock: PlayheadClock;
  playing: boolean;
  scrubbing: boolean;
  selectedId: string | undefined;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSelect: (clipId: string | undefined) => void;
  onApply: (ops: Operation[]) => void;
  /** The native clock while playing (usePlayback's `follow`). */
  onTimeUpdate: (time: number) => void;
  /** Native stopped on its own: the timeline ended, or iOS interrupted it. */
  onEnded: () => void;
  /** The native preview can't show this project: the editor switches to PreviewPlayer. */
  onUnavailable: (reason: string) => void;
}

/** What the editor can ask of the preview directly. */
export interface NativePreviewHandle {
  play(): void;
  pause(): void;
  seek(time: number, exact?: boolean): void;
  setMuted(muted: boolean): void;
  /** The last time native reported (the playhead follows it while playing). */
  currentTime(): number;
}

const ASPECT: Record<Project['format'], number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
/** After a proxy event, wait for the registry listener to record it before resolving again. */
const RESOLVE_AFTER_PROXY_MS = 500;

const SERVER = { proxy: assetProxyUrl, original: assetOriginalUrl };
/** The only server native accepts remote media from. */
const API_ORIGIN = urlOrigin(API_URL) ?? undefined;

export const NativePreview = forwardRef<NativePreviewHandle, NativePreviewProps>(function NativePreview(props, ref) {
  const { project, assets, clock, playing, scrubbing, selectedId, onTogglePlay, onSeek, onSelect, onApply, onTimeUpdate, onEnded, onUnavailable } = props;
  const PlayerView = editifyPlayerView();
  const view = useRef<EditifyPlayerViewHandle | null>(null);
  const [wrap, setWrap] = useState({ width: 0, height: 0 });
  const stage = fitStage(wrap, ASPECT[project.format]);
  const ratio = PixelRatio.get();
  const { width: stageWidth, height: stageHeight } = stage;
  const size = useMemo(() => previewPlanSize(project.format, { width: stageWidth, height: stageHeight }, ratio), [project.format, stageWidth, stageHeight, ratio]);
  const plans = useMemo(createPlanStore, []);
  const [dragging, setDragging] = useState(false);
  const [buffering, setBuffering] = useState(false);
  // Handle drags hold the engine's playback flag too: proxies and analyzers wait out a 60 Hz redraw.
  useEngineActivity('playback', dragging);

  // Latest callbacks for the long-lived feeder and native events.
  const live = useRef({ onTimeUpdate, onEnded, onUnavailable, playing, project, assets });
  live.current = { onTimeUpdate, onEnded, onUnavailable, playing, project, assets };
  const unavailable = useCallback((reason: string) => live.current.onUnavailable(redactMediaToken(reason)), []);

  // ─── Media: resolved per asset set, leased while mounted ───
  const refs = useMemo(() => projectAssetRefs(project, assets), [project, assets]);
  const assetKey = refs ? refs.map((item) => `${item.kind}:${item.id}`).sort().join('|') : '';
  const [media, setMedia] = useState<PreviewMedia>();
  const [resolveTick, setResolveTick] = useState(0);
  const refsRef = useRef(refs);
  refsRef.current = refs;
  /** Native asked for fresh media: the next resolve is sent even if its URLs are unchanged. */
  const recoveringMedia = useRef(false);
  /** The resolve that answers native's request: the feeder sends its plan whatever native holds. */
  const forcedMedia = useRef<PreviewMedia | undefined>(undefined);
  const publishMedia = useCallback((next: PreviewMedia) => {
    if (recoveringMedia.current) {
      recoveringMedia.current = false;
      forcedMedia.current = next;
    }
    setMedia(next);
  }, []);
  /** The lease on the media in use: replaced (new first, then old released) on every resolve. */
  const lease = useRef<MediaLease | null>(null);
  useEffect(() => () => {
    lease.current?.release();
    lease.current = null;
  }, []);
  useEffect(() => {
    const wanted = refsRef.current;
    if (!wanted) return undefined;
    let cancelled = false;
    void (async () => {
      const deps = await localMedia();
      if (cancelled) return;
      if (!deps) {
        publishMedia(serverPreviewMedia(wanted, SERVER));
        return;
      }
      // No gap: the old lease holds until the new one is taken.
      const previous = lease.current;
      lease.current = leaseMedia(deps, wanted.map((item) => item.id));
      previous?.release();
      try {
        const resolved = await resolvePreviewMedia(wanted, deps, SERVER);
        if (!cancelled) publishMedia(resolved);
      } catch {
        if (!cancelled) publishMedia(serverPreviewMedia(wanted, SERVER));
      }
    })();
    return () => { cancelled = true; };
  }, [assetKey, resolveTick, publishMedia]);

  // Server URLs carry the auth token (`k=`): a refreshed token mints them again (native reloads only those).
  const hasRemote = (media?.remote.length ?? 0) > 0;
  useEffect(() => {
    if (!hasRemote) return undefined;
    return onAccessTokenChange(() => setResolveTick((tick) => tick + 1));
  }, [hasRemote]);
  const hasRemoteRef = useRef(hasRemote);
  hasRemoteRef.current = hasRemote;

  // Native errors: server copies that failed are resolved again (once); anything else falls back.
  const recovery = useMemo(() => new MediaRecovery({
    reresolve: () => {
      // Flagged first: a refresh that changes the token re-resolves on its own, and that resolve is the one sent.
      recoveringMedia.current = true;
      void freshSession().catch(() => undefined).finally(() => setResolveTick((tick) => tick + 1));
    },
    fallback: unavailable,
  }), [unavailable]);
  useEffect(() => () => recovery.dispose(), [recovery]);
  // JS resolves nothing while the app is in the background: the recovery's timeout waits for it.
  useEffect(() => {
    recovery.setActive(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', (state) => recovery.setActive(state === 'active'));
    return () => subscription.remove();
  }, [recovery]);

  // A proxy became ready (or went away) for an asset on screen: resolve again, so native swaps it in.
  const localIds = media?.local.join('|') ?? '';
  useEffect(() => {
    const engine = EditifyEngine;
    if (!engine || !localIds) return undefined;
    const ids = new Set(localIds.split('|'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = engine.addListener('analysisStatus', (event) => {
      if (event.part !== 'proxy' || !ids.has(event.assetId)) return;
      if (!event.removed && event.status !== 'ready') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setResolveTick((tick) => tick + 1), RESOLVE_AFTER_PROXY_MS);
    });
    return () => {
      subscription.remove();
      if (timer) clearTimeout(timer);
    };
  }, [localIds]);

  // ─── Plans ───
  const feeder = useRef<PlanFeeder | null>(null);
  /** The last plan sent and its media, for a view that attaches after it was built. */
  const lastSent = useRef<{ plan: RenderPlan; media: Record<string, string> } | undefined>(undefined);
  const deliver = useCallback((target: EditifyPlayerViewHandle, next: RenderPlan, map: Record<string, string>, mediaRetry = false) => {
    // Options only when there are any (an older binary's setPlan takes two arguments).
    const offset = tokenClockOffset();
    const options = { ...(mediaRetry ? { mediaRetry: true } : {}), ...(offset !== undefined ? { tokenClockOffset: offset } : {}) };
    const sent = Object.keys(options).length > 0 ? target.setPlan(JSON.stringify(next), map, options) : target.setPlan(JSON.stringify(next), map);
    sent.catch((error: unknown) => {
      unavailable(`setPlan: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [unavailable]);
  const feederFor = (): PlanFeeder => {
    if (feeder.current) return feeder.current;
    feeder.current = new PlanFeeder({
      send: (next, map, mediaRetry) => {
        plans.set(next);
        lastSent.current = { plan: next, media: map };
        if (mediaRetry) recovery.retrySent(next.buildSeq);
        if (view.current) deliver(view.current, next, map, mediaRetry);
      },
      onUnbuildable: () => {
        // Assets still loading is a wait, not a failure.
        const { project: current, assets: known } = live.current;
        const ids = current.tracks.flatMap((track) => track.clips).flatMap((clip) => (clip.assetId ? [clip.assetId] : []));
        if (ids.every((id) => known[id] !== undefined)) unavailable('plan');
      },
    });
    return feeder.current;
  };
  // A new feeder (buildSeq from 1) only ever goes with a new view, whose ordering starts afresh.
  useEffect(() => () => {
    feeder.current?.dispose();
    feeder.current = null;
  }, []);
  useEffect(() => {
    // Media resolved for an older set of assets (a clip was just added): wait for the new map.
    if (!size || !media || !refs || refs.some((item) => media.media[item.id] === undefined)) return;
    // The resolve native asked for goes as the tagged retry, even if its URLs didn't change.
    const mediaRetry = forcedMedia.current === media;
    if (mediaRetry) forcedMedia.current = undefined;
    feederFor().update({ project, assets, size, media: media.media, geometry: media.geometry }, mediaRetry);
  }, [project, assets, size, media, refs]);
  const attach = useCallback((node: EditifyPlayerViewHandle | null) => {
    view.current = node;
    if (node && lastSent.current) deliver(node, lastSent.current.plan, lastSent.current.media);
  }, [deliver]);

  const onDrag = useCallback((clip: Clip, placement: OverlayPlacement) => {
    setDragging(true);
    feeder.current?.drag(clip, placement);
  }, []);
  const onDragEnd = useCallback((committed: boolean) => {
    setDragging(false);
    feeder.current?.endDrag(committed);
  }, []);

  // ─── The clock ───
  /** The last time native reported and the playhead took; anything else on the clock is a user seek. */
  const reported = useRef<number | undefined>(undefined);
  /** The first item lands at 0: bring it to the playhead once (later rebuilds keep their own time). */
  const placed = useRef(false);
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  useEffect(() => clock.subscribe(() => {
    const time = clock.get();
    if (!isExternalSeek(time, reported.current)) return;
    reported.current = time;
    // Mid-scrub, any nearby frame will do (fast); the scrub's end lands exactly (below).
    void view.current?.seek(time, !scrubbingRef.current).catch(() => undefined);
  }), [clock]);
  const wasScrubbing = useRef(scrubbing);
  useEffect(() => {
    if (wasScrubbing.current && !scrubbing) void view.current?.seek(clock.get(), true).catch(() => undefined);
    wasScrubbing.current = scrubbing;
  }, [clock, scrubbing]);
  useEffect(() => {
    const target = view.current;
    if (!target) return;
    if (playing) void target.play().catch(() => undefined);
    else void target.pause().catch(() => undefined);
  }, [playing]);

  useImperativeHandle(ref, () => ({
    play: () => { void view.current?.play().catch(() => undefined); },
    pause: () => { void view.current?.pause().catch(() => undefined); },
    seek: (time, exact = true) => { void view.current?.seek(time, exact).catch(() => undefined); },
    setMuted: (muted) => { void view.current?.setMuted(muted).catch(() => undefined); },
    currentTime: () => reported.current ?? clock.get(),
  }), [clock]);

  if (!PlayerView) return null;
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.zoneLabel}>PREVIEW</Text>
        <Text style={styles.meta} numberOfLines={1}>{project.format} · {project.fps} FPS · V{project.version}</Text>
      </View>
      <View
        style={styles.stageWrap}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setWrap((current) => (current.width === width && current.height === height ? current : { width, height }));
        }}
      >
        <View style={[styles.stage, { width: stage.width, height: stage.height }]}>
          <PlayerView
            ref={attach}
            style={StyleSheet.absoluteFill}
            apiOrigin={API_ORIGIN}
            onStall={(event) => setBuffering(event.nativeEvent.buffering)}
            onReady={() => {
              if (placed.current) return;
              placed.current = true;
              reported.current = clock.get();
              void view.current?.seek(clock.get(), true).catch(() => undefined);
              if (live.current.playing) void view.current?.play().catch(() => undefined);
            }}
            onTime={(event) => {
              const { time, playing: nativePlaying } = event.nativeEvent;
              if (!followsNativeTime({ playing: nativePlaying }, live.current.playing)) return;
              reported.current = time;
              live.current.onTimeUpdate(time);
            }}
            onEnded={(event) => {
              if (event.nativeEvent.reason === 'end') {
                reported.current = live.current.project.duration;
                live.current.onTimeUpdate(live.current.project.duration);
              }
              live.current.onEnded();
            }}
            onError={(event) => recovery.onError(event.nativeEvent, hasRemoteRef.current)}
            onPlan={(event) => recovery.onPlan(event.nativeEvent)}
          />
          {buffering && (
            <View pointerEvents="none" style={styles.buffering}>
              <Text style={styles.bufferingText}>Buffering</Text>
            </View>
          )}
          {stage.width > 0 && (
            <PreviewHandles
              plans={plans}
              project={project}
              clock={clock}
              view={stage}
              selectedId={selectedId}
              onSelect={onSelect}
              onApply={onApply}
              onDrag={onDrag}
              onDragEnd={onDragEnd}
            />
          )}
        </View>
      </View>
      <View style={styles.transport}>
        <Control label="|◀" hint="start" onPress={() => onSeek(0)} />
        <Control label={playing ? '❚❚' : '▶'} hint={playing ? 'pause' : 'play'} primary onPress={onTogglePlay} />
        <Timecode clock={clock} />
        <Text style={styles.timecodeMuted}>/ {formatTimecode(project.duration)}</Text>
      </View>
    </View>
  );
});

/** Largest box of `aspect` (w/h) that fits inside the measured wrapper. */
function fitStage(wrap: { width: number; height: number }, aspect: number): { width: number; height: number } {
  if (wrap.width <= 0 || wrap.height <= 0) return { width: 0, height: 0 };
  const width = Math.min(wrap.width, wrap.height * aspect);
  return { width, height: width / aspect };
}

function Timecode({ clock }: { clock: PlayheadClock }) {
  return <Text style={styles.timecode}>{formatTimecode(usePlayhead(clock))}</Text>;
}

function Control({ label, hint, onPress, primary }: { label: string; hint: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.control, primary && styles.controlPrimary, pressed && styles.pressed]}
    >
      <Text style={[styles.controlText, primary && styles.controlTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 220, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelSunken, padding: space.lg, gap: space.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  zoneLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  meta: { color: colors.muted, fontFamily: fonts.semibold, fontSize: type.sm, flexShrink: 1 },
  stageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 140 },
  stage: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#000000' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  control: { minWidth: 30, height: 26, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  controlPrimary: { backgroundColor: colors.accentStrong, borderColor: colors.accentStrong },
  controlText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.base },
  controlTextPrimary: { color: '#FFFFFF' },
  timecode: { color: colors.text, fontFamily: fonts.bold, fontSize: type.base, fontVariant: ['tabular-nums'] },
  timecodeMuted: { color: colors.muted, fontFamily: fonts.semibold, fontSize: type.base, fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.65 },
  buffering: { position: 'absolute', top: space.sm, left: space.sm, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: 'rgba(17,17,19,0.8)' },
  bufferingText: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.xs },
});
