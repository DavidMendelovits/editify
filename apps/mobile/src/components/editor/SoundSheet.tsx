import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { AssetMetadata, LibrarySound, SoundCategory } from '@editify/shared';
import { api, mediaUrl } from '../../lib/api';
import { isAudioOnly } from '../../lib/media';
import { pickFromFiles } from '../../lib/pick';
import { colors, radius, space, type, fonts } from '../../lib/theme';

const CATEGORY_LABELS: Record<SoundCategory, string> = {
  whoosh: 'Whoosh', impact: 'Impact', pop: 'Pop', ui: 'UI', riser: 'Riser', music: 'Music',
};

/** Built-in library rows live in the same asset table; their ids carry this prefix. */
const LIBRARY_ID_PREFIX = 'sound-';

/**
 * The creator's own uploads, shaped like a library sound so `onAdd` — and the
 * `add_clip` it runs — stays exactly the same for both tabs. `url` is a path,
 * not an absolute URL: the shared player runs it through `mediaUrl` itself.
 */
function asLibrarySound(asset: AssetMetadata): LibrarySound {
  return {
    id: asset.id,
    name: asset.label ?? asset.originalName,
    category: 'music',
    duration: asset.duration,
    assetId: asset.id,
    url: `/assets/${asset.id}/original`,
  };
}

/** The creator's own audio: audio-only, and not one of the built-in library sounds. */
function isTrack(asset: AssetMetadata): boolean {
  return !asset.id.startsWith(LIBRARY_ID_PREFIX) && isAudioOnly(asset);
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Adds the sound at the playhead; the sheet stays open (CapCut pattern). */
  onAdd: (sound: LibrarySound) => void;
}

/**
 * The sound library sheet: category chips, tap a row to preview in place, tap
 * `+` to drop it on the audio track at the playhead without closing the sheet.
 */
