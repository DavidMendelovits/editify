import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { editSummary } from '../lib/agent';
import type { ChatMessage } from '../lib/api';
import { colors } from '../lib/theme';

/**
 * Plain-language digest of what the agent has done to this video so far —
 * "Made 6 cuts to tighten pacing", "Added captions (12)". The per-message trace
 * and receipts in the chat dock stay the detailed record; this is the glance.
 */
export function EditSummaryPanel({ messages }: { messages: ChatMessage[] | undefined }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => editSummary(messages ?? []), [messages]);
  if (lines.length === 0) return null;

  return (
    <View style={styles.zone}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={styles.label}>WHAT THE AI DID · {lines.length} {lines.length === 1 ? 'CHANGE' : 'CHANGES'}</Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open && (
        <View style={styles.list}>
          {lines.map((line) => (
            <View key={line} style={styles.row}>
              <Text style={styles.bullet}>—</Text>
              <Text style={styles.line}>{line}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  zone: { borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12, paddingVertical: 9, gap: 7 },
  header: { minHeight: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  label: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5 },
  chevron: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 10 },
  list: { gap: 5, paddingBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  bullet: { color: colors.purple, fontFamily: 'Montserrat_800ExtraBold', fontSize: 9 },
  line: { flex: 1, color: colors.text, fontFamily: 'Montserrat_500Medium', fontSize: 10, lineHeight: 15 },
  pressed: { opacity: 0.7 },
});
