import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { VideoPlayer } from 'expo-video';
import type { AssetMetadata, CaptionStyle, Clip, Project } from '@editify/shared';
import { colors } from '../../lib/theme';
import { clipAt, formatTimecode, sortClips } from '../../lib/timeline';
import { usePlayhead, type PlayheadClock } from './usePlayback';

const ASPECT: Record<Project['format'], number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
/** Seek the element back into sync once it drifts further than this from the playhead. */
const DRIFT_PLAYING = 0.35;
const DRIFT_PAUSED = 0.08;
/**
 * Minimum spacing between drift corrections. The playhead ticks at ~60Hz, so
 * without this a single lagging asset gets a seek every frame and each one
 * cancels the last, leaving the element permanently behind.
 */
const CORRECTION_INTERVAL_PLAYING = 250;
const CORRECTION_INTERVAL_PAUSED = 100;

interface Props {
  project: Project;
  assets: Record<string, AssetMetadata | undefined>;
  clock: PlayheadClock;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
}

/** Which of the two players is on screen; the other one prebuffers the next asset. */
type Slot = 0 | 1;

/**
 * What a player holds. `loaded` is only written once `replaceAsync` resolves, so
 * nothing seeks into a still-buffering element; `pending` is the in-flight
 * target, which is what the element will show next and therefore what a repeat
 * request has to compare against. `generation` lets a superseded load discard
 * its own completion.
 */
interface SlotState { loaded: string | undefined; pending: string | undefined; generation: number }

/** What the element will end up showing — the in-flight load wins over the settled one. */
function shownBy(state: SlotState): string | undefined {
  return state.pending ?? state.loaded;
}

/** True once `uri` is loaded and nothing newer is on its way: safe to seek and to show. */
function settledOn(state: SlotState, uri: string): boolean {
  return state.loaded === uri && state.pending === undefined;
}

/**
 * Timeline playback — not per-clip playback.
 *
 * The playhead is the source of truth (it is advanced by the transport's rAF
 * loop and read here per frame, so only this subtree re-renders while playing).
 * This component maps the playhead onto the active video clip, swaps the
 * proxy source when it crosses a clip boundary, seeks to
 * `in + (playhead - start) * speed`, and corrects drift as it plays. Gaps
 * simply show black.
 *
 * Two players ping-pong so a cut is not a cold load: while the front player
 * plays, the standby one loads the next asset and parks on its first frame,
 * and the boundary is just a role swap. Only the front player is audible.
 */
