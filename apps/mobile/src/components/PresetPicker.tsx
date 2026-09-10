import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { contentTagLabel, FALLBACK_PRESETS, presetTitle, type EditPreset } from '../lib/presets';
import { colors, radius, space, type, fonts } from '../lib/theme';

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
      <View style={[styles.inner, active && styles.innerActive]}>{body}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  label: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.5 },
  row: { gap: space.md, paddingBottom: space.xs },
  card: { width: 160 },
  inner: { flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  innerActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  name: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.base },
  nameActive: { color: colors.text },
  tags: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.4 },
  pressed: { opacity: 0.75 },
});
