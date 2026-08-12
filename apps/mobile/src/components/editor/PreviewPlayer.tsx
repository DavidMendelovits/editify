import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { AssetMetadata, CaptionStyle, Project } from '@editify/shared';
import { colors } from '../../lib/theme';
import { clipAt, formatTimecode, sortClips } from '../../lib/timeline';

const ASPECT: Record<Project['format'], number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
/** Seek the element back into sync once it drifts further than this from the playhead. */
const DRIFT_PLAYING = 0.35;
const DRIFT_PAUSED = 0.08;

interface Props {
  project: Project;
  assets: Record<string, AssetMetadata | undefined>;
  playhead: number;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
}

/**
 * Timeline playback — not per-clip playback.
 *
 * The playhead is the source of truth (it is advanced by the parent's rAF
 * loop). This component maps the playhead onto the active video clip, swaps the
 * proxy source when it crosses a clip boundary, seeks to
 * `in + (playhead - start) * speed`, and corrects drift as it plays. Gaps
 * simply show black.
 */
export function PreviewPlayer({ project, assets, playhead, playing, onTogglePlay, onSeek }: Props) {
  // The stage is measured, not flex-sized: `aspectRatio` alone gives a View with
  // only absolutely positioned children a 0x0 box, which clipped the video away
  // (audible but invisible) since the stage also clips overflow.
  const [wrap, setWrap] = useState({ width: 0, height: 0 });
  const stage = fitStage(wrap, ASPECT[project.format]);
  const videoClips = sortClips(project.tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips));
  const captionClips = project.tracks.filter((track) => track.kind === 'caption').flatMap((track) => track.clips);
  const active = clipAt(videoClips, playhead);
  const asset = active?.assetId ? assets[active.assetId] : undefined;
  const uri = asset?.proxyUrl;
  const speed = active?.speed ?? 1;
  const sourceTime = active ? active.in + (playhead - active.start) * speed : 0;
  const caption = clipAt(captionClips, playhead);

  // Created once with an empty source; boundaries are handled by replaceAsync
  // so playback does not tear down the element on every cut.
  const player = useVideoPlayer(null, (instance) => {
    instance.timeUpdateEventInterval = 0;
    instance.loop = false;
  });
  const loadedUri = useRef<string | undefined>(undefined);
  const viewRef = useRef<VideoView>(null);
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
    const element = viewRef.current?.nativeRef?.current as HTMLVideoElement | null | undefined;
    if (element) {
      element.onplay = null;
      element.onpause = null;
    }
    return () => element?.pause();
  }, []);

  useEffect(() => {
    if (uri === loadedUri.current) return;
    loadedUri.current = uri;
    if (!uri) {
      player.pause();
      return;
    }
    let cancelled = false;
    void player.replaceAsync(uri).then(() => {
      if (cancelled) return;
      player.currentTime = sourceTimeRef.current;
      // `replace` starts playback unconditionally, so a swap made while paused
      // has to be put back to sleep.
      if (playingRef.current) player.play();
      else player.pause();
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [player, uri]);

  useEffect(() => {
    if (!uri) return;
    player.playbackRate = speed;
    player.volume = active?.volume ?? 1;
  }, [active?.volume, player, speed, uri]);

  useEffect(() => {
    if (playing && uri) player.play();
    else player.pause();
  }, [player, playing, uri]);

  // Runs on every playhead change: cheap comparison, occasional seek. Covers
  // both user scrubs and slow drift between the element clock and the timeline.
  useEffect(() => {
    if (!uri || loadedUri.current !== uri) return;
    const drift = Math.abs(player.currentTime - sourceTime);
    if (drift > (playing ? DRIFT_PLAYING : DRIFT_PAUSED)) player.currentTime = sourceTime;
  }, [player, playing, sourceTime, uri]);

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
          {/* Always mounted: expo-video only registers the element with the
              player once, so unmounting the view in a gap would leave the
              player driving a detached element. Sized rather than inset —
              on web the <video> is a replaced element, so `absoluteFill`
              alone leaves it at its intrinsic pixel size. */}
          <VideoView
            ref={viewRef}
            player={player}
            style={[styles.video, !uri && styles.hidden]}
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
  video: { width: '100%', height: '100%' },
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
