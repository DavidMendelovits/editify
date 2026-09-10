import { StyleSheet, Text, View } from 'react-native';
import { colors, space, type, fonts } from '../lib/theme';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <View style={styles.row} accessibilityLabel="editify">
      <Text style={[styles.word, compact && styles.compact]}>editify</Text>
      {!compact && <Text style={styles.tag}>AI EDITOR</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', gap: space.lg },
  word: { color: colors.text, fontFamily: fonts.display, fontSize: type.title, letterSpacing: 0 },
  compact: { fontSize: type.xxl },
  tag: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.2 },
});