export function PreviewPlayer({ project, assets, clock, playing, onTogglePlay, onSeek }: Props) {
  const playhead = usePlayhead(clock);
  // The stage is measured, not flex-sized: `aspectRatio` alone gives a View with
  // only absolutely positioned children a 0x0 box, which clipped the video away
  // (audible but invisible) since the stage also clips overflow.
  const [wrap, setWrap] = useState({ width: 0, height: 0 });
  const stage = fitStage(wrap, ASPECT[project.format]);
  const videoClips = sortClips(project.tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips));
  const captionClips = project.tracks.filter((track) => track.kind === 'caption').flatMap((track) => track.clips);
  const active = clipAt(videoClips, playhead);
  const asset = active?.assetId ? assets[active.assetId] : undefined;
  // No URI until the proxy exists — it flips undefined→url when processing
  // finishes, which is what triggers replaceAsync to actually load it.
  const uri = asset?.status === 'ready' ? asset.proxyUrl : undefined;
  const speed = active?.speed ?? 1;
  const sourceTime = active ? active.in + (playhead - active.start) * speed : 0;
  const caption = clipAt(captionClips, playhead);
  const upcoming = prebufferTarget(videoClips, assets, playhead, uri);
  const nextUri = upcoming?.uri;
  const nextIn = upcoming?.in ?? 0;

  // Created once with an empty source; boundaries are handled by replaceAsync
  // so playback does not tear down the element on every cut.
  const playerA = useVideoPlayer(null, configurePlayer);
  const playerB = useVideoPlayer(null, configurePlayer);
  const [frontSlot, setFrontSlot] = useState<Slot>(0);
  const standbySlot: Slot = frontSlot === 0 ? 1 : 0;
  const front = frontSlot === 0 ? playerA : playerB;
  const standby = frontSlot === 0 ? playerB : playerA;

  const slots = useRef<[SlotState, SlotState]>([
    { loaded: undefined, pending: undefined, generation: 0 },
    { loaded: undefined, pending: undefined, generation: 0 },
  ]);
  const lastCorrection = useRef(0);
  const frontSlotRef = useRef(frontSlot);
  frontSlotRef.current = frontSlot;
  const viewA = useRef<VideoView>(null);
  const viewB = useRef<VideoView>(null);
  const sourceTimeRef = useRef(sourceTime);
  sourceTimeRef.current = sourceTime;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // expo-video's web player echoes every `play`/`pause` DOM event straight back
  // onto the same element. `replace()` pauses and then plays, so both handlers
  // end up regenerating each other — thousands of play/pause pairs a second,
  // which freezes the picture and shreds the audio. We drive the element
  // ourselves, so the echo is pure cost. Native platforms are unaffected.
  // Detaching also pauses on unmount: a removed <video> keeps its audio going.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const elements = [viewA.current, viewB.current]
      .map((view) => view?.nativeRef?.current as HTMLVideoElement | null | undefined);
    for (const element of elements) {
      if (!element) continue;
      element.onplay = null;
      element.onpause = null;
    }
    return () => { for (const element of elements) element?.pause(); };
  }, []);

  // The boundary. Either the standby already holds what we need — then the cut
  // costs one role swap — or the user landed somewhere unbuffered and the front
  // player loads it the slow way.
  useEffect(() => {
    const state = slots.current[frontSlot];
    if (!uri || shownBy(state) === uri) return;
    if (settledOn(slots.current[standbySlot], uri)) {
      front.pause();
      front.muted = true;
      standby.muted = false;
      // The incoming player is parked on the cut, but a swap can also come from
      // a scrub; let the drift corrector run immediately rather than wait out
      // its interval on a stale frame.
      lastCorrection.current = 0;
      setFrontSlot(standbySlot);
      return;
    }
    const started = ++state.generation;
    state.pending = uri;
    front.muted = false;
    void front.replaceAsync(uri).then(() => {
      if (state.generation !== started) return;
      state.pending = undefined;
      state.loaded = uri;
      // A swap can demote this player while its load was in flight — the
      // demoted slot must not start playing hidden in the background.
      if (frontSlotRef.current !== frontSlot) {
        front.pause();
        return;
      }
      front.currentTime = sourceTimeRef.current;
      // `replace` starts playback unconditionally, so a swap made while paused
      // has to be put back to sleep.
      if (playingRef.current) front.play();
      else front.pause();
    }).catch(() => {
      if (state.generation !== started) return;
      state.pending = undefined;
      state.loaded = undefined;
    });
  }, [front, frontSlot, standby, standbySlot, uri]);

  // Prebuffer: keyed on the next asset rather than the playhead, so it runs once
  // per cut instead of once per frame.
  useEffect(() => {
    const state = slots.current[standbySlot];
    if (!nextUri || shownBy(state) === nextUri || shownBy(slots.current[frontSlot]) === nextUri) return;
    const started = ++state.generation;
    state.pending = nextUri;
    standby.muted = true;
    void standby.replaceAsync(nextUri).then(() => {
      if (state.generation !== started) return;
      state.pending = undefined;
      state.loaded = nextUri;
      standby.currentTime = nextIn;
      standby.pause();
    }).catch(() => {
      if (state.generation !== started) return;
      state.pending = undefined;
      state.loaded = undefined;
    });
  }, [frontSlot, nextIn, nextUri, standby, standbySlot]);

  useEffect(() => {
    if (!uri) return;
    front.playbackRate = speed;
    front.volume = active?.volume ?? 1;
  }, [active?.volume, front, speed, uri]);

  useEffect(() => {
    if (playing && uri) front.play();
    else front.pause();
  }, [front, playing, uri]);

  // Runs on every playhead change: cheap comparison, occasional seek. Covers
  // both user scrubs and slow drift between the element clock and the timeline.
  // Skipped entirely while a load is in flight — the load's own `.then` seeks.
  useEffect(() => {
    if (!uri || !settledOn(slots.current[frontSlot], uri)) return;
    const now = Date.now();
    // Self-heal a lost play(): expo-video's web replace→pause→play sequencing
    // can swallow the play issued at a swap, leaving the front element stepping
    // through drift seeks instead of playing. Nudged at most once per interval.
    if (playing && !front.playing && now - lastCorrection.current >= CORRECTION_INTERVAL_PLAYING) {
      front.play();
      lastCorrection.current = now;
      return;
    }
    if (now - lastCorrection.current < (playing ? CORRECTION_INTERVAL_PLAYING : CORRECTION_INTERVAL_PAUSED)) return;
    const drift = Math.abs(front.currentTime - sourceTime);
    if (drift <= (playing ? DRIFT_PLAYING : DRIFT_PAUSED)) return;
    front.currentTime = sourceTime;
    lastCorrection.current = now;
  }, [front, frontSlot, playing, sourceTime, uri]);

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.zoneLabel}>PREVIEW</Text>
        <Text style={styles.meta}>{project.format} · {project.fps} FPS · V{project.version}</Text>
      </View>
      <View
        style={styles.stageWrap}
        // Bail on an unchanged size: react-native-web re-fires onLayout on every
        // commit, and a fresh object each time would spin renders forever.
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setWrap((current) => (current.width === width && current.height === height ? current : { width, height }));
        }}
      >
        <View style={[styles.stage, { width: stage.width, height: stage.height }]}>
          {/* Both always mounted: expo-video only registers the element with
              its player once, so unmounting a view would leave that player
              driving a detached element. Sized rather than inset — on web the
              <video> is a replaced element, so `absoluteFill` alone leaves it
              at its intrinsic pixel size. The cut is this opacity flip. */}
          <VideoView
            ref={viewA}
            player={playerA}
            style={[styles.video, (!uri || frontSlot !== 0) && styles.hidden]}
            contentFit="contain"
            nativeControls={false}
          />
          <VideoView
            ref={viewB}
            player={playerB}
            style={[styles.video, (!uri || frontSlot !== 1) && styles.hidden]}
            contentFit="contain"
            nativeControls={false}
          />
          {!uri && (
            <View style={styles.gap}>
              <Text style={styles.gapText}>{videoClips.length === 0 ? 'no clips yet' : 'gap — black frame'}</Text>
            </View>
          )}
          {caption?.text && stage.height > 0 && <CaptionOverlay text={caption.text} style={caption.style} stage={stage} />}
        </View>
      </View>
      <View style={styles.transport}>
        <Control label="⏮" hint="start" onPress={() => onSeek(0)} />
        <Control label={playing ? '⏸' : '▶'} hint={playing ? 'pause' : 'play'} primary onPress={onTogglePlay} />
        <Text style={styles.timecode}>{formatTimecode(playhead)}</Text>
        <Text style={styles.timecodeMuted}>/ {formatTimecode(project.duration)}</Text>
        <View style={styles.spacer} />
        <Text style={styles.hint}>space to play · drag the ruler to scrub</Text>
      </View>
    </View>
  );
}

