import { useEffect, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Redirect } from 'expo-router';
import { Share, StyleSheet, Text, TextInput, View } from 'react-native';
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

/**
 * `expectedLag`: seconds, a reference lag for the picked memo pair; empty by default, so a
 * pair without one can't pass the sync gate by accident. Stand-up fixture (IMG_9267 + its
 * memo): 59.424 from the server (ffmpeg + sync.ts, fine stage locked); the macOS harness
 * got 59.43, the coarse cell, because its fine stage didn't lock. Enter 59.424.
 */
type Slot = 'local' | 'icloud' | 'memo' | 'expectedLag';

/** Spikes the native module can run so far, with the params each needs. */
const SPIKES: Array<{ id: SpikeId; label: string; variants?: string[]; params: (slots: Partial<Record<Slot, string>>) => Record<string, unknown> | string }> = [
  // The threshold arm runs first; the others are context for where the limit sits.
  { id: 'S1', label: 'Preview fps, 10 min sustained', variants: ['render1080-source', 'render720-source', 'rendernative-source'], params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S1', label: 'Preview fps under analysis load', variants: ['render1080-source-analysis'], params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S2', label: 'Scrub latency', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S3', label: 'Edit stalls, 50 clips', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S6', label: 'Photos refs (local, iCloud, deleted)', params: (s) => (s.local ? { local: s.local, icloud: s.icloud } : 'pick a local clip') },
  { id: 'S10', label: '540p proxy speed', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  // P2 analyzers. The verdict needs a memo pair with a known lag; without a memo, sync only
  // checks itself against an excerpt of the clip (clip over 90 s) and the row can't pass.
  { id: 'S11', label: 'Analyzers, ready for the AI edit', variants: ['pipeline'], params: analyzerParams },
  { id: 'S11', label: 'Analyzers one by one (timing, memory)', variants: ['sync', 'words', 'laughter', 'energy', 'faces'], params: analyzerParams },
  { id: 'S11', label: 'Scheduler: playback pauses heavy analyzers', variants: ['scheduler'], params: analyzerParams },
  { id: 'S11', label: 'Crop translation frames (Documents/lab)', variants: ['crop'], params: analyzerParams },
];

function analyzerParams(slots: Partial<Record<Slot, string>>): Record<string, unknown> | string {
  if (!slots.local) return 'pick a local clip';
  if (!slots.memo) return { asset: slots.local };
  const expectedLag = Number(slots.expectedLag);
  return Number.isFinite(expectedLag) && slots.expectedLag?.trim() ? { asset: slots.local, memo: slots.memo, expectedLag } : { asset: slots.local, memo: slots.memo };
}

export default function LabScreen() {
  const [slots, setSlots] = useState<Partial<Record<Slot, string>>>({});
  const [rows, setRows] = useState<LabRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!LAB_ENABLED || !EditifyEngine) return;
    // Analyzer progress shares the event; only the running spike's moves the bar.
    const sub = EditifyEngine.addListener('progress', (event) => { if ('spike' in event) setProgress(event.fraction); });
    return () => sub.remove();
  }, []);

  if (!LAB_ENABLED || !EditifyEngine) return <Redirect href="/" />;
  const engine = EditifyEngine;

  async function pickMemo() {
    const picked = await DocumentPicker.getDocumentAsync({ type: ['audio/*', 'video/*'], copyToCacheDirectory: true });
    const uri = picked.assets?.[0]?.uri;
    if (uri) setSlots((current) => ({ ...current, memo: uri }));
  }

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
      <View style={styles.row}>
        <Button secondary onPress={pickMemo}>{slots.memo ? 'Memo ✓' : 'Pick memo (optional)'}</Button>
        <TextInput
          style={styles.input}
          value={slots.expectedLag ?? ''}
          onChangeText={(text) => setSlots((current) => ({ ...current, expectedLag: text }))}
          keyboardType="decimal-pad"
          placeholder="Expected lag (s), stand-up: 59.424"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Expected memo lag in seconds"
        />
      </View>

      {SPIKES.map((spike) => (
        <Button key={`${spike.id} ${spike.label}`} disabled={running} onPress={() => runAll(spike)}>
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
  input: { flex: 1, color: colors.text, fontFamily: fonts.mono, fontSize: type.base, borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: space.md },
  mono: { color: colors.text, fontFamily: fonts.mono, fontSize: type.sm, marginTop: space.md },
});
