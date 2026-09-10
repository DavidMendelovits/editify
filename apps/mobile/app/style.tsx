import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AssetMetadata } from '@editify/shared';
import { AssetActionSheet } from '../src/components/AssetActionSheet';
import { Markdown } from '../src/components/editor/Markdown';
import { Brand } from '../src/components/Brand';
import { Button } from '../src/components/Button';
import { Screen } from '../src/components/Screen';
import { api, uploadAsset } from '../src/lib/api';
import { backControlStyle, goBack } from '../src/lib/nav';
import { colors, radius, space, type, fonts } from '../src/lib/theme';

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
        uploaded.push(await uploadAsset({ uri: asset.uri, name: asset.name, ...(asset.mimeType ? { mimeType: asset.mimeType } : {}), ...(asset.file ? { file: asset.file } : {}) }));
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
    <Screen header={<View style={styles.header}><Pressable onPress={() => goBack(router, '/')} accessibilityRole="button" style={backControlStyle}><Text style={styles.back}>‹  HOME</Text></Pressable><Brand compact /></View>}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>STYLE MEMORY</Text>
        <Text style={styles.title}>Show us your rhythm.</Text>
        <Text style={styles.subtitle}>Upload up to ten past videos. We measure cuts, loudness, framing, and pace with ffmpeg. Your footage is never sent to an AI model.</Text>
      </View>
      <View style={styles.uploadCard}>
        <Text style={styles.uploadTitle}>{busy ? 'Reading the edit language…' : 'Drop in your best past cuts'}</Text>
        <Text style={styles.uploadSubtitle}>{busy ? 'Probing footage, detecting scene changes, and measuring loudness.' : 'MP4, MOV, or WebM · up to 10 videos'}</Text>
        <Button disabled={busy} onPress={() => analyze.mutate()} style={styles.uploadButton}>
          {busy ? 'analyzing…' : current ? 'analyze new videos' : 'choose videos'}
        </Button>
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
              <Text style={styles.sectionNote}>Dissect one to measure its rhythm, and to get a preset you can apply in the editor.</Text>
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
function mode(values: string[]): string { return values.sort((a, b) => values.filter((v) => v === a).length - values.filter((v) => v === b).length).at(-1) ?? 'n/a'; }

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.md, letterSpacing: 1.4 },
  hero: { paddingVertical: space.xl, gap: space.md, maxWidth: 760 },
  kicker: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.6 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.display, lineHeight: 34, letterSpacing: -0.8 },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 18, maxWidth: 650 },
  uploadCard: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.panel, minHeight: 200, alignItems: 'center', justifyContent: 'center', padding: space.section, gap: space.lg },
  uploadTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xl, textAlign: 'center' },
  uploadSubtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, textAlign: 'center' },
  uploadButton: { width: 210, marginTop: space.xl },
  progress: { height: 4, width: 210, marginTop: space.lg, borderRadius: radius.md, backgroundColor: colors.border, overflow: 'hidden' },
  progressFill: { width: '68%', height: '100%', backgroundColor: colors.accent },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xl },
  sectionTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  sectionNote: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, marginTop: space.sm, maxWidth: 520 },
  clipList: { gap: space.lg },
  clipRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.xl, minHeight: 40, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: space.xl, paddingVertical: space.lg,
  },
  clipName: { flex: 1, color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg },
  clipMeta: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.md, fontVariant: ['tabular-nums'] },
  clipMore: { width: 28, height: 28, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  clipMorePressed: { opacity: 0.6 },
  clipMoreText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xl, lineHeight: 17 },
  count: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.4 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xl },
  metric: { flexGrow: 1, flexBasis: 180, borderRadius: radius.md, padding: space.xl, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  metricLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.3 },
  metricValue: { color: colors.text, fontFamily: fonts.bold, fontSize: type.title, marginTop: space.md },
  metricDetail: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, marginTop: space.sm },
  styleDoc: { borderRadius: radius.md, padding: space.xxl, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, gap: space.lg },
  styleDocEyebrow: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  quote: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.xxl, lineHeight: 28 },
  styleFoot: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.lg },
});
