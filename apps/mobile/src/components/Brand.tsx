import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../lib/theme';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <View style={styles.row} accessibilityLabel="editify">
      <Text style={[styles.word, compact && styles.compact]}>
        <Text style={{ color: colors.blue }}>edi</Text>
        <Text style={{ color: colors.purple }}>ti</Text>
        <Text style={{ color: colors.pink }}>fy</Text>
      </Text>
      {!compact && <View style={styles.beta}><Text style={styles.betaText}>AI EDITOR</Text></View>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  word: { fontFamily: 'Montserrat_800ExtraBold', fontSize: 30, letterSpacing: -1.5 },
  compact: { fontSize: 24 },
  beta: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 4 },
  betaText: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.2 },
});
