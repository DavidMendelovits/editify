import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Brand } from '../src/components/Brand';
import { GradientButton } from '../src/components/GradientButton';
import { Screen } from '../src/components/Screen';
import { api, uploadAsset } from '../src/lib/api';
import { colors } from '../src/lib/theme';

export default function StyleScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const profile = useQuery({ queryKey: ['style-profile'], queryFn: api.getStyle, retry: false });
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
    onSuccess: async (result) => {
      if (result) client.setQueryData(['style-profile'], result);
    },
  });
  const current = analyze.data ?? profile.data;

  return (
    <Screen header={<View style={styles.header}><Pressable onPress={() => router.back()}><Text style={styles.back}>‹  HOME</Text></Pressable><Brand compact /></View>}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>STYLE MEMORY</Text>
        <Text style={styles.title}>Show us your rhythm.</Text>
        <Text style={styles.subtitle}>Upload up to ten past videos. We measure cuts, loudness, framing, and pace with ffmpeg—your footage is never sent to an AI model.</Text>
      </View>
      <View style={styles.uploadCard}>
        <View style={styles.uploadIcon}><Text style={styles.uploadIconText}>↑</Text></View>
        <Text style={styles.uploadTitle}>{analyze.isPending ? 'Reading the edit language…' : 'Drop in your best past cuts'}</Text>
        <Text style={styles.uploadSubtitle}>{analyze.isPending ? 'Probing footage, detecting scene changes, and measuring loudness.' : 'MP4, MOV, or WebM · up to 10 videos'}</Text>
        <GradientButton disabled={analyze.isPending} onPress={() => analyze.mutate()} style={styles.uploadButton}>
          {analyze.isPending ? 'analyzing…' : current ? 'analyze new videos' : 'choose videos'}
        </GradientButton>
        {analyze.isPending && <View style={styles.progress}><View style={styles.progressFill} /></View>}
      </View>
      {analyze.error && <Text style={styles.error}>{analyze.error.message}</Text>}
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
            <Text style={styles.quote}>“{current.styleDoc}”</Text>
            <Text style={styles.styleFoot}>This brief is injected into every edit conversation.</Text>
          </View>
        </>
      )}
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
