import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AssetMetadata, Clip, Operation } from '@editify/shared';
import { clipTimelineDuration } from '@editify/shared';
import { colors } from '../../lib/theme';
import { formatTimecode } from '../../lib/timeline';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const VOLUME_STEP = 0.1;

interface Props {
  clip: Clip | undefined;
  asset: AssetMetadata | undefined;
  isCaption: boolean;
  onApply: (ops: Operation[], patch: Partial<Clip>) => void;
}

/**
 * Selection strip under the lanes: read-only geometry plus the two properties
 * worth nudging by hand. Both steppers commit a single operation —
 * `set_speed` / `set_volume` — and optimistically patch the clip.
 */
export function Inspector({ clip, asset, isCaption, onApply }: Props) {
  if (!clip) {
    return (
      <View style={styles.bar}>
        <Text style={styles.hint}>Select a clip to inspect it — or ask the agent for an edit.</Text>
      </View>
    );
  }

  const speed = clip.speed ?? 1;
  const volume = clip.volume ?? 1;
  const stepSpeed = (direction: -1 | 1): void => {
    const index = SPEEDS.indexOf(speed);
    const fallback = SPEEDS.findIndex((value) => value > speed);
    const current = index >= 0 ? index : Math.max(0, fallback);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, current + direction))];
    if (next === undefined || next === speed) return;
    onApply([{ type: 'set_speed', params: { clipId: clip.id, speed: next } }], { speed: next });
  };
  const stepVolume = (direction: -1 | 1): void => {
    const next = Math.round(Math.max(0, Math.min(1, volume + direction * VOLUME_STEP)) * 100) / 100;
    if (next === volume) return;
    onApply([{ type: 'set_volume', params: { clipId: clip.id, volume: next } }], { volume: next });
  };

  return (
    <View style={styles.bar}>
      <View style={styles.identity}>
        <Text style={styles.kind}>{isCaption ? 'CAPTION' : 'CLIP'}</Text>
        <Text style={styles.name} numberOfLines={1}>
          {isCaption ? clip.text ?? clip.id : asset?.originalName ?? clip.assetId ?? clip.id}
        </Text>
      </View>
      <Field label="START" value={formatTimecode(clip.start)} />
      <Field label="DURATION" value={`${clipTimelineDuration(clip).toFixed(2)}s`} />
      <Field label="IN / OUT" value={`${clip.in.toFixed(2)} → ${clip.out.toFixed(2)}`} />
      {!isCaption && (
        <>
          <Stepper label="SPEED" value={`${speed}×`} onDown={() => stepSpeed(-1)} onUp={() => stepSpeed(1)} />
          <Stepper label="VOLUME" value={`${Math.round(volume * 100)}%`} onDown={() => stepVolume(-1)} onUp={() => stepVolume(1)} />
        </>
      )}
      {asset && <Field label="SOURCE" value={`${asset.width}×${asset.height} · ${asset.duration.toFixed(1)}s`} />}
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

function Stepper({ label, value, onDown, onUp }: { label: string; value: string; onDown: () => void; onUp: () => void }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable accessibilityRole="button" accessibilityLabel={`decrease ${label}`} onPress={onDown} style={({ pressed }) => [styles.step, pressed && styles.pressed]}>
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text style={styles.stepValue}>{value}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`increase ${label}`} onPress={onUp} style={({ pressed }) => [styles.step, pressed && styles.pressed]}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 40, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16,
    borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, marginTop: 6,
  },
  identity: { minWidth: 140, maxWidth: 240, gap: 2 },
  kind: { color: colors.purple, fontFamily: 'Montserrat_800ExtraBold', fontSize: 7, letterSpacing: 1.2 },
  name: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 11 },
  field: { gap: 3 },
  fieldLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 7, letterSpacing: 1 },
  fieldValue: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 11, fontVariant: ['tabular-nums'] },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  step: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center',
  },
  stepText: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 11, lineHeight: 14 },
  stepValue: { minWidth: 42, textAlign: 'center', color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 11, fontVariant: ['tabular-nums'] },
  hint: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 10 },
  pressed: { opacity: 0.6 },
});
