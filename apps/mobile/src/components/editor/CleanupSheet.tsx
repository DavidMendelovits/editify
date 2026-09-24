import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import type { Operation, Project } from '@editify/shared';
import { apiFetch } from '../../lib/api';
import { colors, radius, space, type, fonts } from '../../lib/theme';

interface Props {
  projectId: string;
  project: Project | undefined;
  visible: boolean;
  onClose: () => void;
  /** Ops go through the project screen's serialized mutation chain. */
  onApply: (ops: Operation[]) => void;
}

interface CleanupRange { start: number; end: number }

/** `GET /projects/:id/cleanup` — read-only measurement, never a mutation. */
interface CleanupPlan {
  transcribed: boolean;
  fillers: { ranges: CleanupRange[]; words: string[]; seconds: number };
  silences: { ranges: CleanupRange[]; seconds: number };
  trackId: string;
}

async function fetchCleanupPlan(projectId: string): Promise<CleanupPlan> {
  const response = await apiFetch(`/projects/${projectId}/cleanup`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body ? `${response.status}: ${body}` : `Request failed with ${response.status}`);
  }
  return await response.json() as CleanupPlan;
}

/** ripple_delete_ranges takes at most 50 ranges per operation. */
const MAX_RANGES = 50;

/** Over the cap, the longest cuts buy the most back; the rest wait for another pass. */
function capRanges(ranges: CleanupRange[]): CleanupRange[] {
  if (ranges.length <= MAX_RANGES) return ranges;
  return [...ranges]
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))
    .slice(0, MAX_RANGES)
    .sort((left, right) => left.start - right.start);
}

/** One-tap cleanup: filler words and dead air, measured server-side. */
export function CleanupSheet({ projectId, project, visible, onClose, onApply }: Props) {
  const insets = useSafeAreaInsets();
  const [appliedRow, setAppliedRow] = useState<'fillers' | 'silences'>();
  // Keyed on the version so an apply — which bumps it — re-measures what is left.
  const planQuery = useQuery({
    queryKey: ['cleanup', projectId, project?.version],
    queryFn: () => fetchCleanupPlan(projectId),
    enabled: visible,
  });
  const plan = planQuery.data;

  function apply(row: 'fillers' | 'silences', ranges: CleanupRange[]): void {
    if (!plan || !ranges.length) return;
    onApply([{ type: 'ripple_delete_ranges', params: { trackId: plan.trackId, ranges: capRanges(ranges) } }]);
    setAppliedRow(row);
    setTimeout(() => setAppliedRow((current) => (current === row ? undefined : current)), 1200);
  }

  const fillerCount = plan?.fillers.ranges.length ?? 0;
  const silenceCount = plan?.silences.ranges.length ?? 0;
  const nothingToCut = Boolean(plan?.transcribed) && !fillerCount && !silenceCount;
  const capped = fillerCount > MAX_RANGES || silenceCount > MAX_RANGES;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: space.xxl + insets.bottom }]}>
          <View style={styles.header}>
            <Text style={styles.title}>CLEANUP</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="close" hitSlop={10} onPress={onClose}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>measured on the video track · cuts and closes the gap</Text>

          {planQuery.isLoading && <Text style={styles.hint}>measuring…</Text>}
          {planQuery.isError && <Text style={styles.error}>Could not measure: {planQuery.error.message}</Text>}
          {plan && !plan.transcribed && <Text style={styles.hint}>no transcript yet: ask the agent to transcribe first</Text>}
          {nothingToCut && <Text style={styles.hint}>clean already</Text>}

          {plan?.transcribed && !nothingToCut && (
            <View style={styles.rows}>
              <Row
                name="Filler words"
                meta={fillerCount
                  ? `${fillerCount} ${fillerCount === 1 ? 'cut' : 'cuts'} · ${plan.fillers.seconds.toFixed(1)}s · ${plan.fillers.words.join(', ')}`
                  : 'clean already'}
                done={appliedRow === 'fillers'}
                onPress={() => apply('fillers', plan.fillers.ranges)}
              />
              <Row
                name="Dead air"
                meta={silenceCount
                  ? `${silenceCount} ${silenceCount === 1 ? 'gap' : 'gaps'} · ${plan.silences.seconds.toFixed(1)}s`
                  : 'clean already'}
                done={appliedRow === 'silences'}
                onPress={() => apply('silences', plan.silences.ranges)}
              />
              {capped && <Text style={styles.note}>a pass cuts at most {MAX_RANGES} ranges, longest first. Tap again for the rest</Text>}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Row({ name, meta, done, onPress }: { name: string; meta: string; done: boolean; onPress: () => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowName}>{name}</Text>
        <Text style={styles.rowMeta}>{meta}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`remove ${name.toLowerCase()}`}
        hitSlop={8}
        onPress={onPress}
        style={({ pressed }) => [styles.apply, pressed && styles.pressed, done && styles.applyDone]}
      >
        <Text style={styles.applyText}>{done ? '✓' : 'cut'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000AA' },
  sheet: {
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panel, padding: space.xxl, gap: space.lg,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  close: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.xl, padding: space.sm },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm },
  rows: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingVertical: space.sm },
  rowText: { flex: 1, gap: 1, minHeight: 44, justifyContent: 'center' },
  rowName: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg },
  rowMeta: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.sm },
  apply: {
    width: 44, height: 44, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center',
  },
  applyDone: { borderColor: colors.success, backgroundColor: colors.successSoft },
  applyText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.md },
  pressed: { opacity: 0.65 },
  note: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm, paddingTop: space.sm },
  hint: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, paddingVertical: space.xl },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.md, paddingVertical: space.xl },
});
