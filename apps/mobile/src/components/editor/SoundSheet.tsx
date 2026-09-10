import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useVideoPlayer } from 'expo-video';
import type { LibrarySound, SoundCategory } from '@editify/shared';
import { api, mediaUrl } from '../../lib/api';
import { colors, radius, space, type, fonts } from '../../lib/theme';

const CATEGORY_LABELS: Record<SoundCategory, string> = {
  whoosh: 'Whoosh', impact: 'Impact', pop: 'Pop', ui: 'UI', riser: 'Riser', music: 'Music',
};

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
  const [category, setCategory] = useState<SoundCategory | 'all'>('all');
  const [playingId, setPlayingId] = useState<string>();
  const [addedId, setAddedId] = useState<string>();
  const soundsQuery = useQuery({ queryKey: ['sounds'], queryFn: api.listSounds, enabled: visible, staleTime: Infinity });
  // One shared player: tapping a row swaps its source. Audio-only playback.
  const player = useVideoPlayer(null, (instance) => { instance.loop = false; });

  const sounds = useMemo(() => (soundsQuery.data ?? [])
    .filter((sound) => category === 'all' || sound.category === category), [category, soundsQuery.data]);
  const categories = useMemo(
    () => [...new Set((soundsQuery.data ?? []).map((sound) => sound.category))],
    [soundsQuery.data],
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

  function add(sound: LibrarySound): void {
    onAdd(sound);
    setAddedId(sound.id);
    setTimeout(() => setAddedId((current) => (current === sound.id ? undefined : current)), 1200);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
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
          <Text style={styles.subtitle}>tap to preview · + drops it at the playhead</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={styles.chipsContent}>
            {(['all', ...categories] as Array<SoundCategory | 'all'>).map((item) => (
              <Pressable
                key={item}
                onPress={() => setCategory(item)}
                style={[styles.chip, category === item && styles.chipActive]}
              >
                <Text style={[styles.chipText, category === item && styles.chipTextActive]}>
                  {item === 'all' ? 'All' : CATEGORY_LABELS[item]}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <ScrollView style={styles.list} nestedScrollEnabled>
            {soundsQuery.isLoading && <Text style={styles.hint}>synthesizing the library…</Text>}
            {soundsQuery.isError && <Text style={styles.error}>Could not load sounds: {soundsQuery.error.message}</Text>}
            {sounds.map((sound) => (
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  close: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.xl, padding: space.sm },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm },
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
