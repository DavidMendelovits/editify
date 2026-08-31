import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useVideoPlayer } from 'expo-video';
import type { LibrarySound, SoundCategory } from '@editify/shared';
import { api, mediaUrl } from '../../lib/api';
import { colors, fonts } from '../../lib/theme';

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
              <Text style={styles.close}>✕</Text>
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
                  <Text style={styles.playIcon}>{playingId === sound.id ? '⏸' : '▶'}</Text>
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
    maxHeight: '72%', borderTopLeftRadius: 18, borderTopRightRadius: 18,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 16, gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.muted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.5 },
  close: { color: colors.muted, fontFamily: fonts.bold, fontSize: 14, padding: 4 },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: 9 },
  chips: { flexGrow: 0 },
  chipsContent: { gap: 6, paddingVertical: 4 },
  chip: {
    borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised,
    paddingHorizontal: 12, minHeight: 30, justifyContent: 'center',
  },
  chipActive: { borderColor: colors.purple, backgroundColor: '#2A1F47' },
  chipText: { color: colors.muted, fontFamily: fonts.semibold, fontSize: 10 },
  chipTextActive: { color: colors.text },
  list: { minHeight: 180 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  rowBody: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
  playIcon: { width: 26, textAlign: 'center', color: colors.text, fontFamily: fonts.bold, fontSize: 12 },
  rowText: { flex: 1, gap: 1 },
  rowName: { color: colors.text, fontFamily: fonts.semibold, fontSize: 12 },
  rowMeta: { color: colors.muted, fontFamily: fonts.medium, fontSize: 9 },
  add: {
    width: 44, height: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center',
  },
  addDone: { borderColor: '#2E7D4F', backgroundColor: '#153524' },
  addText: { color: colors.text, fontFamily: fonts.bold, fontSize: 16 },
  hint: { color: colors.muted, fontFamily: fonts.regular, fontSize: 10, paddingVertical: 12 },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: 10, paddingVertical: 12 },
  pressed: { opacity: 0.65 },
});
