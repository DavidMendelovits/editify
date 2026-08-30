import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Brand } from '../../../src/components/Brand';
import { GradientButton } from '../../../src/components/GradientButton';
import { Screen } from '../../../src/components/Screen';
import { api, rebaseServerUrl, type RenderRecord } from '../../../src/lib/api';
import { track } from '../../../src/lib/telemetry';
import { colors } from '../../../src/lib/theme';

const resolutions: Array<{ value: RenderRecord['resolution']; label: string; detail: string }> = [
  { value: '720p', label: '720p', detail: 'Fast · social draft' },
  { value: '1080p', label: '1080p', detail: 'Recommended · crisp HD' },
  { value: '4k', label: '4K', detail: 'Maximum · master file' },
];

export default function ExportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [resolution, setResolution] = useState<RenderRecord['resolution']>('1080p');
  const [renderId, setRenderId] = useState<string>();
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.getProject(id) });
  const render = useQuery({
    queryKey: ['render', renderId],
    queryFn: () => api.getRender(renderId as string),
    enabled: Boolean(renderId),
    refetchInterval: (query) => query.state.data?.status === 'done' || query.state.data?.status === 'error' ? false : 1200,
  });
  const start = useMutation({
    mutationFn: () => api.render(id, resolution),
    onSuccess: (record) => { track('render_started', resolution); setRenderId(record.id); },
  });
  const status = render.data?.status ?? (start.isPending ? 'queued' : undefined);

  useEffect(() => {
    if (status === 'done' || status === 'error') track(`render_${status}`);
  }, [status]);

  return (
    <Screen header={<View style={styles.header}><Pressable onPress={() => router.back()}><Text style={styles.back}>‹  EDITOR</Text></Pressable><Brand compact /></View>}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>FINAL FRAME</Text>
        <Text style={styles.title}>Ready to ship the cut?</Text>
        <Text style={styles.subtitle}>{project.data?.title ?? 'Your project'} · {project.data?.format ?? '—'} · {formatDuration(project.data?.duration ?? 0)}</Text>
      </View>
      <View style={styles.previewCard}>
        <View style={styles.previewFrame}><Text style={styles.previewIcon}>▶</Text><Text style={styles.previewTitle}>{project.data?.format ?? '9:16'} MASTER</Text></View>
        <View style={styles.summary}><Summary label="DURATION" value={formatDuration(project.data?.duration ?? 0)} /><Summary label="FRAME RATE" value={`${project.data?.fps ?? 30} FPS`} /><Summary label="VERSION" value={`V${project.data?.version ?? 0}`} /></View>
      </View>
      <View><Text style={styles.sectionKicker}>OUTPUT QUALITY</Text><Text style={styles.sectionTitle}>Choose a resolution</Text></View>
      <View style={styles.resolutions}>
        {resolutions.map((item) => <Pressable key={item.value} disabled={Boolean(renderId)} onPress={() => setResolution(item.value)} style={[styles.resolution, resolution === item.value && styles.resolutionSelected]}><View style={[styles.radio, resolution === item.value && styles.radioSelected]}>{resolution === item.value && <View style={styles.radioDot} />}</View><View><Text style={styles.resolutionTitle}>{item.label}</Text><Text style={styles.resolutionDetail}>{item.detail}</Text></View></Pressable>)}
      </View>
      {!renderId && <GradientButton onPress={() => start.mutate()} disabled={start.isPending || !project.data} style={styles.renderButton}>{start.isPending ? 'joining the queue…' : `render ${resolution} master`}</GradientButton>}
      {status && (
        <View style={[styles.statusCard, status === 'done' && styles.doneCard, status === 'error' && styles.errorCard]}>
          <View style={styles.statusTop}><Text style={styles.statusLabel}>{status === 'done' ? 'EXPORT COMPLETE' : status === 'error' ? 'RENDER STOPPED' : 'FFMPEG IS ASSEMBLING YOUR TIMELINE'}</Text><Text style={styles.statusValue}>{status.toUpperCase()}</Text></View>
          {status !== 'done' && status !== 'error' && <><View style={styles.progress}><View style={[styles.progressFill, status === 'processing' && styles.progressProcessing]} /></View><Text style={styles.statusDetail}>Cuts, transforms, speed, volume, captions, and final scaling are being rendered at full resolution.</Text></>}
          {status === 'done' && render.data?.outputUrl && <GradientButton style={styles.downloadButton} onPress={() => void Linking.openURL(rebaseServerUrl(render.data.outputUrl) as string)}>download / share master ↗</GradientButton>}
          {status === 'error' && <Text style={styles.error}>{render.data?.error}</Text>}
        </View>
      )}
      {(start.error || render.error) && <Text style={styles.error}>{start.error?.message ?? render.error?.message}</Text>}
      <Text style={styles.note}>Rendering happens on your local Editify server. Keep it running until the master is complete.</Text>
    </Screen>
  );
}

function Summary({ label, value }: { label: string; value: string }) { return <View style={styles.summaryItem}><Text style={styles.summaryLabel}>{label}</Text><Text style={styles.summaryValue}>{value}</Text></View>; }
function formatDuration(seconds: number): string { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.4 },
  hero: { alignItems: 'center', paddingVertical: 34, gap: 10 },
  kicker: { color: colors.purple, fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 2.1 },
  title: { color: colors.text, fontFamily: 'Montserrat_800ExtraBold', fontSize: 40, lineHeight: 47, letterSpacing: -1.7, textAlign: 'center' },
  subtitle: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 13 },
  previewCard: { maxWidth: 760, width: '100%', alignSelf: 'center', borderRadius: 24, overflow: 'hidden', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  previewFrame: { minHeight: 220, backgroundColor: '#07070A', alignItems: 'center', justifyContent: 'center', gap: 12 },
  previewIcon: { color: colors.purple, fontSize: 32 },
  previewTitle: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.5 },
  summary: { flexDirection: 'row', justifyContent: 'space-around', padding: 18 },
  summaryItem: { alignItems: 'center', gap: 6 },
  summaryLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1.2 },
  summaryValue: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 14 },
  sectionKicker: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5, marginBottom: 5 },
  sectionTitle: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 22 },
  resolutions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  resolution: { flexGrow: 1, flexBasis: 210, minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 17, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  resolutionSelected: { borderColor: colors.purple, backgroundColor: '#211A36' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.purple },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.purple },
  resolutionTitle: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 14 },
  resolutionDetail: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 10, marginTop: 4 },
  renderButton: { maxWidth: 520, width: '100%', alignSelf: 'center', minHeight: 54 },
  statusCard: { maxWidth: 760, width: '100%', alignSelf: 'center', borderRadius: 20, padding: 20, backgroundColor: '#201A31', borderWidth: 1, borderColor: '#493B70', gap: 14 },
  doneCard: { borderColor: '#246343', backgroundColor: '#14281F' },
  errorCard: { borderColor: '#6B2936', backgroundColor: '#2A171C' },
  statusTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusLabel: { flex: 1, color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.1 },
  statusValue: { color: colors.text, fontFamily: 'Montserrat_800ExtraBold', fontSize: 10 },
  progress: { height: 6, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  progressFill: { width: '18%', height: '100%', backgroundColor: colors.purple },
  progressProcessing: { width: '72%' },
  statusDetail: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 11, lineHeight: 18 },
  downloadButton: { minHeight: 48 },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 11 },
  note: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 10, textAlign: 'center' },
});
