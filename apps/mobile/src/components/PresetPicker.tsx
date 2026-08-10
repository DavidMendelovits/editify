import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { contentTagLabel, FALLBACK_PRESETS, presetTitle, type EditPreset } from '../lib/presets';
import { colors, gradient } from '../lib/theme';

interface Props {
  /** Name of the preset whose prompt is currently loaded in the composer. */
  selected: string | undefined;
  onSelect: (preset: EditPreset) => void;
}

/**
 * Horizontal row of editing-style cards above the suggestion chips. Tapping a
 * card writes its prompt into the composer — the agent still does the work, so
 * the user can edit the sentence before sending.
 */
export function PresetPicker({ selected, onSelect }: Props) {
  const presetsQuery = useQuery({
    queryKey: ['presets'],
    queryFn: () => api.listPresets(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  // `null` = the server answered 404; `undefined` = still loading or errored.
  // Either way the five researched presets are a truthful stand-in.
  const presets = presetsQuery.data ?? FALLBACK_PRESETS;

  return (
    <View style={styles.section}>
      <Text style={styles.label}>PRESETS</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {presets.map((preset) => (
          <PresetCard
            key={preset.name}
            preset={preset}
            active={preset.name === selected}
            onPress={() => onSelect(preset)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function PresetCard({ preset, active, onPress }: { preset: EditPreset; active: boolean; onPress: () => void }) {
  const tags = preset.targetContent.slice(0, 2).map(contentTagLabel).join(' · ');
  const body = (
    <>
      <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>{presetTitle(preset.name)}</Text>
      {tags.length > 0 && <Text style={styles.tags} numberOfLines={1}>{tags}</Text>}
      <Text style={styles.description} numberOfLines={3}>{preset.description}</Text>
    </>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Use the ${presetTitle(preset.name)} preset`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      {active ? (
        <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.frame}>
          <View style={[styles.inner, styles.innerActive]}>{body}</View>
        </LinearGradient>
      ) : (
        <View style={[styles.frame, styles.frameIdle]}><View style={styles.inner}>{body}</View></View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: 5 },
  label: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1.5 },
  row: { gap: 6, paddingBottom: 2 },
  card: { width: 168, borderRadius: 13 },
  frame: { borderRadius: 13, padding: 1.5 },
  frameIdle: { backgroundColor: colors.border },
  inner: { flex: 1, borderRadius: 11.5, backgroundColor: colors.panelRaised, paddingHorizontal: 9, paddingVertical: 8, gap: 3 },
  innerActive: { backgroundColor: colors.background },
  name: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 11 },
  nameActive: { color: colors.text },
  tags: { color: colors.purple, fontFamily: 'Montserrat_600SemiBold', fontSize: 8, letterSpacing: 0.4 },
  description: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 8, lineHeight: 12 },
  pressed: { opacity: 0.75 },
});
