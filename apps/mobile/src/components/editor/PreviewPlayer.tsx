import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { VideoPlayer } from 'expo-video';
import type { AssetMetadata, Callout, Clip, ClipTransform, Operation, OverlayPlacement, Project } from '@editify/shared';
import { clipTimelineDuration } from '@editify/shared';
import { assetFilmstripUrl, assetOriginalUrl, assetProxyUrl, assetThumbUrl } from '../../lib/api';
import { colors, fonts } from '../../lib/theme';
import { FILMSTRIP_TILES, anchorIndexAtSorted, clipIndexAtSorted, formatTimecode, sortClips, visibleIdsAt } from '../../lib/timeline';
import { usePlayhead, usePlayheadSelector, type PlayheadClock } from './usePlayback';

const ASPECT: Record<Project['format'], number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
/** Seek the element back into sync once it drifts further than this from the playhead. */
const DRIFT_PLAYING = 0.35;
const DRIFT_PAUSED = 0.08;
/**
 * Minimum spacing between drift-correction polls. The playhead ticks at ~60Hz,
 * so without this a single lagging asset gets a seek every frame and each one
 * cancels the last, leaving the element permanently behind — and even the
 * checks are `currentTime` bridge/DOM reads, which are not free at 60Hz.
 */
const CORRECTION_INTERVAL_PLAYING = 250;
const CORRECTION_INTERVAL_PAUSED = 100;

/**
 * Persistent players, one per video clip in a window around the playhead. Each
 * one owns its clip's media for as long as the clip stays in the window: loaded
 * once, parked on its in-point, paused. A cut is then an opacity flip plus
 * `play()` — no source ever changes hands at a boundary, which is what used to
 * cost a stall on every clip after the first.
 *
 * ponytail: window = the active clip ± POOL_REACH, slot = `clipIndex %
 * POOL_SIZE`. A POOL_SIZE-wide window maps exactly one clip onto each slot, so
 * advancing one clip only reassigns the slot that just fell out the back, and
 * the incoming clip is never the one being reloaded. Five players on
 * desktop-class web; a phone gets three (window ±1) — each slot is a live
 * H.264 decoder, and that is the preview's main memory cost on device. The
 * hook row below stays fixed at five either way: unused players keep a null
 * source and never decode.
 */
const POOL_SIZE = Platform.OS === 'web' ? 5 : 3;
const POOL_REACH = (POOL_SIZE - 1) / 2;
/** Simultaneous audio players: music bed + SFX + voiceover is the practical ceiling. */
const AUDIO_POOL = 3;
/**
 * Preview of the render's duck envelope: bed audio (and the video) at 30%
 * while a `duck` clip plays — the same floor server/src/media/duck.ts burns
 * into the export, minus the 0.12s edge ramps.
 */
const DUCK_FLOOR = 0.3;

interface Props {
  project: Project;
  assets: Record<string, AssetMetadata | undefined>;
  clock: PlayheadClock;
  playing: boolean;
  /** True while the timeline ruler is being dragged: the stage shows filmstrip
      posters and the video elements are left alone until release. */
  scrubbing: boolean;
  selectedId: string | undefined;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSelect: (clipId: string | undefined) => void;
  /** Commits ops (sticker repositioning) with an optimistic patch. */
  onApply: (ops: Operation[], optimistic?: (project: Project) => Project) => void;
}

/**
 * What a player holds. `loaded` is only written once `replaceAsync` resolves, so
 * nothing seeks into a still-buffering element; `pending` is the in-flight
 * target, which is what the element will show next and therefore what a repeat
 * request has to compare against. `generation` lets a superseded load discard
 * its own completion. `clipId` is the pool's own bookkeeping: two clips can
 * share one media file (a split), and those need the same source parked at two
 * different points. `park` is the in-point the slot should sit on when it is not
 * the one on screen; a load in flight reads it rather than the value it was
 * issued with, so a slot reassigned mid-load still lands on the right frame.
 */
interface SlotState { loaded: string | undefined; pending: string | undefined; generation: number; clipId?: string; park?: number }

/** What a pooled player should be holding: a clip, its media, and where to park. */
interface PoolTarget { clipId: string; uri: string; park: number }

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
 * loop). This component maps it onto the active video clip through *coarse*
 * selectors — clip indices and id signatures — so a transport tick re-renders
 * it only when a boundary is crossed, never per frame. The per-frame consumers
 * (pose, transition dip, karaoke, timecode) are their own leaves below, and
 * drift correction runs on a throttled clock subscription with no render at
 * all. Gaps simply show black.
 *
 * Sources are never swapped at a boundary. A pool of `POOL_SIZE` players each
 * hold one clip in the window around the playhead — loaded, pre-seeked to their
 * in-point, muted and paused — so the cut is an opacity flip plus `play()` on a
 * player that is already showing the right frame. Only the on-screen player is
 * audible.
 */
