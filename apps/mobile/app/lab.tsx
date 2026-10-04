import { useEffect, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Redirect } from 'expo-router';
import { Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { EditifyEngine, type NativeFingerprint } from '../modules/editify-engine';
import { Button } from '../src/components/Button';
import { Screen } from '../src/components/Screen';
import { RUNS_REQUIRED, THRESHOLDS, type LabRow, type SpikeId } from '../src/lab/evaluate';
import { LAB_ASSET_ID, standupLabPlan, type LabSource } from '../src/lab/standup-plan';
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
/** `localFile`: the picker's own copy of the local clip, used when PhotoKit can't open the PHAsset (see localRef). */
/** `s5Seconds` / `s1Seconds`: how long S5 and S1-on-the-plan play; each spike reads only its own (empty: 20 and 600). */
type Slot = 'local' | 'localFile' | 'icloud' | 'memo' | 'expectedLag' | 's5Seconds' | 's1Seconds';
type Slots = Partial<Record<Slot, string>>;
type Params = Record<string, unknown> | string;

/** Spikes the native module can run so far, with the params each needs. */
/** `params` runs once per variant; a string is why it can't run (shown instead). */
const SPIKES: Array<{ id: SpikeId; label: string; variants?: string[]; params: (slots: Slots, variant: string) => Params | Promise<Params> }> = [
  // The threshold arm runs first; the others are context for where the limit sits.
  { id: 'S1', label: 'Preview fps, 10 min sustained', variants: ['render1080-source', 'render720-source', 'rendernative-source'], params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S1', label: 'Preview fps under analysis load', variants: ['render1080-source-analysis'], params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  // P7 (5B): the finished renderer on the lab's stand-up cut (src/lab/standup-plan.ts).
  { id: 'S1', label: 'Preview fps, stand-up plan (PlanPlayer)', variants: ['render1080-plan'], params: planParams },
  { id: 'S2', label: 'Scrub latency', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  { id: 'S3', label: 'Edit stalls, 50 clips', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  // One button per size: on a simulator HEVC Main10 encodes in software (VCPHEVC), so a 4K HLG run
  // takes ~40 min there and only the phone can judge it.
  { id: 'S4', label: 'Export 4K30 HLG, 60 s stand-up cut (PlanExporter)', variants: ['writer-60s-4k30'], params: planParams },
  { id: 'S4', label: 'Export 1080 SDR, 60 s stand-up cut (PlanExporter)', variants: ['writer-60s-1080'], params: planParams },
  { id: 'S5', label: 'Native preview 1080: ms per frame, match', variants: ['preview1080'], params: planParams },
  { id: 'S6', label: 'Photos refs (local, iCloud, deleted)', params: (s) => (s.local ? { local: s.local, icloud: s.icloud } : 'pick a local clip') },
  { id: 'S10', label: '540p proxy speed', params: (s) => (s.local ? { asset: s.local } : 'pick a local clip') },
  // P2 analyzers. The verdict needs a memo pair with a known lag; without a memo, sync only
  // checks itself against an excerpt of the clip (clip over 90 s) and the row can't pass.
  { id: 'S11', label: 'Analyzers, ready for the AI edit', variants: ['pipeline'], params: analyzerParams },
  { id: 'S11', label: 'Analyzers one by one (timing, memory)', variants: ['sync', 'words', 'laughter', 'energy', 'faces'], params: analyzerParams },
  { id: 'S11', label: 'Scheduler: playback pauses heavy analyzers', variants: ['scheduler'], params: analyzerParams },
  { id: 'S11', label: 'Crop translation frames (Documents/lab)', variants: ['crop'], params: analyzerParams },
];

/**
 * The stand-up cut for the picked clip, built by buildRenderPlan for this variant's size and
 * colour, plus its media map. The clip's geometry and colour come from the engine's probe.
 */
async function planParams(slots: Slots, variant: string): Promise<Params> {
  const local = await localRef(slots);
  if (typeof local === 'string') return local;
  const { ref, fingerprint } = local;
  if (!fingerprint.geometry) return 'the picked clip has no video';
  const source: LabSource = {
    width: fingerprint.geometry.width, height: fingerprint.geometry.height, rotation: fingerprint.geometry.rotation,
    duration: fingerprint.duration, hasAudio: fingerprint.audio !== null, color: fingerprint.color,
  };
  let plan;
  try {
    plan = standupLabPlan(source, variant);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  // Each preview spike has its own duration field, so a short S5 run never shortens S1's window.
  const field = variant === 'preview1080' ? slots.s5Seconds : variant.endsWith('-plan') ? slots.s1Seconds : undefined;
  const seconds = Number(field);
  return {
    plan: JSON.stringify(plan), media: { [LAB_ASSET_ID]: ref }, via: ref.startsWith('file://') ? 'app-copy' : 'photos',
    ...(field?.trim() && Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}),
  };
}

/**
 * The local clip as the engine should open it: the PHAsset id when PhotoKit reads it (the real
 * path), else the picker's app copy (a file:// URI in the app's container, which the export and
 * preview resolvers accept like an imported copy). Seen on a Release simulator build:
 * PHAsset.fetchAssets found nothing for a picked id with full access, so S6 failed too.
 */
async function localRef(slots: Slots): Promise<{ ref: string; fingerprint: NativeFingerprint } | string> {
  if (!slots.local || !EditifyEngine) return 'pick a local clip';
  const probe = await EditifyEngine.probeMedia(slots.local);
  if (probe.status === 'ok') return { ref: slots.local, fingerprint: probe.fingerprint };
  if (slots.localFile) {
    const copy = await EditifyEngine.probeMedia(slots.localFile);
    if (copy.status === 'ok') return { ref: slots.localFile, fingerprint: copy.fingerprint };
  }
  return `the picked clip can't be read here (${probe.status}${'access' in probe ? `, Photos access ${probe.access}` : ''})`;
}

async function analyzerParams(slots: Slots): Promise<Params> {
  const local = await localRef(slots);
  if (typeof local === 'string') return local;
  const asset = local.ref;
  if (!slots.memo) return { asset };
  const expectedLag = Number(slots.expectedLag);
  return Number.isFinite(expectedLag) && slots.expectedLag?.trim() ? { asset, memo: slots.memo, expectedLag } : { asset, memo: slots.memo };
}

export default function LabScreen() {
  const [slots, setSlots] = useState<Slots>({});
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
    const uri = result.assets?.[0]?.uri;
    // assetId is the PHAsset localIdentifier; it is null without full library access.
    // A re-pick replaces the app copy too: without a uri the old clip's copy must not linger.
    if (!id) return;
    setSlots((current) => {
      const next: Slots = { ...current, [slot]: id };
      if (slot === 'local') {
        if (uri) next.localFile = uri;
        else delete next.localFile;
      }
      return next;
    });
  }

  async function runAll(spike: (typeof SPIKES)[number]) {
    setRunning(true);
    try {
      await runVariants(spike);
    } catch (error) {
      setBusy(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  async function runVariants(spike: (typeof SPIKES)[number]) {
    for (const variant of spike.variants ?? [THRESHOLDS[spike.id].variant]) {
      const params = await spike.params(slots, variant);
      if (typeof params === 'string') return setBusy(params);
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
      {/* What the composition root picked (D5): the adapter set a run measured. */}
      <Text style={styles.body}>{JSON.stringify(engine.capabilities?.() ?? engine.exportCapabilities())}</Text>

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
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={slots.s5Seconds ?? ''}
          onChangeText={(text) => setSlots((current) => ({ ...current, s5Seconds: text }))}
          keyboardType="decimal-pad"
          placeholder="S5 seconds (20)"
          placeholderTextColor={colors.muted}
          accessibilityLabel="S5 seconds"
        />
        <TextInput
          style={styles.input}
          value={slots.s1Seconds ?? ''}
          onChangeText={(text) => setSlots((current) => ({ ...current, s1Seconds: text }))}
          keyboardType="decimal-pad"
          placeholder="S1 plan seconds (600)"
          placeholderTextColor={colors.muted}
          accessibilityLabel="S1 plan seconds"
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
