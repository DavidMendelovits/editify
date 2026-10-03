import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Brand } from '../../../src/components/Brand';
import { Button } from '../../../src/components/Button';
import { Screen } from '../../../src/components/Screen';
import { EditifyEngine } from '../../../modules/editify-engine';
import { api, IS_LOCAL_API, rebaseServerUrl, type RenderRecord } from '../../../src/lib/api';
import {
  buildExportPlan, exportOnDevice, exportStateLabel, isTerminal, missingClipsLine, routeExport,
  type DeviceExportView, type ExportChoices, type ExportRoute,
} from '../../../src/lib/device-export';
import { useEngineActivity } from '../../../src/lib/engine-activity';
import { localMedia } from '../../../src/lib/local-media-native';
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
  { value: 'hdr', label: 'Keep HDR (BT.2020)', detail: '10-bit master · preview shown is the SDR proof' },
];

/** Platforms play everything at about -16 LUFS; a quiet phone recording otherwise exports quiet. */
const loudnessOptions: Array<{ value: 'normalize' | 'off'; label: string; detail: string }> = [
  { value: 'normalize', label: 'Normalize to -16 LUFS', detail: 'Default · one gain stage and a limiter, balance kept' },
  { value: 'off', label: 'Keep mix levels', detail: 'Exports the mix exactly as it plays in the editor' },
];