export function PreviewPlayer({ project, assets, clock, playing, scrubbing, selectedId, onTogglePlay, onSeek, onSelect, onApply }: Props) {
  // The stage is measured, not flex-sized: `aspectRatio` alone gives a View with
  // only absolutely positioned children a 0x0 box, which clipped the video away
  // (audible but invisible) since the stage also clips overflow.
  const [wrap, setWrap] = useState({ width: 0, height: 0 });
  const stage = fitStage(wrap, ASPECT[project.format]);

  // Sorted once per timeline change — never per frame. The playhead selectors
  // below scan these at 60Hz, so they must be allocation-free reads.
  const videoClips = useMemo(
    () => sortClips(project.tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips)),
    [project.tracks],
  );
  const captionClips = useMemo(
    () => sortClips(project.tracks.filter((track) => track.kind === 'caption').flatMap((track) => track.clips)),
    [project.tracks],
  );
  const stickerClips = useMemo(
    () => sortClips(project.tracks.filter((track) => track.kind === 'overlay').flatMap((track) => track.clips)),
    [project.tracks],
  );
  const audioClips = useMemo(
    () => sortClips(project.tracks.filter((track) => track.kind === 'audio').flatMap((track) => track.clips)),
    [project.tracks],
  );

  // Index, not just the clip: the pool is keyed on position in the ordered clip
  // list, so a boundary is one slot rotating rather than every player moving.
  const activeIndex = usePlayheadSelector(clock, useCallback(
    (time: number) => clipIndexAtSorted(videoClips, time), [videoClips]));
  // Inside a gap the window centres on the clip we are heading into, so it is
  // loaded and parked by the time the playhead arrives.
  const anchor = usePlayheadSelector(clock, useCallback(
    (time: number) => anchorIndexAtSorted(videoClips, time), [videoClips]));
  const captionIndex = usePlayheadSelector(clock, useCallback(
    (time: number) => clipIndexAtSorted(captionClips, time), [captionClips]));
  const overlayIds = usePlayheadSelector(clock, useCallback(
    (time: number) => visibleIdsAt(stickerClips, time), [stickerClips]));
  const audioIds = usePlayheadSelector(clock, useCallback(
    (time: number) => visibleIdsAt(audioClips, time), [audioClips]));

  const active = activeIndex >= 0 ? videoClips[activeIndex] : undefined;
  const asset = active?.assetId ? assets[active.assetId] : undefined;
  // No URI until the proxy exists — it flips undefined→url when processing
  // finishes, which is what triggers replaceAsync to actually load it.
  // Built from API_URL: the server-minted proxyUrl points at ITS localhost.
  const uri = active?.assetId && asset?.status === 'ready' ? assetProxyUrl(active.assetId) : undefined;
  const speed = active?.speed ?? 1;
  const clipVolume = active?.volume ?? 1;
  const caption = captionIndex >= 0 ? captionClips[captionIndex] : undefined;
  const overlayClips = useMemo(() => {
    if (!overlayIds) return [] as Clip[];
    const visible = new Set(overlayIds.split(','));
    return stickerClips.filter((clip) => visible.has(clip.id));
  }, [overlayIds, stickerClips]);
  // Every audio clip under the playhead, not just the first: the export amixes
  // them all, so the preview plays them all (up to AUDIO_POOL at once).
  const audioActiveClips = useMemo(() => {
    if (!audioIds) return [] as Clip[];
    const visible = new Set(audioIds.split(','));
    return audioClips.filter((clip) => visible.has(clip.id));
  }, [audioIds, audioClips]);
  const duckActive = audioActiveClips.some((clip) => clip.duck);
  const bedScale = duckActive ? DUCK_FLOOR : 1;
  // The video's audio is part of the bed, so a voiceover ducks it too.
  const volume = clipVolume * bedScale;

  const targets = useMemo(() => poolWindow(videoClips, assets, anchor), [anchor, assets, videoClips]);
  // Membership signature: this changes once per boundary (or on a trim/scrub
  // that moves the window), never per frame, so the loader is not re-entered
  // 60 times a second.
  const windowKey = targets.map((target) => (target ? `${target.clipId}@${target.uri}@${target.park}` : '-')).join('|');
  const activeSlot = activeIndex >= 0 ? activeIndex % POOL_SIZE : undefined;

  // Crossfade windows: [start − d/2, start + d/2) around each crossfading
  // clip's cut. Inside one, the outgoing slot keeps playing underneath while
  // the incoming slot's opacity ramps — a real dissolve, matching the export.
  const crossfades = useMemo(() => {
    const windows: Array<{ from: number; to: number; index: number }> = [];
    videoClips.forEach((clip, index) => {
      if (clip.transition?.type !== 'crossfade' || index === 0) return;
      const half = clip.transition.duration / 2;
      windows.push({ from: clip.start - half, to: clip.start + half, index });
    });
    return windows;
  }, [videoClips]);

  // Created once each with an empty source, and kept for the life of the
  // editor. `useVideoPlayer` is a hook, so the pool is a fixed row of calls.
  const player0 = useVideoPlayer(null, configurePlayer);
  const player1 = useVideoPlayer(null, configurePlayer);
  const player2 = useVideoPlayer(null, configurePlayer);
  const player3 = useVideoPlayer(null, configurePlayer);
  const player4 = useVideoPlayer(null, configurePlayer);
  const pool = useMemo(
    () => [player0, player1, player2, player3, player4].slice(0, POOL_SIZE),
    [player0, player1, player2, player3, player4],
  );

  const slots = useRef<SlotState[]>(
    Array.from({ length: POOL_SIZE }, () => ({ loaded: undefined, pending: undefined, generation: 0 })),
  );
  const lastCorrection = useRef(0);
  const views = useRef<Array<VideoView | null>>([]);
  // Per-slot visibility as Animated values, written imperatively: the steady
  // state is a hard 1/0 flip at the cut, and a crossfade ramps the incoming
  // slot per frame without a single React render.
  const slotOpacity = useRef(Array.from({ length: POOL_SIZE }, () => new Animated.Value(0))).current;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  const activeSlotRef = useRef(activeSlot);
  activeSlotRef.current = activeSlot;
  // Read by loads and corrections that run outside a render. The element's
  // source time is derived from the clock on demand — this component no longer
  // renders per frame, so a snapshot ref would go stale between boundaries.
  const activeRef = useRef({ clip: active, speed, volume });
  activeRef.current = { clip: active, speed, volume };
  const uriRef = useRef(uri);
  uriRef.current = uri;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const sourceTimeNow = useCallback((): number => {
    const clip = activeRef.current.clip;
    return clip ? clip.in + (clockRef.current.get() - clip.start) * (clip.speed ?? 1) : 0;
  }, []);

  // expo-video's web player echoes every `play`/`pause` DOM event straight back
  // onto the same element. `replace()` pauses and then plays, so both handlers
  // end up regenerating each other — thousands of play/pause pairs a second,
  // which freezes the picture and shreds the audio. We drive the element
  // ourselves, so the echo is pure cost. Native platforms are unaffected.
  // Detaching also pauses on unmount: a removed <video> keeps its audio going.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const elements = views.current.map((view) => view?.nativeRef?.current as HTMLVideoElement | null | undefined);
    for (const element of elements) {
      if (!element) continue;
      element.onplay = null;
      element.onpause = null;
    }
    return () => { for (const element of elements) element?.pause(); };
  }, []);

  // Keeps the window loaded. Only a slot whose clip actually changed is touched,
  // and the slot that rotates is the one that just left the window — never the
  // clip about to play, which is why the cut itself does no work.
  useEffect(() => {
    for (let slot = 0; slot < POOL_SIZE; slot++) {
      const target = targets[slot];
      const state = slots.current[slot];
      const player = pool[slot];
      if (!target || !state || !player) continue;
      if (state.clipId === target.clipId && shownBy(state) === target.uri) continue;
      const sameMedia = shownBy(state) === target.uri;
      state.clipId = target.clipId;
      state.park = target.park;
      // A split hands the same file to a second clip: re-park, do not reload.
      if (sameMedia) {
        if (settledOn(state, target.uri) && activeSlotRef.current !== slot) player.currentTime = target.park;
        continue;
      }
      const started = ++state.generation;
      state.pending = target.uri;
      // Muted before the load, not after: `replace` starts playback, and a
      // background player must never be heard even for the frame it takes the
      // continuation below to run.
      player.muted = activeSlotRef.current !== slot;
      void player.replaceAsync(target.uri).then(() => {
        if (state.generation !== started) return;
        state.pending = undefined;
        state.loaded = target.uri;
        // `replace` starts playback unconditionally, so every player has to be
        // put back to sleep on its in-point unless it is the one on screen —
        // which it can become while its own load is still in flight.
        if (activeSlotRef.current === slot) {
          player.muted = false;
          player.volume = activeRef.current.volume;
          player.playbackRate = activeRef.current.speed;
          player.currentTime = sourceTimeNow();
          if (playingRef.current) player.play();
          else player.pause();
          return;
        }
        player.muted = true;
        player.pause();
        player.currentTime = state.park ?? target.park;
      }).catch(() => {
        if (state.generation !== started) return;
        state.pending = undefined;
        state.loaded = undefined;
      });
    }
    // `windowKey` is the value identity of `targets`, which only changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, windowKey]);

  // The crossfade driver: one unthrottled clock subscription that is a single
  // array scan per frame outside a window. Inside one it ramps the incoming
  // slot's opacity and keeps the outgoing player rolling; on exit (played
  // through or scrubbed out) it restores the steady 1/0 state and pauses
  // whatever it kept alive.
  const crossfadesRef = useRef(crossfades);
  crossfadesRef.current = crossfades;
  const crossfadeRef = useRef<{ outgoingSlot: number } | undefined>(undefined);
  useEffect(() => clock.subscribe(() => {
    const windows = crossfadesRef.current;
    if (windows.length === 0 && !crossfadeRef.current) return;
    const time = clockRef.current.get();
    let inside: { from: number; to: number; index: number } | undefined;
    for (const candidate of windows) {
      if (time >= candidate.from && time < candidate.to) { inside = candidate; break; }
    }
    if (!inside) {
      if (crossfadeRef.current) {
        crossfadeRef.current = undefined;
        const slot = activeSlotRef.current;
        for (let index = 0; index < POOL_SIZE; index++) {
          slotOpacity[index]?.setValue(index === slot && uriRef.current ? 1 : 0);
          if (index !== slot) {
            const other = pool[index];
            if (other) { other.muted = true; other.pause(); }
          }
        }
      }
      return;
    }
    const incomingSlot = inside.index % POOL_SIZE;
    const outgoingSlot = (inside.index - 1) % POOL_SIZE;
    crossfadeRef.current = { outgoingSlot };
    // Outgoing fully visible underneath, incoming dissolving in over it. The
    // outgoing keeps playing past its out-point — the export borrows those
    // frames the same way — but only the active side is ever audible.
    slotOpacity[outgoingSlot]?.setValue(1);
    slotOpacity[incomingSlot]?.setValue((time - inside.from) / (inside.to - inside.from));
    const outgoing = pool[outgoingSlot];
    if (playingRef.current && outgoing && !outgoing.playing && outgoingSlot !== activeSlotRef.current) outgoing.play();
  }), [clock, pool, slotOpacity]);

  // The cut. Nothing loads and no source moves: the outgoing player pauses, and
  // the incoming one — already holding its first frame — is unmuted and played.
  useEffect(() => {
    const cross = crossfadeRef.current;
    for (let slot = 0; slot < POOL_SIZE; slot++) {
      // Mid-crossfade the two dissolving slots belong to the driver above:
      // their opacities ramp, and the outgoing keeps playing (muted).
      if (!cross || (slot !== activeSlot && slot !== cross.outgoingSlot)) {
        slotOpacity[slot]?.setValue(slot === activeSlot && uri ? 1 : 0);
      }
      if (slot === activeSlot) continue;
      const other = pool[slot];
      if (!other) continue;
      other.muted = true;
      if (cross?.outgoingSlot !== slot) other.pause();
    }
    lastCorrection.current = 0;
    const player = activeSlot === undefined ? undefined : pool[activeSlot];
    const state = activeSlot === undefined ? undefined : slots.current[activeSlot];
    if (!player || !state || !uri) return;
    player.muted = false;
    player.volume = volume;
    player.playbackRate = speed;
    // Still buffering — the load's own continuation starts it.
    if (!settledOn(state, uri)) return;
    // A boundary reached by playing arrives with the player already on the right
    // frame, so this is a no-op; only a scrub into the clip pays a seek.
    const sourceTime = sourceTimeNow();
    if (Math.abs(player.currentTime - sourceTime) > DRIFT_PAUSED) player.currentTime = sourceTime;
    if (playing) player.play();
    else player.pause();
  }, [activeSlot, playing, pool, sourceTimeNow, speed, uri, volume]);

  // ---- Audio track: a mini-pool of viewless players, one per audible clip,
  // so a music bed, an SFX and a voiceover all sound together the way the
  // export's amix does. Slot assignment is sticky: a clip keeps the player it
  // already holds, a new clip prefers a slot already loaded with its media,
  // else takes a free one. A fourth simultaneous clip goes unheard. ----
  const audioPlayer0 = useVideoPlayer(null, configurePlayer);
  const audioPlayer1 = useVideoPlayer(null, configurePlayer);
  const audioPlayer2 = useVideoPlayer(null, configurePlayer);
  const audioPool = useMemo(() => [audioPlayer0, audioPlayer1, audioPlayer2], [audioPlayer0, audioPlayer1, audioPlayer2]);
  const audioSlots = useRef<SlotState[]>(
    Array.from({ length: AUDIO_POOL }, () => ({ loaded: undefined, pending: undefined, generation: 0 })),
  );
  const audioClipsRef = useRef(audioActiveClips);
  audioClipsRef.current = audioActiveClips;
  const bedScaleRef = useRef(bedScale);
  bedScaleRef.current = bedScale;
  /** A duck clip plays at its own volume; everything else is bed and dips under it. */
  const audioClipVolume = useCallback((clip: Clip): number => (
    clip.duck ? clip.volume ?? 1 : (clip.volume ?? 1) * bedScaleRef.current
  ), []);
  const clipTimeNow = useCallback((clip: Clip): number => (
    clip.in + (clockRef.current.get() - clip.start) * (clip.speed ?? 1)
  ), []);

  // Runs when the audible set changes — clip boundaries and duck edges, both
  // coarse — and settles every slot: frees the finished, keeps the continuing
  // (volume and rate re-applied, which is how a duck edge lands), loads the new.
  useEffect(() => {
    const states = audioSlots.current;
    const wanted = new Set(audioActiveClips.map((clip) => clip.id));
    for (let slot = 0; slot < AUDIO_POOL; slot++) {
      const state = states[slot];
      if (state?.clipId !== undefined && !wanted.has(state.clipId)) {
        delete state.clipId;
        audioPool[slot]?.pause();
      }
    }
    for (const clip of audioActiveClips) {
      if (!clip.assetId) continue;
      const clipUri = assetOriginalUrl(clip.assetId);
      let slot = states.findIndex((state) => state.clipId === clip.id);
      if (slot === -1) slot = states.findIndex((state) => state.clipId === undefined && shownBy(state) === clipUri);
      if (slot === -1) slot = states.findIndex((state) => state.clipId === undefined);
      const state = slot === -1 ? undefined : states[slot];
      const player = slot === -1 ? undefined : audioPool[slot];
      if (!state || !player) continue;
      const fresh = state.clipId !== clip.id;
      state.clipId = clip.id;
      if (shownBy(state) === clipUri) {
        if (settledOn(state, clipUri)) {
          player.volume = audioClipVolume(clip);
          player.playbackRate = clip.speed ?? 1;
          if (fresh) player.currentTime = clipTimeNow(clip);
          if (playingRef.current) player.play();
          else player.pause();
        }
        continue;
      }
      const started = ++state.generation;
      state.pending = clipUri;
      void player.replaceAsync(clipUri).then(() => {
        if (state.generation !== started) return;
        state.pending = undefined;
        state.loaded = clipUri;
        // The slot may have been re-purposed while loading — follow its state.
        const live = audioClipsRef.current.find((candidate) => candidate.id === state.clipId);
        if (!live) { player.pause(); return; }
        player.volume = audioClipVolume(live);
        player.playbackRate = live.speed ?? 1;
        player.currentTime = clipTimeNow(live);
        if (playingRef.current) player.play();
        else player.pause();
      }).catch(() => {
        if (state.generation !== started) return;
        state.pending = undefined;
        state.loaded = undefined;
      });
    }
  }, [audioActiveClips, audioClipVolume, audioPool, clipTimeNow]);

  // Transport toggle for the audio pool.
  useEffect(() => {
    for (let slot = 0; slot < AUDIO_POOL; slot++) {
      const state = audioSlots.current[slot];
      const player = audioPool[slot];
      if (state?.clipId === undefined || !player || !state?.loaded || state.pending !== undefined) continue;
      if (playing) player.play();
      else player.pause();
    }
  }, [audioPool, playing]);

  // The correction poll: one clock subscription, gated by the interval BEFORE
  // anything touches a player — `currentTime` is a bridge/DOM read, and the
  // per-frame version paid six of them 60 times a second. Covers background
  // re-parks, active drift, the lost-play self-heal, and the audio element at
  // the same cadence. The clock only ticks while playing or on a seek, so a
  // paused, untouched transport polls nothing.
  useEffect(() => clock.subscribe(() => {
    // Mid-scrub the poster covers the stage; the elements catch up on release.
    if (scrubbingRef.current) return;
    const isPlaying = playingRef.current;
    const now = Date.now();
    if (now - lastCorrection.current < (isPlaying ? CORRECTION_INTERVAL_PLAYING : CORRECTION_INTERVAL_PAUSED)) return;
    lastCorrection.current = now;
    // A park issued right after `replaceAsync` can be dropped: the web element
    // ignores seeks before it has metadata. Re-issue it here, where the element
    // is warm, so the next cut really is flip-and-play instead of flip-and-seek.
    for (let slot = 0; slot < POOL_SIZE; slot++) {
      if (slot === activeSlotRef.current) continue;
      const other = pool[slot];
      const parked = slots.current[slot];
      if (!other || !parked?.loaded || parked.pending !== undefined || parked.park === undefined) continue;
      if (Math.abs(other.currentTime - parked.park) > DRIFT_PAUSED) other.currentTime = parked.park;
    }
    const slot = activeSlotRef.current;
    const player = slot === undefined ? undefined : pool[slot];
    const state = slot === undefined ? undefined : slots.current[slot];
    const target = uriRef.current;
    if (player && state && target && settledOn(state, target)) {
      // Self-heal a lost play(): expo-video's web replace→pause→play sequencing
      // can swallow the play issued at a cut, leaving the visible element
      // stepping through drift seeks instead of playing.
      if (isPlaying && !player.playing) {
        player.play();
      } else {
        const sourceTime = sourceTimeNow();
        if (Math.abs(player.currentTime - sourceTime) > (isPlaying ? DRIFT_PLAYING : DRIFT_PAUSED)) player.currentTime = sourceTime;
      }
    }
    // Audio drift, same cadence; SFX are short, so the coarse threshold is enough.
    for (let slot = 0; slot < AUDIO_POOL; slot++) {
      const audioState = audioSlots.current[slot];
      const audioElement = audioPool[slot];
      if (audioState?.clipId === undefined || !audioElement || !audioState?.loaded || audioState.pending !== undefined) continue;
      const clip = audioClipsRef.current.find((candidate) => candidate.id === audioState.clipId);
      if (!clip) continue;
      const clipTime = clipTimeNow(clip);
      if (Math.abs(audioElement.currentTime - clipTime) > (isPlaying ? DRIFT_PLAYING : DRIFT_PAUSED)) audioElement.currentTime = clipTime;
    }
  }), [audioPool, clipTimeNow, clock, pool, sourceTimeNow]);

  // One precise landing on scrub release: the poster hid whatever the elements
  // were doing, so the visible frame must be exact the moment it comes back.
  useEffect(() => {
    if (scrubbing) return;
    lastCorrection.current = 0;
    const slot = activeSlotRef.current;
    const player = slot === undefined ? undefined : pool[slot];
    const state = slot === undefined ? undefined : slots.current[slot];
    const target = uriRef.current;
    if (player && state && target && settledOn(state, target)) {
      const sourceTime = sourceTimeNow();
      if (Math.abs(player.currentTime - sourceTime) > 0.02) player.currentTime = sourceTime;
    }
  }, [pool, scrubbing, sourceTimeNow]);

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.zoneLabel}>PREVIEW</Text>
        <Text style={styles.meta} numberOfLines={1}>{project.format} · {project.fps} FPS · V{project.version}</Text>
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
          {/* The whole pool stays mounted: expo-video only registers the element
              with its player once, so unmounting a view would leave that player
              driving a detached element. Sized rather than inset — on web the
              <video> is a replaced element, so `absoluteFill` alone leaves it
              at its intrinsic pixel size. The cut is this opacity flip.
              PoseLayer carries the clip's crop/zoom pose — static transforms
              and animated punch-ins both preview there, matching the render —
              and the VideoViews are its stable children, so a per-frame pose
              never reconciles them. */}
          <PoseLayer clock={clock} clip={active} stage={stage}>
            {pool.map((player, slot) => (
              <Animated.View key={slot} style={[styles.video, { opacity: slotOpacity[slot] }]}>
                <VideoView
                  ref={(node) => { views.current[slot] = node; }}
                  player={player}
                  style={styles.videoFill}
                  contentFit="contain"
                  nativeControls={false}
                />
              </Animated.View>
            ))}
          </PoseLayer>
          {/* Viewless audio needs elements on web; 1px and transparent. */}
          {audioPool.map((player, slot) => (
            <VideoView key={`audio-${slot}`} player={player} style={styles.audioElement} nativeControls={false} />
          ))}
          {!uri && (
            <View style={styles.gap}>
              <Text style={styles.gapText}>{videoClips.length === 0 ? 'no clips yet' : 'gap: black frame'}</Text>
            </View>
          )}
          {scrubbing && <ScrubPoster clock={clock} clips={videoClips} assets={assets} stage={stage} />}
          {/* Above the picture, below stickers and captions — the overlays
              stay legible through a transition, as they do in the render. */}
          <TransitionDip clock={clock} clips={videoClips} />
          {stage.height > 0 && overlayClips.map((clip) => (
            <Sticker
              key={clip.id}
              clip={clip}
              asset={clip.assetId ? assets[clip.assetId] : undefined}
              stage={stage}
              selected={clip.id === selectedId}
              onSelect={onSelect}
              onApply={onApply}
            />
          ))}
          {caption?.text && stage.height > 0 && <CaptionOverlay clip={caption} clock={clock} stage={stage} />}
        </View>
      </View>
      <View style={styles.transport}>
        <Control label="⏮" hint="start" onPress={() => onSeek(0)} />
        <Control label={playing ? '⏸' : '▶'} hint={playing ? 'pause' : 'play'} primary onPress={onTogglePlay} />
        <TransportTimecode clock={clock} />
        <Text style={styles.timecodeMuted}>/ {formatTimecode(project.duration)}</Text>
        <View style={styles.spacer} />
        {/* On a phone the hint would wrap the timecodes off their line. */}
        {wrap.width >= 430 && (
          <Text style={styles.hint}>
            {Platform.OS === 'web' ? 'space to play · drag the ruler to scrub' : 'drag the ruler to scrub · drag stickers to place them'}
          </Text>
        )}
      </View>
    </View>
  );
}

