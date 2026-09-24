import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Brand } from '../../../src/components/Brand';
import { Button } from '../../../src/components/Button';
import { Screen } from '../../../src/components/Screen';
import { api, IS_LOCAL_API, rebaseServerUrl, type RenderRecord } from '../../../src/lib/api';
import { track } from '../../../src/lib/telemetry';
import { backControlStyle, goBack } from '../../../src/lib/nav';
import { colors, radius, space, type, fonts } from '../../../src/lib/theme';

const resolutions: Array<{ value: RenderRecord['resolution']; label: string }> = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '4k', label: '4K' },
];

/** HDR sources otherwise land in the export at whatever colour ffmpeg guesses. */
const hdrOptions: Array<{ value: 'sdr' | 'hdr'; label: string; detail: string }> = [
  { value: 'sdr', label: 'Convert to SDR (BT.709)', detail: 'Default · matches the preview exactly' },
  { value: 'hdr', label: 'Keep HDR (BT.2020 PQ)', detail: '10-bit master · preview shown is the SDR proof' },
];

export default function ExportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [resolution, setResolution] = useState<RenderRecord['resolution']>('1080p');
  const [hdr, setHdr] = useState<'sdr' | 'hdr'>('sdr');
  const [renderId, setRenderId] = useState<string>();
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.getProject(id) });
  const render = useQuery({
    queryKey: ['render', renderId],
    queryFn: () => api.getRender(renderId as string),
    enabled: Boolean(renderId),
    refetchInterval: (query) => query.state.data?.status === 'done' || query.state.data?.status === 'error' ? false : 1200,
  });
  const start = useMutation({
    mutationFn: () => api.render(id, resolution, hdr),
    onSuccess: (record) => { track('render_started', resolution); setRenderId(record.id); },
  });
  const status = render.data?.status ?? (start.isPending ? 'queued' : undefined);

  useEffect(() => {
    if (status === 'done' || status === 'error') track(`render_${status}`);
  }, [status]);

  return (
    <Screen header={<View style={styles.header}><Pressable onPress={() => goBack(router, `/project/${id}`)} accessibilityRole="button" style={backControlStyle}><Text style={styles.back}>‹  EDITOR</Text></Pressable><Brand compact /></View>}>
      <View style={styles.hero}>
        <Text style={styles.title}>{project.data?.title ?? 'Your project'}</Text>
      </View>
      <View style={styles.previewCard}>
        <View style={styles.previewFrame}><Text style={styles.previewTitle}>{project.data?.format ?? '9:16'} MASTER</Text></View>
        <View style={styles.summary}><Summary label="DURATION" value={formatDuration(project.data?.duration ?? 0)} /><Summary label="FRAME RATE" value={`${project.data?.fps ?? 30} FPS`} /><Summary label="VERSION" value={`V${project.data?.version ?? 0}`} /></View>
      </View>
      <View><Text style={styles.sectionTitle}>Resolution</Text></View>
      <View style={styles.resolutions}>
        {resolutions.map((item) => <Pressable key={item.value} disabled={Boolean(renderId)} onPress={() => setResolution(item.value)} style={[styles.resolution, resolution === item.value && styles.resolutionSelected]}><View style={[styles.radio, resolution === item.value && styles.radioSelected]}>{resolution === item.value && <View style={styles.radioDot} />}</View><Text style={styles.resolutionTitle}>{item.label}</Text></Pressable>)}
      </View>
      <View testID="color-section" style={styles.colorSection}>
        <View><Text style={styles.sectionKicker}>COLOR</Text><Text style={styles.sectionTitle}>HDR &amp; wide gamut</Text></View>
        <View style={styles.resolutions}>
          {hdrOptions.map((item) => <Pressable key={item.value} testID={`hdr-${item.value}`} disabled={Boolean(renderId)} onPress={() => setHdr(item.value)} style={[styles.resolution, hdr === item.value && styles.resolutionSelected]}><View style={[styles.radio, hdr === item.value && styles.radioSelected]}>{hdr === item.value && <View style={styles.radioDot} />}</View><View style={styles.resolutionText}><Text style={styles.resolutionTitle}>{item.label}</Text><Text style={styles.resolutionDetail}>{item.detail}</Text></View></Pressable>)}
        </View>
      </View>
      {!renderId && <Button onPress={() => start.mutate()} disabled={start.isPending || !project.data} style={styles.renderButton}>{start.isPending ? 'joining the queue…' : `render ${resolution} master`}</Button>}
      {status && (
        <View style={[styles.statusCard, status === 'done' && styles.doneCard, status === 'error' && styles.errorCard]}>
          <View style={styles.statusTop}><Text style={styles.statusValue}>{status.toUpperCase()}</Text></View>
          {status !== 'done' && status !== 'error' && <View style={styles.progress}><View style={[styles.progressFill, status === 'processing' && styles.progressProcessing]} /></View>}
          {status === 'done' && render.data?.outputUrl && <Button style={styles.downloadButton} onPress={() => void Linking.openURL(rebaseServerUrl(render.data.outputUrl) as string)}>download / share master ↗</Button>}
          {status === 'error' && <Text style={styles.error}>{render.data?.error}</Text>}
        </View>
      )}
      {(start.error || render.error) && <Text style={styles.error}>{start.error?.message ?? render.error?.message}</Text>}
      <Text style={styles.note}>
        {IS_LOCAL_API
          ? 'Rendering runs on your local Editify server. Keep it running.'
          : 'Rendering runs on the Editify servers. Keep this screen open until it finishes: the download link only appears here.'}
      </Text>
    </Screen>
  );
}

