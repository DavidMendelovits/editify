import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetMetadata, StylePacket } from '@editify/shared';
import { api } from '../lib/api';
import { PACKET_DRAFTS_KEY, packetFromDissection } from '../lib/packets';
import { colors, radius, space, type, fonts } from '../lib/theme';
import { DissectPanel } from './DissectPanel';

interface Props {
  asset: AssetMetadata;
  onClose: () => void;
}

/**
 * What you can do to a clip that is not editing it. Dissection lives here
 * rather than in the cutting room: measuring a reference is how you get a new
 * preset, which is a decision made before the edit, not during it.
 */
export function AssetActionSheet({ asset, onClose }: Props) {
  const queryClient = useQueryClient();
  const name = (asset.label ?? asset.originalName).replace(/\.[^.]+$/, '');
  // Observes the cache the panel below fills — no second network trip.
  const dissection = useQuery({
    queryKey: ['dissect', asset.id],
    queryFn: () => api.dissect(asset.id),
    enabled: false,
    staleTime: Infinity,
  }).data;
  const drafts = useQuery({
    queryKey: PACKET_DRAFTS_KEY,
    queryFn: (): StylePacket[] => [],
    staleTime: Infinity,
    gcTime: Infinity,
  }).data ?? [];
  const draftId = `dissect-${asset.id}`;
  const saved = drafts.some((packet) => packet.id === draftId);

  function saveAsPreset(): void {
    if (!dissection) return;
    const packet = packetFromDissection(dissection, name);
    queryClient.setQueryData<StylePacket[]>(PACKET_DRAFTS_KEY, (current) => [
      packet,
      ...(current ?? []).filter((existing) => existing.id !== packet.id),
    ]);
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="close clip actions">
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>CLIP</Text>
              <Text style={styles.title} numberOfLines={1}>{name}</Text>
            </View>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="close" hitSlop={10}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body}>
            <DissectPanel assetIds={[asset.id]} assets={{ [asset.id]: asset }} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="make a preset from this clip"
              disabled={!dissection}
              onPress={saveAsPreset}
              style={({ pressed }) => [styles.action, pressed && styles.pressed, !dissection && styles.disabled]}
            >
              <View style={styles.actionText}>
                <Text style={styles.actionLabel}>{saved ? 'preset saved' : 'make a preset'}</Text>
                <Text style={styles.actionHint}>
                  {saved ? 'pick it up under STYLE PACKETS in the editor'
                    : dissection ? 'pacing, transition, and caption placement from the measurements'
                    : 'dissect the clip first: the preset comes off its measurements'}
                </Text>
              </View>
              <Text style={styles.actionCue}>{saved ? '✓' : '+'}</Text>
            </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000AA' },
  sheet: {
    maxHeight: '82%', borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.xxl, gap: space.lg,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.xl },
  headerText: { flex: 1, gap: space.xs },
  eyebrow: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  close: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.xl, padding: space.sm },
  body: { gap: space.lg, paddingBottom: space.lg },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: space.xl, minHeight: 56, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: space.xl, paddingVertical: space.lg,
  },
  actionText: { flex: 1, gap: space.xs },
  actionLabel: { color: colors.text, fontFamily: fonts.bold, fontSize: type.lg },
  actionHint: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, lineHeight: 15 },
  actionCue: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xl },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.5 },
});