function configurePlayer(instance: VideoPlayer): void {
  instance.timeUpdateEventInterval = 0;
  instance.loop = false;
}

/**
 * The clip's crop/zoom pose around the player pool. The children are the
 * pooled VideoViews, created once by the parent: a per-frame re-render here
 * recomputes only this wrapper's style, and React bails on the identical child
 * elements — so an animated punch-in never reconciles the videos it moves.
 * Static poses (and clips with none) skip the per-frame subscription entirely:
 * the selector folds the playhead to 0 unless the active clip animates.
 */
function PoseLayer({ clock, clip, stage, children }: {
  clock: PlayheadClock;
  clip: Clip | undefined;
  stage: { width: number; height: number };
  children: ReactNode;
}) {
  const animated = Boolean(clip?.transformEnd);
  const time = usePlayheadSelector(clock, useCallback(
    (playhead: number) => (animated ? playhead : 0), [animated]));
  const pose = clip ? transformAt(clip, time) : undefined;
  return <View style={[StyleSheet.absoluteFill, pose && poseStyle(pose, stage)]}>{children}</View>;
}

/**
 * The black transition overlay — a per-frame leaf, but its selector returns a
 * steady 0 anywhere outside a transition's window, so it only re-renders while
 * a dip is actually on screen.
 */
