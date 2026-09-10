import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { STYLE_PACKETS, type StylePacket } from '@editify/shared';
import { api } from '../../lib/api';
import { PACKET_DRAFTS_KEY, packetFromProfile } from '../../lib/packets';
import { colors, radius, space, type, fonts } from '../../lib/theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Applying goes through the agent so the creative parts (callouts, b-roll) get judgment. */
  onApply: (packet: StylePacket) => void;
  busy: boolean;
}

/**
 * The style packet picker: each packet is a creator's repeatable look —
 * typography, music bed, transition habit, callout/b-roll density — applied
 * to the whole timeline in one tap. Alongside the built-ins it offers the
 * user's own looks: the saved "learn my style" profile, and any preset made
 * from a dissected clip. One at a time — applying is a sweep, not a blend.
 */
export function StylePacketSheet({ visible, onClose, onApply, busy }: Props) {
  const profile = useQuery({ queryKey: ['style-profile'], queryFn: api.getStyle, retry: false, enabled: visible });
  const drafts = useQuery({
    queryKey: PACKET_DRAFTS_KEY,
    queryFn: (): StylePacket[] => [],
    staleTime: Infinity,
    gcTime: Infinity,
  }).data ?? [];
  const learned = profile.data?.profile ? packetFromProfile(profile.data.profile) : undefined;
  const sections: Array<{ label: string; packets: readonly StylePacket[] }> = [
    { label: 'BUILT-IN', packets: STYLE_PACKETS },
    ...(learned ? [{ label: 'FROM LEARN MY STYLE', packets: [learned] }] : []),
    ...(drafts.length ? [{ label: 'FROM A DISSECTED CLIP', packets: drafts }] : []),
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>STYLE PACKETS</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="close" hitSlop={10} onPress={onClose}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>one tap restyles the whole edit — captions, music, transitions, devices</Text>
          <ScrollView style={styles.list}>
            {sections.map((section) => (
              <View key={section.label}>
                <Text style={styles.sectionLabel}>{section.label}</Text>
                {section.packets.map((packet) => (
                  <View key={packet.id} style={styles.row}>
                    <View style={styles.swatches}>
                      <View style={[styles.swatch, { backgroundColor: packet.colors.accent }]} />
                      {packet.colors.good && <View style={[styles.swatch, { backgroundColor: packet.colors.good }]} />}
                      {packet.colors.bad && <View style={[styles.swatch, { backgroundColor: packet.colors.bad }]} />}
                    </View>
                    <View style={styles.rowText}>
                      <Text style={styles.rowName}>{packet.name}</Text>
                      {packet.source && <Text style={styles.rowSource}>after {packet.source.creator}</Text>}
                      <Text style={styles.rowMeta}>{packet.description}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`apply ${packet.name}`}
                      hitSlop={8}
                      disabled={busy}
                      onPress={() => onApply(packet)}
                      style={({ pressed }) => [styles.apply, pressed && styles.pressed, busy && styles.disabled]}
                    >
                      <Text style={styles.applyText}>{busy ? '…' : 'apply'}</Text>
                    </Pressable>
                  </View>
                ))}
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
  list: { minHeight: 160 },
  sectionLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.4, paddingTop: space.xl },
  row: { flexDirection: 'row', gap: space.lg, paddingVertical: space.lg, borderTopWidth: 1, borderTopColor: colors.border },
  swatches: { gap: space.xs, paddingTop: space.xs },
  swatch: { width: 10, height: 10, borderRadius: radius.md },
  rowText: { flex: 1, gap: space.xs },
  rowName: { color: colors.text, fontFamily: fonts.bold, fontSize: type.lg },
  rowSource: { color: colors.muted, fontFamily: fonts.semibold, fontSize: type.sm },
  rowMeta: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, lineHeight: 15 },
  apply: {
    alignSelf: 'center', minHeight: 44, minWidth: 64, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  applyText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.base },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.5 },
});