function Summary({ label, value }: { label: string; value: string }) { return <View style={styles.summaryItem}><Text style={styles.summaryLabel}>{label}</Text><Text style={styles.summaryValue}>{value}</Text></View>; }
function formatDuration(seconds: number): string { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.xl },
  back: { flexShrink: 1, color: colors.muted, fontFamily: fonts.mono, fontSize: type.md, letterSpacing: 1.4 },
  hero: { alignItems: 'center', paddingVertical: space.xl, gap: space.md },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.display, lineHeight: 34, letterSpacing: -0.8, textAlign: 'center' },
  previewCard: { maxWidth: 760, width: '100%', alignSelf: 'center', borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  previewFrame: { minHeight: 160, backgroundColor: colors.panelSunken, alignItems: 'center', justifyContent: 'center', gap: space.xl },
  previewTitle: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.md, letterSpacing: 1.5 },
  summary: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-around', gap: space.xl, padding: space.xxl },
  summaryItem: { alignItems: 'center', gap: space.md },
  summaryLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.2 },
  summaryValue: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xl },
  sectionKicker: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5, marginBottom: space.sm },
  sectionTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  colorSection: { gap: space.lg },
  resolutions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  resolution: { flexGrow: 1, flexBasis: 200, minWidth: 0, minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: space.xl, padding: space.xl, borderRadius: radius.md, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  resolutionSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  radio: { flexShrink: 0, width: 16, height: 16, borderRadius: radius.full, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.accent },
  radioDot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.accent },
  resolutionText: { flex: 1, minWidth: 0 },
  resolutionTitle: { flexShrink: 1, color: colors.text, fontFamily: fonts.bold, fontSize: type.xl },
  resolutionDetail: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, marginTop: space.sm },
  renderButton: { maxWidth: 520, width: '100%', alignSelf: 'center', minHeight: 40 },
  statusCard: { maxWidth: 760, width: '100%', alignSelf: 'center', borderRadius: radius.md, padding: space.xxl, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, gap: space.xl },
  doneCard: { borderColor: colors.success, backgroundColor: colors.successSoft },
  errorCard: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  statusTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusValue: { color: colors.text, fontFamily: fonts.bold, fontSize: type.md },
  progress: { height: 6, borderRadius: radius.md, backgroundColor: colors.border, overflow: 'hidden' },
  progressFill: { width: '18%', height: '100%', backgroundColor: colors.accent },
  progressProcessing: { width: '72%' },
  downloadButton: { minHeight: 40 },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.base },
  note: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, textAlign: 'center' },
});
