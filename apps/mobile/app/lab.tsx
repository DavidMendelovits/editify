import { useEffect, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Redirect } from 'expo-router';
import { Share, StyleSheet, Text, View } from 'react-native';
import { EditifyEngine } from '../modules/editify-engine';
import { Button } from '../src/components/Button';
import { Screen } from '../src/components/Screen';
import { RUNS_REQUIRED, THRESHOLDS, type LabRow, type SpikeId } from '../src/lab/evaluate';
import { colors, fonts, space, type } from '../src/lib/theme';

/**
 * Capability lab (plan: idempotent-beaming-puppy). Only exists in builds made with
 * EXPO_PUBLIC_LAB=1, which must be Release builds for decision-grade numbers.
 * Not __DEV__: that is false in Release, exactly where the lab has to run.
 */
const LAB_ENABLED = process.env.EXPO_PUBLIC_LAB === '1' && EditifyEngine !== null;

type Slot = 'local' | 'icloud';

/** Spikes the native module can run so far, with the params each needs. */
const SPIKES: Array<{ id: SpikeId; label: string; variants?: string[]; params: (slots: Partial<Record<Slot, string>>) => Record<string, unknown> | string }> = [
  // The threshold arm runs first; the others are context for where the limit sits.
  { id: 'S1', label: 'Preview fps, 10 min sustained', variants: ['render1080-source', 'render720-source', 'rendernative-source'], params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S2', label: 'Scrub latency', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S3', label: 'Edit stalls, 50 clips', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S6', label: 'Photos refs (local, iCloud, deleted)', params: (s) => (s.local ? { local: s.local, icloud: s.icloud } : 'pick a local clip') },
  { id: 'S10', label: '540p proxy speed', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
];

export default function LabScreen() {
  const [slots, setSlots] = useState<Partial<Record<Slot, string>>>({});
  const [rows, setRows] = useState<LabRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!LAB_ENABLED || !EditifyEngine) return;
    const sub = EditifyEngine.addListener('progress', (event) => setProgress(event.fraction));
    return () => sub.remove();
  }, []);

  if (!LAB_ENABLED || !EditifyEngine) return <Redirect href="/" />;
  const engine = EditifyEngine;

  async function pick(slot: Slot) {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], allowsMultipleSelection: false });
    const id = result.assets?.[0]?.assetId;
    // assetId is the PHAsset localIdentifier; it is null without full library access.
    if (id) setSlots((current) => ({ ...current, [slot]: id }));
  }

  async function runAll(spike: (typeof SPIKES)[number]) {
    const params = spike.params(slots);
    if (typeof params === 'string') return setBusy(params);
    setRunning(true);
    try {
      await runVariants(spike, params);
    } finally {
      setRunning(false);
    }
  }

  async function runVariants(spike: (typeof SPIKES)[number], params: Record<string, unknown>) {
    for (const variant of spike.variants ?? [THRESHOLDS[spike.id].variant]) {
      for (let run = 1; run <= RUNS_REQUIRED; run += 1) {
        setBusy(`${spike.id} ${variant} run ${run}/${RUNS_REQUIRED}`);
        setProgress(0);
        const row = await engine.runSpike(spike.id, variant, run, params);
        setRows((current) => [row, ...current]);
        if (row.status === 'refused') return setBusy(row.note ?? 'refused');
      }
    }
    setBusy(null);
  }

  return (
    <Screen>
      <Text style={styles.title}>Capability lab</Text>
      <Text style={styles.body}>Release build, cool phone, battery over 50%, Low Power off. Each spike runs {RUNS_REQUIRED} times.</Text>

      <View style={styles.row}>
        <Button secondary onPress={() => pick('local')}>{slots.local ? 'Local clip ✓' : 'Pick local clip'}</Button>
        <Button secondary onPress={() => pick('icloud')}>{slots.icloud ? 'iCloud clip ✓' : 'Pick iCloud clip'}</Button>
      </View>

      {SPIKES.map((spike) => (
        <Button key={spike.id} disabled={running} onPress={() => runAll(spike)}>
          {`${spike.id} · ${spike.label}`}
        </Button>
      ))}

      {busy ? <Text style={styles.body}>{busy} {progress > 0 ? `${Math.round(progress * 100)}%` : ''}</Text> : null}

      <View style={styles.row}>
        <Button secondary onPress={() => Share.share({ url: engine.resultsPath() })}>Export results</Button>
      </View>

      {rows.map((row, index) => (
        <Text key={index} style={styles.mono}>
          {`${row.spike} #${row.run} ${row.status}${row.note ? ` (${row.note})` : ''}\n${JSON.stringify(row.metrics ?? {})}`}
        </Text>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontFamily: fonts.display, fontSize: type.title, marginBottom: space.lg },
  body: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, marginBottom: space.lg },
  row: { flexDirection: 'row', gap: space.md, marginBottom: space.lg },
  mono: { color: colors.text, fontFamily: fonts.mono, fontSize: type.sm, marginTop: space.md },
});