export function SoundSheet({ visible, onClose, onAdd }: Props) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'sfx' | 'music'>('sfx');
  const [category, setCategory] = useState<SoundCategory | 'all'>('all');
  const [playingId, setPlayingId] = useState<string>();
  const [addedId, setAddedId] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const queryClient = useQueryClient();
  const soundsQuery = useQuery({ queryKey: ['sounds'], queryFn: api.listSounds, enabled: visible, staleTime: Infinity });
  // The creator's library-wide tracks: no projectId, so they follow them across projects.
  const tracksQuery = useQuery({
    queryKey: ['assets'],
    queryFn: async () => await api.listAssets(),
    enabled: visible && tab === 'music',
  });
  // One shared player: tapping a row swaps its source. Audio-only playback.
  const player = useVideoPlayer(null, (instance) => { instance.loop = false; });

  // The row toggle must revert to ▶ when the clip runs out, otherwise the next
  // tap is read as "stop" and silently does nothing.
  useEffect(() => {
    const subscription = player.addListener('playToEnd', () => setPlayingId(undefined));
    return () => subscription.remove();
  }, [player]);

  const sounds = useMemo(() => (soundsQuery.data ?? [])
    .filter((sound) => category === 'all' || sound.category === category), [category, soundsQuery.data]);
  const categories = useMemo(
    () => [...new Set((soundsQuery.data ?? []).map((sound) => sound.category))],
    [soundsQuery.data],
  );
  const tracks = useMemo(
    () => (tracksQuery.data ?? []).filter(isTrack).map(asLibrarySound),
    [tracksQuery.data],
  );

  function preview(sound: LibrarySound): void {
    if (playingId === sound.id) {
      try { player.pause(); } catch { /* already stopped */ }
      setPlayingId(undefined);
      return;
    }
    setPlayingId(sound.id);
    player.replaceAsync(mediaUrl(sound.url))
      .then(() => { player.play(); })
      .catch(() => setPlayingId((current) => (current === sound.id ? undefined : current)));
  }

  async function upload(): Promise<void> {
    setUploading(true);
    setUploadError(undefined);
    try {
      const result = await pickFromFiles(undefined);
      if (result.failed.length > 0) setUploadError(`Could not upload ${result.failed.join(', ')}`);
      if (result.assets.length > 0) await queryClient.invalidateQueries({ queryKey: ['assets'] });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }

  function add(sound: LibrarySound): void {
    onAdd(sound);
    setAddedId(sound.id);
    setTimeout(() => setAddedId((current) => (current === sound.id ? undefined : current)), 1200);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: space.xxl + insets.bottom }]}>
          {/* Audio-only, but expo-video on web only has a media element to play
              through while a view is mounted for the player — without this the
              preview is a silent no-op. */}
          <VideoView player={player} style={styles.audioElement} nativeControls={false} />
          <View style={styles.header}>
            <Text style={styles.title}>SOUND LIBRARY</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="close"
              hitSlop={10}
              onPress={() => {
                // Close FIRST: pause() can throw on the web player when no
                // source is loaded, and the sheet must never get stuck open.
                onClose();
                setPlayingId(undefined);
                try { player.pause(); } catch { /* nothing was playing */ }
              }}
            >
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <View style={styles.tabs}>
            {([['sfx', 'SFX'], ['music', 'MY MUSIC']] as const).map(([key, label]) => (
              <Pressable
                key={key}
                accessibilityRole="tab"
                accessibilityLabel={`${label.toLowerCase()} tab`}
                accessibilityState={{ selected: tab === key }}
                onPress={() => setTab(key)}
                style={[styles.tab, tab === key && styles.tabActive]}
              >
                <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.subtitle}>tap to preview · + drops it at the playhead</Text>
          {tab === 'sfx' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={styles.chipsContent}>
              {(['all', ...categories] as Array<SoundCategory | 'all'>).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="button"
                  accessibilityLabel={`${item} category`}
                  onPress={() => setCategory(item)}
                  style={[styles.chip, category === item && styles.chipActive]}
                >
                  <Text style={[styles.chipText, category === item && styles.chipTextActive]}>
                    {item === 'all' ? 'All' : CATEGORY_LABELS[item]}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="upload track"
              disabled={uploading}
              onPress={() => void upload()}
              style={({ pressed }) => [styles.chip, styles.upload, pressed && styles.pressed]}
            >
              <Text style={styles.uploadText}>{uploading ? 'UPLOADING…' : '+ UPLOAD TRACK'}</Text>
            </Pressable>
          )}
          <ScrollView style={styles.list} nestedScrollEnabled>
            {tab === 'sfx' && soundsQuery.isLoading && <Text style={styles.hint}>synthesizing the library…</Text>}
            {tab === 'sfx' && soundsQuery.isError && <Text style={styles.error}>Could not load sounds: {soundsQuery.error.message}</Text>}
            {tab === 'music' && uploadError !== undefined && <Text style={styles.error}>{uploadError}</Text>}
            {tab === 'music' && tracksQuery.isLoading && <Text style={styles.hint}>loading your tracks…</Text>}
            {tab === 'music' && tracksQuery.isError && <Text style={styles.error}>Could not load your tracks: {tracksQuery.error.message}</Text>}
            {tab === 'music' && !tracksQuery.isLoading && !tracksQuery.isError && tracks.length === 0 && (
              <Text style={styles.hint}>No tracks yet. Upload one and it stays in your library.</Text>
            )}
            {(tab === 'sfx' ? sounds : tracks).map((sound) => (
              <View key={sound.id} style={styles.row}>
                <Pressable accessibilityRole="button" accessibilityLabel={`preview ${sound.name}`} style={styles.rowBody} onPress={() => preview(sound)}>
                  <Text style={styles.playIcon}>{playingId === sound.id ? '■' : '▶'}</Text>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName}>{sound.name}</Text>
                    <Text style={styles.rowMeta}>{CATEGORY_LABELS[sound.category]} · {sound.duration.toFixed(1)}s</Text>
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`add ${sound.name}`}
                  hitSlop={8}
                  onPress={() => add(sound)}
                  style={({ pressed }) => [styles.add, pressed && styles.pressed, addedId === sound.id && styles.addDone]}
                >
                  <Text style={styles.addText}>{addedId === sound.id ? '✓' : '+'}</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000AA' },
  sheet: {
    maxHeight: '72%', borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.xxl, gap: space.lg,
  },
  audioElement: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  close: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.xl, padding: space.sm },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm },
  tabs: { flexDirection: 'row', gap: space.md },
  tab: {
    flex: 1, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, minHeight: 30, alignItems: 'center', justifyContent: 'center',
  },
  tabActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  tabText: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.2 },
  tabTextActive: { color: colors.text },
  upload: { alignSelf: 'flex-start', alignItems: 'center', paddingHorizontal: space.xl },
  uploadText: { color: colors.text, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.2 },
  chips: { flexGrow: 0 },
  chipsContent: { gap: space.md, paddingVertical: space.sm },
  chip: {
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised,
    paddingHorizontal: space.xl, minHeight: 30, justifyContent: 'center',
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { color: colors.muted, fontFamily: fonts.semibold, fontSize: type.md },
  chipTextActive: { color: colors.text },
  list: { minHeight: 180 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingVertical: space.sm },
  rowBody: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.lg },
  playIcon: { width: 26, textAlign: 'center', color: colors.text, fontFamily: fonts.bold, fontSize: type.lg },
  rowText: { flex: 1, gap: 1 },
  rowName: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg },
  rowMeta: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.sm },
  add: {
    width: 44, height: 44, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center',
  },
  addDone: { borderColor: colors.success, backgroundColor: colors.successSoft },
  addText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  hint: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, paddingVertical: space.xl },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.md, paddingVertical: space.xl },
  pressed: { opacity: 0.65 },
});