export default function ExportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [resolution, setResolution] = useState<RenderRecord['resolution']>('1080p');
  const [hdr, setHdr] = useState<'sdr' | 'hdr'>('sdr');
  const [loudness, setLoudness] = useState<'normalize' | 'off'>('normalize');
  const [renderId, setRenderId] = useState<string>();
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.getProject(id) });
  const render = useQuery({
    queryKey: ['render', renderId],
    queryFn: () => api.getRender(renderId as string),
    enabled: Boolean(renderId),
    refetchInterval: (query) => query.state.data?.status === 'done' || query.state.data?.status === 'error' ? false : 1200,
  });
  const start = useMutation({
    mutationFn: () => api.render(id, resolution, hdr, loudness),
    onSuccess: (record) => { track('render_started', resolution); setRenderId(record.id); },
  });
  const status = render.data?.status ?? (start.isPending ? 'queued' : undefined);

  // On-device export (plan P4): when every clip of the plan is on this iPhone it renders
  // here; otherwise the server path above runs as before, with a line naming the clips.
  // TODO(T8): send the server a snapshot of this plan and check it has every original first.
  const engine = EditifyEngine;
  const choices: ExportChoices = { resolution, hdr, loudness };
  const assets = useQuery({ queryKey: ['assets', id], queryFn: () => api.listAssets(id), enabled: Boolean(engine) });
  const nameOf = (assetId: string): string => {
    const asset = assets.data?.find((item) => item.id === assetId);
    return asset ? `"${asset.label ?? asset.originalName}"` : 'a clip';
  };
  const route = useQuery({
    queryKey: ['export-route', id, project.data?.version, assets.dataUpdatedAt],
    enabled: Boolean(engine && project.data && assets.data),
    queryFn: async (): Promise<ExportRoute> => {
      const plan = buildExportPlan(project.data!, assets.data!, choices);
      return await routeExport(plan, await localMedia(), nameOf);
    },
  });
  const [device, setDevice] = useState<DeviceExportView>();
  const [serverNote, setServerNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const deviceBusy = Boolean(device && !isTerminal(device.state));
  // The phone does the work: proxies and analyzers get out of the way for the whole run.
  useEngineActivity('export', deviceBusy);
  useEffect(() => () => abort.current?.abort(), []);

  const exportHere = async (): Promise<void> => {
    const deps = await localMedia();
    const plan = project.data && assets.data ? buildExportPlan(project.data, assets.data, choices) : null;
    if (!engine || !deps || !plan) { start.mutate(); return; }
    const controller = new AbortController();
    abort.current = controller;
    track('device_export_started', resolution);
    const outcome = await exportOnDevice({ plan, deps, native: engine, nameOf, onUpdate: setDevice, signal: controller.signal });
    if (outcome.kind === 'server') {
      // A clip went missing since the screen opened: the server renders it.
      setDevice(undefined);
      setServerNote(missingClipsLine(outcome.route));
      start.mutate();
      return;
    }
    track(`device_export_${outcome.view.state}`, outcome.view.stats ? `${outcome.view.stats.xRealtime}x` : undefined);
  };
  const onRender = (): void => {
    if (route.data?.kind === 'device') { void exportHere(); return; }
    setServerNote(route.data ? missingClipsLine(route.data) : null);
    start.mutate();
  };
  const locked = Boolean(renderId) || deviceBusy;
  const routeLine = route.data?.kind === 'device' ? 'Exports on this iPhone.' : route.data ? missingClipsLine(route.data) : null;

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
        {resolutions.map((item) => <Pressable key={item.value} disabled={locked} onPress={() => setResolution(item.value)} style={[styles.resolution, resolution === item.value && styles.resolutionSelected]}><View style={[styles.radio, resolution === item.value && styles.radioSelected]}>{resolution === item.value && <View style={styles.radioDot} />}</View><Text style={styles.resolutionTitle}>{item.label}</Text></Pressable>)}
      </View>
      <View testID="color-section" style={styles.colorSection}>
        <View><Text style={styles.sectionKicker}>COLOR</Text><Text style={styles.sectionTitle}>HDR &amp; wide gamut</Text></View>
        <View style={styles.resolutions}>
          {hdrOptions.map((item) => <Pressable key={item.value} testID={`hdr-${item.value}`} disabled={locked} onPress={() => setHdr(item.value)} style={[styles.resolution, hdr === item.value && styles.resolutionSelected]}><View style={[styles.radio, hdr === item.value && styles.radioSelected]}>{hdr === item.value && <View style={styles.radioDot} />}</View><View style={styles.resolutionText}><Text style={styles.resolutionTitle}>{item.label}</Text><Text style={styles.resolutionDetail}>{item.detail}</Text></View></Pressable>)}
        </View>
      </View>
      <View testID="loudness-section" style={styles.colorSection}>
        <View><Text style={styles.sectionKicker}>AUDIO</Text><Text style={styles.sectionTitle}>Loudness</Text></View>
        <View style={styles.resolutions}>
          {loudnessOptions.map((item) => <Pressable key={item.value} testID={`loudness-${item.value}`} disabled={locked} onPress={() => setLoudness(item.value)} style={[styles.resolution, loudness === item.value && styles.resolutionSelected]}><View style={[styles.radio, loudness === item.value && styles.radioSelected]}>{loudness === item.value && <View style={styles.radioDot} />}</View><View style={styles.resolutionText}><Text style={styles.resolutionTitle}>{item.label}</Text><Text style={styles.resolutionDetail}>{item.detail}</Text></View></Pressable>)}
        </View>
      </View>
      {!renderId && !device && <Button onPress={onRender} disabled={start.isPending || !project.data || (Boolean(engine) && route.isLoading)} style={styles.renderButton}>{start.isPending ? 'joining the queue…' : `render ${resolution} master`}</Button>}
      {!renderId && !device && (serverNote ?? routeLine) && <Text testID="export-route" style={styles.note}>{serverNote ?? routeLine}</Text>}
      {device && <DeviceExportCard view={device} onCancel={() => abort.current?.abort()} onRetry={() => setDevice(undefined)} />}
      {renderId && serverNote && <Text style={styles.note}>{serverNote}</Text>}
      {status && (
        <View style={[styles.statusCard, status === 'done' && styles.doneCard, status === 'error' && styles.errorCard]}>
          <View style={styles.statusTop}><Text style={styles.statusValue}>{status.toUpperCase()}</Text></View>
          {status !== 'done' && status !== 'error' && <View style={styles.progress}><View style={[styles.progressFill, status === 'processing' && styles.progressProcessing]} /></View>}
          {status === 'done' && render.data?.outputUrl && <Button style={styles.downloadButton} onPress={() => void Linking.openURL(rebaseServerUrl(render.data.outputUrl) as string)}>download / share master ↗</Button>}
          {status === 'done' && render.data?.qa && <QaReport qa={render.data.qa} contactSheetUrl={render.data.contactSheetUrl} format={project.data?.format ?? '9:16'} />}
          {status === 'error' && <Text style={styles.error}>{render.data?.error}</Text>}
        </View>
      )}
      {(start.error || render.error) && <Text style={styles.error}>{start.error?.message ?? render.error?.message}</Text>}
      {!device && route.data?.kind !== 'device' && <Text style={styles.note}>
        {IS_LOCAL_API
          ? 'Rendering runs on your local Editify server. Keep it running.'
          : 'Rendering runs on the Editify servers. Keep this screen open until it finishes: the download link only appears here.'}
      </Text>}
    </Screen>
  );
}

