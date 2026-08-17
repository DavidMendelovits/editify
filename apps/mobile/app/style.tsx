import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AssetMetadata } from '@editify/shared';
import { AssetActionSheet } from '../src/components/AssetActionSheet';
import { Markdown } from '../src/components/editor/Markdown';
import { Brand } from '../src/components/Brand';
import { GradientButton } from '../src/components/GradientButton';
import { Screen } from '../src/components/Screen';
import { api, uploadAsset } from '../src/lib/api';
import { colors } from '../src/lib/theme';

export default function StyleScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const profile = useQuery({
    queryKey: ['style-profile'], queryFn: api.getStyle, retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'processing' ? 1500 : false),
  });
  const analyze = useMutation({
    mutationFn: async () => {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['video/*'], multiple: true, copyToCacheDirectory: true });
      if (picked.canceled) return undefined;
      const uploaded = [];
      for (const asset of picked.assets.slice(0, 10)) {
        uploaded.push(await uploadAsset({ uri: asset.uri, name: asset.name, ...(asset.mimeType ? { mimeType: asset.mimeType } : {}) }));
      }
      return await api.analyzeStyle(uploaded.map((asset) => asset.id));
    },
    // The POST only starts the scan — refetch so the poll above picks it up.
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['style-profile'] }); },
  });
  // Every clip on the server, so a reference can be measured before any project
  // adopts it — dissection is a pre-edit decision, not a timeline action.
  const clips = useQuery({ queryKey: ['library', 'all'], queryFn: () => api.listAssets() });
  const [actionAsset, setActionAsset] = useState<AssetMetadata>();
  const references = (clips.data ?? []).filter((asset) => asset.width > 0 && !asset.mimeType.startsWith('image/'));
  const current = profile.data?.profile;
  // Uploading, or the server still scanning after the 202.
  const busy = analyze.isPending || profile.data?.status === 'processing';
  const failure = analyze.error?.message ?? (profile.data?.status === 'error' ? profile.data.error ?? 'Analysis failed' : undefined);

  return (
    <Screen header={<View style={styles.header}><Pressable onPress={() => router.back()}><Text style={styles.back}>‹  HOME</Text></Pressable><Brand compact /></View>}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>STYLE MEMORY</Text>
        <Text style={styles.title}>Show us your rhythm.</Text>
        <Text style={styles.subtitle}>Upload up to ten past videos. We measure cuts, loudness, framing, and pace with ffmpeg—your footage is never sent to an AI model.</Text>
      </View>
      <View style={styles.uploadCard}>
        <View style={styles.uploadIcon}><Text style={styles.uploadIconText}>↑</Text></View>
        <Text style={styles.uploadTitle}>{busy ? 'Reading the edit language…' : 'Drop in your best past cuts'}</Text>
        <Text style={styles.uploadSubtitle}>{busy ? 'Probing footage, detecting scene changes, and measuring loudness.' : 'MP4, MOV, or WebM · up to 10 videos'}</Text>
        <GradientButton disabled={busy} onPress={() => analyze.mutate()} style={styles.uploadButton}>
          {busy ? 'analyzing…' : current ? 'analyze new videos' : 'choose videos'}
        </GradientButton>
        {busy && <View style={styles.progress}><View style={styles.progressFill} /></View>}
      </View>
      {failure && <Text style={styles.error}>{failure}</Text>}
      {current && (
        <>
          <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Your measurable signature</Text><Text style={styles.count}>{current.metrics.length} VIDEOS</Text></View>
          <View style={styles.metricGrid}>
            <Metric label="AVERAGE SHOT" value={`${average(current.metrics.map((metric) => metric.averageShotLength)).toFixed(1)}s`} detail="scene-change spacing" />
            <Metric label="CUT DENSITY" value={`${average(current.metrics.map((metric) => metric.cutDensity)).toFixed(2)}/s`} detail={`${current.metrics.reduce((sum, metric) => sum + metric.cutCount, 0)} detected cuts`} />
            <Metric label="LOUDNESS" value={loudness(current.metrics.map((metric) => metric.loudnessLufs))} detail="integrated LUFS" />
            <Metric label="PRIMARY FORMAT" value={mode(current.metrics.map((metric) => metric.format))} detail="frame orientation" />
          </View>
          <View style={styles.styleDoc}>
            <Text style={styles.styleDocEyebrow}>EDITIFY'S STYLE BRIEF</Text>
            <Markdown text={current.styleDoc} />
            <Text style={styles.styleFoot}>This brief is injected into every edit conversation.</Text>
          </View>
        </>
      )}
      {references.length > 0 && (
        <>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Your clips</Text>
              <Text style={styles.sectionNote}>Dissect one to measure its rhythm — and to get a preset you can apply in the editor.</Text>
            </View>
            <Text style={styles.count}>{references.length} CLIPS</Text>
          </View>
          <View style={styles.clipList}>
            {references.map((asset) => (
              <Pressable
                key={asset.id}
                onLongPress={() => setActionAsset(asset)}
                accessibilityRole="button"
                accessibilityLabel={`actions for ${asset.label ?? asset.originalName}`}
                style={styles.clipRow}
              >
                <Text style={styles.clipName} numberOfLines={1}>{asset.label ?? asset.originalName}</Text>
                <Text style={styles.clipMeta}>{asset.duration.toFixed(1)}s</Text>
                <Pressable
                  onPress={() => setActionAsset(asset)}
                  accessibilityRole="button"
                  accessibilityLabel={`actions for ${asset.label ?? asset.originalName}`}
                  hitSlop={10}
                  style={({ pressed }) => [styles.clipMore, pressed && styles.clipMorePressed]}
                >
                  <Text style={styles.clipMoreText}>⋯</Text>
                </Pressable>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {actionAsset && <AssetActionSheet asset={actionAsset} onClose={() => setActionAsset(undefined)} />}
    </Screen>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricDetail}>{detail}</Text></View>;
}
function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function loudness(values: Array<number | null>): string { const valid = values.filter((value): value is number => value !== null); return valid.length ? `${average(valid).toFixed(1)}` : 'silent'; }
function mode(values: string[]): string { return values.sort((a, b) => values.filter((v) => v === a).length - values.filter((v) => v === b).length).at(-1) ?? '—'; }

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.4 },
  hero: { paddingVertical: 34, gap: 12, maxWidth: 760 },
  kicker: { color: colors.purple, fontFamily: 'Montserrat_700Bold', fontSize: 11, letterSpacing: 2.2 },
  title: { color: colors.text, fontFamily: 'Montserrat_800ExtraBold', fontSize: 42, lineHeight: 48, letterSpacing: -1.8 },
  subtitle: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 14, lineHeight: 23, maxWidth: 650 },
  uploadCard: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#6D5AC7', borderRadius: 24, backgroundColor: '#181625', minHeight: 270, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 9 },
  uploadIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: '#292342', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  uploadIconText: { color: colors.purple, fontSize: 25 },
  uploadTitle: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 17, textAlign: 'center' },
  uploadSubtitle: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 12, textAlign: 'center' },
  uploadButton: { width: 210, marginTop: 12 },
  progress: { height: 4, width: 210, marginTop: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  progressFill: { width: '68%', height: '100%', backgroundColor: colors.purple },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  sectionTitle: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 21 },
  sectionNote: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 11, marginTop: 4, maxWidth: 520 },
  clipList: { gap: 8 },
  clipRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 14, paddingVertical: 10,
  },
  clipName: { flex: 1, color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  clipMeta: { color: colors.muted, fontFamily: 'Montserrat_500Medium', fontSize: 10, fontVariant: ['tabular-nums'] },
  clipMore: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  clipMorePressed: { opacity: 0.6 },
  clipMoreText: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 15, lineHeight: 17 },
  count: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.4 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metric: { flexGrow: 1, flexBasis: 210, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  metricLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.3 },
  metricValue: { color: colors.text, fontFamily: 'Montserrat_800ExtraBold', fontSize: 28, marginTop: 14 },
  metricDetail: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 11, marginTop: 4 },
  styleDoc: { borderRadius: 22, padding: 24, backgroundColor: '#211A36', borderWidth: 1, borderColor: '#473673', gap: 12 },
  styleDocEyebrow: { color: colors.pink, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5 },
  quote: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 18, lineHeight: 28 },
  styleFoot: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 11 },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 12 },
});