function TransitionDip({ clock, clips }: { clock: PlayheadClock; clips: readonly Clip[] }) {
  const dim = usePlayheadSelector(clock, useCallback(
    (time: number) => transitionDim(clips, time), [clips]));
  if (dim <= 0) return null;
  return <View pointerEvents="none" style={[styles.dip, { opacity: dim }]} />;
}

/** Timecode readout — the transport's only per-frame text. */
function TransportTimecode({ clock }: { clock: PlayheadClock }) {
  return <Text style={styles.timecode}>{formatTimecode(usePlayhead(clock))}</Text>;
}

/**
 * Instant scrub feedback: while the ruler is dragged the stage shows the
 * filmstrip tile nearest the playhead — one already-downloaded JPEG — instead
 * of asking the video elements to chase sixty seeks a second. The selector
 * folds the playhead down to a single tile number (clip index × tiles + tile),
 * so this re-renders per tile, not per frame.
 * ponytail: tiles stretch to the stage; a scrub poster is transient, exact
 * aspect is not worth a second layout pass.
 */
function ScrubPoster({ clock, clips, assets, stage }: {
  clock: PlayheadClock;
  clips: readonly Clip[];
  assets: Props['assets'];
  stage: { width: number; height: number };
}) {
  const tileKey = usePlayheadSelector(clock, useCallback((time: number) => {
    const index = clipIndexAtSorted(clips, time);
    const clip = index >= 0 ? clips[index] : undefined;
    const asset = clip?.assetId ? assets[clip.assetId] : undefined;
    if (!clip || !asset || asset.status !== 'ready' || !(asset.duration > 0)) return -1;
    const sourceTime = clip.in + (time - clip.start) * (clip.speed ?? 1);
    const tile = Math.max(0, Math.min(FILMSTRIP_TILES - 1, Math.floor((sourceTime / asset.duration) * FILMSTRIP_TILES)));
    return index * FILMSTRIP_TILES + tile;
  }, [assets, clips]));
  if (tileKey < 0 || stage.width <= 0) return null;
  const clip = clips[Math.floor(tileKey / FILMSTRIP_TILES)];
  if (!clip?.assetId) return null;
  const tile = tileKey % FILMSTRIP_TILES;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.poster]}>
      <Image
        source={{ uri: assetFilmstripUrl(clip.assetId) }}
        style={{ width: stage.width * FILMSTRIP_TILES, height: stage.height, marginLeft: -tile * stage.width }}
        contentFit="fill"
      />
    </View>
  );
}