/** The on-device export's progress, result and controls. */
function DeviceExportCard({ view, onCancel, onRetry }: { view: DeviceExportView; onCancel: () => void; onRetry: () => void }) {
  const running = !isTerminal(view.state);
  const stats = view.stats;
  return (
    <View testID="device-export" style={[styles.statusCard, view.state === 'done' && styles.doneCard, view.state === 'failed' && styles.errorCard]}>
      <View style={styles.statusTop}><Text style={styles.statusValue}>{exportStateLabel(view).toUpperCase()}</Text></View>
      {running && <View style={styles.progress}><View style={[styles.progressFill, { width: `${Math.round(Math.max(0.03, view.progress) * 100)}%` }]} /></View>}
      {running && view.notice && <Text style={styles.qaDetail}>{view.notice}</Text>}
      {running && <Button secondary style={styles.downloadButton} onPress={onCancel}>cancel</Button>}
      {view.state === 'done' && view.fileUri && <Button style={styles.downloadButton} onPress={() => void Share.share({ url: view.fileUri as string }).catch(() => undefined)}>share video</Button>}
      {view.state === 'done' && stats && (
        <Text style={styles.qaLine}>{`${stats.lufsOut === null ? 'SILENT' : `${stats.lufsOut.toFixed(1)} LUFS`}${stats.truePeak === null ? '' : ` · PEAK ${stats.truePeak.toFixed(1)} dBTP`} · ${stats.xRealtime.toFixed(1)}x REALTIME`}</Text>
      )}
      {view.state === 'failed' && <Text style={styles.error}>{view.error}</Text>}
      {(view.state === 'failed' || view.state === 'cancelled') && <Button secondary style={styles.downloadButton} onPress={onRetry}>try again</Button>}
    </View>
  );
}

/** The server tiles 6x3 frames of 180x320, 240x240 or 320x180. */
const CONTACT_SHEET_ASPECT: Record<string, number> = { '9:16': 1080 / 960, '1:1': 2, '16:9': 1920 / 540 };

function QaReport({ qa, contactSheetUrl, format }: { qa: NonNullable<RenderRecord['qa']>; contactSheetUrl: string | undefined; format: string }) {
  const loudness = qa.loudnessLufs === null ? 'SILENT' : `${qa.loudnessLufs.toFixed(1)} LUFS`;
  const peak = qa.truePeakDb === null ? '' : ` · PEAK ${qa.truePeakDb.toFixed(1)} dBFS`;
  return (
    <View testID="render-qa" style={styles.qa}>
      <Text style={styles.qaLine}>{`${loudness}${peak}`}</Text>
      {qa.normalized && <Text style={styles.qaDetail}>{`Raised ${qa.normalized.gainDb.toFixed(1)} dB from ${qa.normalized.fromLufs.toFixed(1)} LUFS`}</Text>}
      {qa.warnings.length === 0
        ? <Text style={styles.qaDetail}>No problems found: levels on target, no dead air.</Text>
        : qa.warnings.map((warning) => <Text key={warning} style={styles.qaWarning}>{`• ${warning}`}</Text>)}
      {contactSheetUrl && <Image accessibilityLabel="frames from the master" source={{ uri: rebaseServerUrl(contactSheetUrl) as string }} style={[styles.contactSheet, { aspectRatio: CONTACT_SHEET_ASPECT[format] ?? 2 }]} resizeMode="contain" />}
    </View>
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
  qa: { gap: space.md },
  qaLine: { color: colors.text, fontFamily: fonts.mono, fontSize: type.md, letterSpacing: 1.2 },
  qaDetail: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md },
  qaWarning: { color: colors.text, fontFamily: fonts.regular, fontSize: type.md },
  contactSheet: { width: '100%', borderRadius: radius.sm, backgroundColor: colors.panelSunken },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.base },
  note: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, textAlign: 'center' },
});