function configurePlayer(instance: VideoPlayer): void {
  instance.timeUpdateEventInterval = 0;
  instance.loop = false;
}

/**
 * The clip to prebuffer: the first one ahead of the playhead whose proxy is
 * ready and differs from what is on screen. Splits of the current asset are
 * skipped — they need no load, only a seek.
 */
function prebufferTarget(
  clips: readonly Clip[],
  assets: Props['assets'],
  playhead: number,
  currentUri: string | undefined,
): { uri: string; in: number } | undefined {
  for (const clip of clips) {
    if (clip.start <= playhead) continue;
    const asset = clip.assetId ? assets[clip.assetId] : undefined;
    const uri = asset?.status === 'ready' ? asset.proxyUrl : undefined;
    if (uri && uri !== currentUri) return { uri, in: clip.in };
  }
  return undefined;
}

/** Largest box of `aspect` (w/h) that fits inside the measured wrapper. */
function fitStage(wrap: { width: number; height: number }, aspect: number): { width: number; height: number } {
  if (wrap.width <= 0 || wrap.height <= 0) return { width: 0, height: 0 };
  const width = Math.min(wrap.width, wrap.height * aspect);
  return { width, height: width / aspect };
}

/**
 * Approximate ASS styling: `sizePct` is a share of frame height, `anchorPct`
 * places the text centre measured from the top, and the text already carries
 * whatever casing the agent baked in. Karaoke highlighting is render-only.
 */
function CaptionOverlay({ text, style, stage }: { text: string; style: CaptionStyle | undefined; stage: { width: number; height: number } }) {
  const fontSize = style?.sizePct !== undefined
    ? (style.sizePct / 100) * stage.height
    : ((style?.size ?? 52) / 1080) * stage.width;
  const anchor = style?.anchorPct !== undefined
    ? style.anchorPct
    : style?.position === 'top' ? 12 : style?.position === 'center' ? 50 : 84;
  return (
    <View pointerEvents="none" style={[styles.captionLayer, { top: (anchor / 100) * stage.height - fontSize }]}>
      <Text
        numberOfLines={3}
        style={[styles.captionText, {
          fontSize: Math.max(9, fontSize),
          lineHeight: Math.max(11, fontSize * 1.15),
          color: style?.color ?? '#FFFFFF',
          textShadowColor: style?.strokeColor ?? '#000000',
          textShadowRadius: Math.max(2, (style?.strokePx ?? 4) * (fontSize / 40)),
        }]}
      >
        {text}
      </Text>
    </View>
  );
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
  panel: { flex: 1, minHeight: 220, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: '#101016', padding: 10, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  zoneLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5 },
  meta: { color: colors.muted, fontFamily: 'Montserrat_600SemiBold', fontSize: 9 },
  stageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 140 },
  stage: { borderRadius: 8, overflow: 'hidden', backgroundColor: '#000000' },
  video: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  hidden: { opacity: 0 },
  gap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  gapText: { color: '#4A4860', fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.2 },
  captionLayer: { position: 'absolute', left: 8, right: 8, alignItems: 'center' },
  captionText: { fontFamily: 'Montserrat_800ExtraBold', textAlign: 'center' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  control: { minWidth: 30, height: 26, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  controlPrimary: { backgroundColor: colors.purple, borderColor: colors.purple },
  controlText: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 11 },
  controlTextPrimary: { color: '#FFFFFF' },
  timecode: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 11, fontVariant: ['tabular-nums'] },
  timecodeMuted: { color: colors.muted, fontFamily: 'Montserrat_600SemiBold', fontSize: 11, fontVariant: ['tabular-nums'] },
  spacer: { flex: 1 },
  hint: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 8 },
  pressed: { opacity: 0.65 },
});
