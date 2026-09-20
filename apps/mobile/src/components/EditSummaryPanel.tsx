import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { editSummary } from '../lib/agent';
import type { ChatMessage } from '../lib/api';
import { colors, radius, space, type, fonts } from '../lib/theme';

/**
 * Plain-language digest of what the agent has done to this video so far —
 * "Made 6 cuts to tighten pacing", "Added captions (12)". The per-message trace
 * and receipts in the chat dock stay the detailed record; this is the glance.
 */
export function EditSummaryPanel({ messages, open, onToggle }: { messages: ChatMessage[] | undefined; open: boolean; onToggle: () => void }) {
  const lines = useMemo(() => editSummary(messages ?? []), [messages]);
  if (lines.length === 0) return null;

  return (
    <View style={[styles.zone, open && styles.zoneOpen]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={styles.label}>WHAT THE AI DID · {lines.length} {lines.length === 1 ? 'CHANGE' : 'CHANGES'}</Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open && (
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={styles.list} nestedScrollEnabled>
          {lines.map((line) => (
            <View key={line} style={styles.row}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.line}>{line}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Collapsed zones keep their natural header height (no flexShrink), and an open
  // zone gets a real budget via maxHeight: tall enough to show several lines, capped
  // so the inner ScrollView still scrolls and the dock column stays navigable.
  zone: { minHeight: 0, overflow: 'hidden', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: space.xl, paddingVertical: space.lg, gap: space.md },
  zoneOpen: { flexShrink: 0, maxHeight: 220 },
  header: { minHeight: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.lg },
  label: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.sm, letterSpacing: 1.5 },
  chevron: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.md },
  list: { gap: space.sm, paddingBottom: space.xs },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  bullet: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.sm },
  line: { flex: 1, color: colors.text, fontFamily: fonts.medium, fontSize: type.md, lineHeight: 15 },
  pressed: { opacity: 0.7 },
});