/**
 * The clips around `anchor` that deserve a live player, indexed by pool slot.
 * Clips whose proxy is not ready yet are left out and pick up a player on the
 * commit where the asset flips to `ready`.
 */
function poolWindow(clips: readonly Clip[], assets: Props['assets'], anchor: number): Array<PoolTarget | undefined> {
  const targets: Array<PoolTarget | undefined> = Array.from({ length: POOL_SIZE }, () => undefined);
  for (let index = anchor - POOL_REACH; index <= anchor + POOL_REACH; index++) {
    const clip = index >= 0 ? clips[index] : undefined;
    const asset = clip?.assetId ? assets[clip.assetId] : undefined;
    if (!clip?.assetId || asset?.status !== 'ready') continue;
    targets[index % POOL_SIZE] = { clipId: clip.id, uri: assetProxyUrl(clip.assetId), park: clip.in };
  }
  return targets;
}

/**
 * Opacity of the black dip overlay at `time` — a pure function of the playhead
 * and the clip list, so it is one cheap pass per frame with no state and no
 * timers. A transition is anchored on the incoming clip's start: the overlay
 * ramps up over the outgoing clip's last d/2, peaks at the cut, and ramps back
 * down over the incoming clip's first d/2, which is the dip the renderer
 * draws. Crossfades are not dimmed at all — they preview as a real dissolve
 * on the player pool.
 */
function transitionDim(clips: readonly Clip[], time: number): number {
  let dim = 0;
  for (const clip of clips) {
    const transition = clip.transition;
    if (transition?.type !== 'dip') continue;
    const half = transition.duration / 2;
    const delta = time - clip.start;
    if (delta <= -half || delta >= half) continue;
    dim = Math.max(dim, delta < 0 ? 1 + delta / half : 1 - delta / half);
  }
  return dim;
}

/** The clip's crop/zoom pose at `time`: static, or lerped toward transformEnd. */
function transformAt(clip: Clip, time: number): ClipTransform | undefined {
  const from = clip.transform ?? (clip.transformEnd ? { scale: 1, x: 0, y: 0 } : undefined);
  if (!from) return undefined;
  const to = clip.transformEnd;
  if (!to) return from.scale === 1 && from.x === 0 && from.y === 0 ? undefined : from;
  const duration = clipTimelineDuration(clip);
  const progress = duration > 0 ? Math.max(0, Math.min(1, (time - clip.start) / duration)) : 0;
  return {
    scale: from.scale + (to.scale - from.scale) * progress,
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

/**
 * Same geometry as the renderer: scale by `s`, then a crop offset of
 * (iw-W)/2*(1+x) — which on a centred, scaled element is a translation of
 * -x*(s-1)*W/2. The stage clips the overflow.
 */
function poseStyle(pose: ClipTransform, stage: { width: number; height: number }): ViewStyle {
  const scale = Math.max(1, pose.scale);
  return {
    transform: [
      { translateX: -pose.x * (scale - 1) * stage.width / 2 },
      { translateY: -pose.y * (scale - 1) * stage.height / 2 },
      { scale },
    ],
  };
}

/** Snap radius for sticker centring, as a fraction of the stage. */
const STICKER_SNAP = 0.03;

/**
 * Callout card geometry, all derived from the placement width so the card
 * scales with the stage exactly as an emoji sticker does. At the 0.56 width
 * `addSticker` gives a callout, `CALLOUT_TEXT` puts the line at ~5% of the
 * frame width — caption weight, so a card reads as a bar under the picture.
 * The card's own height follows from the same number, which is why a callout
 * ignores the square box the other sticker kinds get.
 */
const CALLOUT_TEXT = 0.09;
const CALLOUT_LINE = 1.25;
const CALLOUT_PAD_V = 0.3;
const CALLOUT_PAD_H = 0.7;
const CALLOUT_RADIUS = 0.45;
const CALLOUT_BG = '#14141BF2';
/** Verdict glyph and its default colour; `card` is the plain plate, so neither. */
const CALLOUT_MARK: Record<Callout['variant'], { glyph: string; color: string } | undefined> = {
  check: { glyph: '✓', color: '#39D98A' },
  x: { glyph: '✗', color: '#FF5C70' },
  card: undefined,
};

/**
 * One sticker on the stage: emoji text or an image/GIF, draggable with one
 * finger. Position previews locally during the drag and commits a single
 * `set_overlay` on release; near-centre positions magnet to the axis with a
 * haptic tick, and guide lines appear while snapped (CapCut-style).
 */
function Sticker({ clip, asset, stage, selected, onSelect, onApply }: {
  clip: Clip;
  asset: AssetMetadata | undefined;
  stage: { width: number; height: number };
  selected: boolean;
  onSelect: (clipId: string) => void;
  onApply: Props['onApply'];
}) {
  const placement = clip.overlay ?? { x: 0.5, y: 0.35, width: 0.28, rotation: 0 };
  const [drag, setDrag] = useState<{ dx: number; dy: number }>();
  const latest = useRef({ clip, placement, stage });
  latest.current = { clip, placement, stage };
  const snapped = useRef({ x: false, y: false });
  // Stable responder, live callbacks.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      onSelectRef.current(latest.current.clip.id);
      snapped.current = { x: false, y: false };
    },
    onPanResponderMove: (_event, gesture) => {
      const next = dragPlacement(latest.current.placement, gesture.dx, gesture.dy, latest.current.stage);
      const nowSnapped = { x: next.x === 0.5, y: next.y === 0.5 };
      if (Platform.OS !== 'web' && ((nowSnapped.x && !snapped.current.x) || (nowSnapped.y && !snapped.current.y))) {
        void Haptics.selectionAsync();
      }
      snapped.current = nowSnapped;
      setDrag({ dx: gesture.dx, dy: gesture.dy });
    },
    onPanResponderRelease: (_event, gesture) => {
      setDrag(undefined);
      const current = latest.current;
      const next = dragPlacement(current.placement, gesture.dx, gesture.dy, current.stage);
      if (Math.abs(gesture.dx) < 3 && Math.abs(gesture.dy) < 3) return; // tap = select only
      onApplyRef.current(
        [{ type: 'set_overlay', params: { clipId: current.clip.id, overlay: next } }],
        (project) => ({
          ...project,
          tracks: project.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((candidate) => (candidate.id === current.clip.id ? { ...candidate, overlay: next } : candidate)),
          })),
        }),
      );
    },
    onPanResponderTerminate: () => setDrag(undefined),
  })).current;

  const shown = drag ? dragPlacement(placement, drag.dx, drag.dy, stage) : placement;
  const width = shown.width * stage.width;
  const aspect = asset && asset.width > 0 && asset.height > 0 ? asset.height / asset.width : 1;
  const callout = clip.callout;
  const mark = callout ? CALLOUT_MARK[callout.variant] : undefined;
  // The card is width-driven: its type size, padding and radius are all shares
  // of the placement width, so the box it needs is one multiple of the former.
  const calloutFont = Math.max(9, width * CALLOUT_TEXT);
  const height = callout
    ? calloutFont * (CALLOUT_LINE + CALLOUT_PAD_V * 2)
    : clip.assetId ? width * aspect : width;
  const guides = drag && (shown.x === 0.5 || shown.y === 0.5);
  // ponytail: b-roll previews as a still; the export plays it.
  const stickerUri = clip.assetId
    ? (asset?.mimeType.startsWith('video/') ? assetThumbUrl(clip.assetId) : assetOriginalUrl(clip.assetId))
    : undefined;

  return (
    <>
      {guides && shown.x === 0.5 && <View pointerEvents="none" style={[styles.guide, styles.guideVertical, { left: stage.width / 2 }]} />}
      {guides && shown.y === 0.5 && <View pointerEvents="none" style={[styles.guide, styles.guideHorizontal, { top: stage.height / 2 }]} />}
      <View
        {...responder.panHandlers}
        style={[
          styles.sticker,
          {
            left: shown.x * stage.width - width / 2,
            top: shown.y * stage.height - height / 2,
            width,
            height,
            transform: [{ rotate: `${shown.rotation}deg` }],
          },
          selected && styles.stickerSelected,
        ]}
      >
        {callout
          ? (
            <View
              style={[styles.callout, {
                borderRadius: calloutFont * CALLOUT_RADIUS,
                paddingHorizontal: calloutFont * CALLOUT_PAD_H,
                paddingVertical: calloutFont * CALLOUT_PAD_V,
                gap: calloutFont * 0.4,
                backgroundColor: callout.bg ?? CALLOUT_BG,
              }]}
            >
              {mark && (
                <Text style={[styles.calloutGlyph, { fontSize: calloutFont, lineHeight: calloutFont * CALLOUT_LINE, color: callout.color ?? mark.color }]}>
                  {mark.glyph}
                </Text>
              )}
              <Text numberOfLines={1} style={[styles.calloutText, { fontSize: calloutFont, lineHeight: calloutFont * CALLOUT_LINE }]}>
                {clip.text}
              </Text>
            </View>
          )
          : stickerUri
            ? <Image source={{ uri: stickerUri }} style={styles.stickerImage} contentFit="contain" />
            : <Text style={[styles.stickerEmoji, { fontSize: width * 0.82, lineHeight: height }]}>{clip.text}</Text>}
      </View>
    </>
  );
}

/** Placement after a drag, clamped to the stage with a centre magnet. */
function dragPlacement(placement: OverlayPlacement, dx: number, dy: number, stage: { width: number; height: number }): OverlayPlacement {
  const x = Math.max(0, Math.min(1, placement.x + (stage.width > 0 ? dx / stage.width : 0)));
  const y = Math.max(0, Math.min(1, placement.y + (stage.height > 0 ? dy / stage.height : 0)));
  return {
    ...placement,
    x: Math.abs(x - 0.5) <= STICKER_SNAP ? 0.5 : Math.round(x * 1000) / 1000,
    y: Math.abs(y - 0.5) <= STICKER_SNAP ? 0.5 : Math.round(y * 1000) / 1000,
  };
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
 * whatever casing the agent baked in.
 *
 * Karaoke previews the export word for word. `style.words` carries absolute
 * timeline seconds (agent/tools.ts maps source times through clip.in,
 * clip.start and speed), and libass starts the `\k` clock at the event start —
 * so word i flips once the preceding `\k` durations elapse, at
 * `clip.start + (word.s - words[0].s)`. Sung words take `emphasisColor` and
 * unsung ones the base colour, which is the primary/secondary swap that
 * server/src/media/ass.ts applies to karaoke styles.
 *
 * The playhead is folded down to "how many words have been sung", so this
 * re-renders once per word flip rather than once per frame.
 */
function CaptionOverlay({ clip, clock, stage }: { clip: Clip; clock: PlayheadClock; stage: { width: number; height: number } }) {
  const style = clip.style;
  const words = style?.words;
  const karaokeStart = words?.[0]?.s ?? 0;
  const sung = usePlayheadSelector(clock, useCallback((time: number) => {
    if (!words?.length) return 0;
    let count = 0;
    for (const word of words) {
      if (time >= clip.start + (word.s - karaokeStart)) count += 1;
      else break;
    }
    return count;
  }, [words, clip.start, karaokeStart]));
  const fontSize = style?.sizePct !== undefined
    ? (style.sizePct / 100) * stage.height
    : ((style?.size ?? 52) / 1080) * stage.width;
  const anchor = style?.anchorPct !== undefined
    ? style.anchorPct
    : style?.position === 'top' ? 12 : style?.position === 'center' ? 50 : 84;
  const sungColor = style?.emphasisColor ?? '#FACC15';
  return (
    <View pointerEvents="none" style={[styles.captionLayer, { top: (anchor / 100) * stage.height - fontSize }]}>
      <Text
        numberOfLines={3}
        style={[styles.captionText, {
          fontSize: Math.max(9, fontSize),
          lineHeight: Math.max(11, fontSize * 1.15),
          color: style?.color ?? '#FFFFFF',
          // ASS bold is off only for 'none' ('highlight' is bold too), so that
          // is the one case that drops the heavy face.
          // ponytail: weight only — style.font stays Space Grotesk, the one family bundled.
          ...(style?.emphasis === 'none' && { fontFamily: fonts.medium }),
          textShadowColor: style?.strokeColor ?? '#000000',
          textShadowRadius: Math.max(2, (style?.strokePx ?? 4) * (fontSize / 40)),
        }]}
      >
        {words?.length
          ? words.map((word, index) => (
            <Text key={index} style={index < sung ? { color: sungColor } : undefined}>
              {index > 0 ? ' ' : ''}{word.w}
            </Text>
          ))
          : clip.text}
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
  zoneLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.5 },
  meta: { color: colors.muted, fontFamily: fonts.semibold, fontSize: 9, flexShrink: 1 },
  stageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 140 },
  stage: { borderRadius: 8, overflow: 'hidden', backgroundColor: '#000000' },
  video: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  videoFill: { width: '100%', height: '100%' },
  audioElement: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  poster: { overflow: 'hidden', backgroundColor: '#000000' },
  dip: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000000' },
  gap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  gapText: { color: '#4A4860', fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2 },
  sticker: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  stickerSelected: { borderWidth: 1, borderColor: colors.pink, borderRadius: 6 },
  stickerImage: { width: '100%', height: '100%' },
  stickerEmoji: { textAlign: 'center' },
  callout: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center' },
  calloutGlyph: { fontFamily: fonts.bold },
  calloutText: { flexShrink: 1, color: '#FFFFFF', fontFamily: fonts.bold },
  guide: { position: 'absolute', backgroundColor: colors.pink, opacity: 0.8, zIndex: 5 },
  guideVertical: { top: 0, bottom: 0, width: 1 },
  guideHorizontal: { left: 0, right: 0, height: 1 },
  captionLayer: { position: 'absolute', left: 8, right: 8, alignItems: 'center' },
  captionText: { fontFamily: fonts.bold, textAlign: 'center' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  control: { minWidth: 30, height: 26, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  controlPrimary: { backgroundColor: colors.purple, borderColor: colors.purple },
  controlText: { color: colors.text, fontFamily: fonts.bold, fontSize: 11 },
  controlTextPrimary: { color: '#FFFFFF' },
  timecode: { color: colors.text, fontFamily: fonts.bold, fontSize: 11, fontVariant: ['tabular-nums'] },
  timecodeMuted: { color: colors.muted, fontFamily: fonts.semibold, fontSize: 11, fontVariant: ['tabular-nums'] },
  spacer: { flex: 1 },
  hint: { color: colors.muted, fontFamily: fonts.regular, fontSize: 8 },
  pressed: { opacity: 0.65 },
});
