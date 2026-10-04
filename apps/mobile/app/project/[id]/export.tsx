import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Linking, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Brand } from '../../../src/components/Brand';
import { Button } from '../../../src/components/Button';
import { Screen } from '../../../src/components/Screen';
import { EditifyEngine } from '../../../modules/editify-engine';
import { renderSnapshot, type RenderSnapshot } from '@editify/shared';
import { api, ApiError, IS_LOCAL_API, rebaseServerUrl, uploadOriginal, type RenderRecord } from '../../../src/lib/api';
import {
  buildExportPlan, canFinishOnServer, exportOnDevice, exportStateLabel, finishOnServerOnce, isTerminal, projectAssetRefs, routeExport,
  serverRenderable, serverRouteLine, STARTING, uploadMissing,
  type DeviceExportView, type ExportChoices, type ExportRoute, type ServerCheck, type UploadClip, type UploadOriginal,
} from '../../../src/lib/device-export';
import { describeImport, type ImportProgress } from '../../../src/lib/upload-progress';
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
    mutationFn: (snapshot?: RenderSnapshot) => api.render(id, resolution, hdr, loudness, snapshot),
    onSuccess: (record) => { track('render_started', resolution); setRenderId(record.id); },
  });
  const [finishing, setFinishing] = useState(false);
  const status = render.data?.status ?? (start.isPending ? 'queued' : undefined);

  // On-device export (plan P4): at 720p and 1080p, when every clip of the plan is on this
  // iPhone, it renders here. Otherwise (OV1) the server is asked which originals it holds:
  // all there renders this screen's document as a snapshot; missing ones this iPhone has
  // are offered as "Upload X to export"; missing everywhere is named plainly. Without the
  // engine (web) the server renders its own copy, as before.
  const engine = EditifyEngine;
  const choices: ExportChoices = { resolution, hdr, loudness };
  const assets = useQuery({ queryKey: ['assets', id], queryFn: () => api.listAssets(id), enabled: Boolean(engine) });
  const nameOf = (assetId: string): string => {
    const asset = assets.data?.find((item) => item.id === assetId);
    return asset ? `"${asset.label ?? asset.originalName}"` : 'a clip';
  };
  const serverCheck = (): ServerCheck | undefined => (project.data && assets.data
    ? { refs: projectAssetRefs(project.data, assets.data), check: async (ids) => await api.assetAvailability(id, ids) }
    : undefined);
  const route = useQuery({
    queryKey: ['export-route', id, project.data?.version, assets.dataUpdatedAt, resolution],
    enabled: Boolean(engine && project.data && assets.data),
    queryFn: async (): Promise<ExportRoute> => {
      const plan = buildExportPlan(project.data!, assets.data!, choices);
      return await routeExport(plan, await localMedia(), nameOf, resolution, serverCheck());
    },
  });
  const [uploading, setUploading] = useState<ImportProgress>();
  const [serverError, setServerError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceExportView>();
  const [serverNote, setServerNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** Set synchronously on the first tap: a second tap before React re-renders does nothing. */
  const busy = useRef(false);
  const deviceBusy = Boolean(device && !isTerminal(device.state));
  // The phone does the work: proxies and analyzers get out of the way for the whole run.
  useEngineActivity('export', deviceBusy);
  useEffect(() => () => abort.current?.abort(), []);

  // A foreground export can't outlive this screen: leaving asks, and stopping cancels cleanly.
  // usePreventRemove also holds the native stack's swipe-back gesture while it runs.
  const navigation = useNavigation();
  usePreventRemove(deviceBusy, ({ data }) => {
    Alert.alert('Leaving stops the export', 'Editify renders on this iPhone while this screen is open.', [
      { text: 'Keep exporting', style: 'cancel' },
      { text: 'Stop and leave', style: 'destructive', onPress: () => { abort.current?.abort(); navigation.dispatch(data.action); } },
    ]);
  });
  // Uploading clips for a server render: leaving cancels the transfer, so ask first too.
  usePreventRemove(Boolean(uploading), ({ data }) => {
    Alert.alert('Leaving stops the upload', 'The clips upload while this screen is open.', [
      { text: 'Keep uploading', style: 'cancel' },
      { text: 'Stop and leave', style: 'destructive', onPress: () => { abort.current?.abort(); navigation.dispatch(data.action); } },
    ]);
  });

  const renderOnServer = (note: string | null): void => {
    setServerNote(note);
    // With the engine the server renders this screen's document, not its own copy (OV1).
    let snapshot: RenderSnapshot | undefined;
    try {
      snapshot = engine && project.data ? renderSnapshot(project.data) : undefined;
    } catch (error) {
      busy.current = false;
      setServerError(`This project can't be sent for rendering: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    start.mutate(snapshot, {
      onSettled: () => { busy.current = false; },
      onError: (error) => {
        // The check couldn't run earlier (offline) and the server found originals missing or
        // absent: route again, which offers the upload (or names what can't be) instead of an error.
        if (error instanceof ApiError && error.status === 409 && (error.code === 'missing' || error.code === 'absent')) {
          start.reset();
          setServerNote(null);
          void route.refetch();
        }
      },
    });
  };
  const sendOriginal: UploadOriginal = async (file, onBytes, signal) => {
    // The registry's file name and type; the server's record only when the name says nothing.
    const mimeType = file.mimeType ?? assets.data?.find((item) => item.id === file.assetId)?.mimeType;
    await uploadOriginal(file.assetId, id, { uri: file.uri, name: file.name, ...(mimeType ? { mimeType } : {}) }, onBytes, signal);
  };
  /** Uploads only the clips the server is missing, then routes again: ready renders at once. */
  const uploadThenRender = async (clips: UploadClip[]): Promise<void> => {
    const deps = await localMedia();
    if (!deps) { busy.current = false; return; }
    const controller = new AbortController();
    abort.current = controller;
    setServerError(null);
    setUploading({ done: 0, total: clips.length, sentBytes: 0, totalBytes: 0 });
    track('export_upload_started', String(clips.length));
    try {
      const result = await uploadMissing({ clips, deps, upload: sendOriginal, onProgress: setUploading, signal: controller.signal });
      if (controller.signal.aborted) {
        setServerError('Upload cancelled.');
      } else if (result.failed.length > 0) {
        const first = result.failed[0]!;
        setServerError(`Couldn't upload ${first.name}: ${first.error}`);
      }
      const next = await route.refetch();
      if (result.failed.length === 0 && next.data && serverRenderable(next.data)) {
        renderOnServer(null);
        return;
      }
    } finally {
      if (abort.current === controller) abort.current = null;
      setUploading(undefined);
    }
    busy.current = false;
  };
  // Finish on server (D26): a device export stopped by backgrounding goes to the server in one
  // tap, with the project as it is now. finishOnServerOnce makes repeat taps join one render.
  const finishOnce = useRef(finishOnServerOnce());
  const finishOnServer = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setFinishing(true);
    setServerError(null);
    track('export_finish_on_server', resolution);
    try {
      const result = await finishOnce.current({
        // Fetched again at tap time: an edit made since the failed run is what renders.
        current: async () => {
          const [fresh, list] = await Promise.all([project.refetch(), assets.refetch()]);
          const doc = fresh.data ?? project.data;
          if (!doc) throw new Error('The project could not be loaded');
          return { project: doc, assets: list.data ?? assets.data ?? [] };
        },
        deps: await localMedia(),
        check: async (ids) => await api.assetAvailability(id, ids),
        nameOf,
        upload: sendOriginal,
        render: async (snapshot) => await api.render(id, resolution, hdr, loudness, snapshot),
        onUploadProgress: setUploading,
        signal: controller.signal,
      });
      if (result.kind === 'rendering') {
        track('render_started', resolution);
        setDevice(undefined);
        setServerNote('Finishing on the server: it keeps going if you leave Editify.');
        setRenderId(result.renderId);
      } else {
        setServerError(result.message);
      }
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      if (abort.current === controller) abort.current = null;
      setUploading(undefined);
      setFinishing(false);
      busy.current = false;
    }
  };
  const exportHere = async (): Promise<void> => {
    const deps = await localMedia();
    const current = project.data;
    const list = assets.data;
    if (!engine || !deps || !current || !list) { renderOnServer(null); return; }
    const controller = new AbortController();
    abort.current = controller;
    track('device_export_started', resolution);
    const server = serverCheck();
    try {
      const outcome = await exportOnDevice({
        build: (geometry) => buildExportPlan(current, list, choices, geometry),
        resolution, deps, native: engine, nameOf, onUpdate: setDevice, signal: controller.signal,
        ...(server ? { server } : {}),
      });
      if (outcome.kind === 'server') {
        // Something changed since the screen opened (a clip went missing): the server renders
        // it when it can; otherwise the screen shows what it needs (upload, or why not).
        setDevice(undefined);
        if (serverRenderable(outcome.route)) {
          renderOnServer(serverRouteLine(outcome.route));
          return;
        }
        void route.refetch();
        busy.current = false;
        return;
      }
      track(`device_export_${outcome.view.state}`, outcome.view.stats ? `${outcome.view.stats.xRealtime}x` : undefined);
    } finally {
      if (abort.current === controller) abort.current = null;
    }
    busy.current = false;
  };
  const onRender = (): void => {
    if (busy.current) return;
    busy.current = true;
    if (route.data?.kind === 'device') {
      setDevice(STARTING);
      void exportHere().catch(() => { busy.current = false; setDevice(undefined); });
      return;
    }
    if (route.data?.kind === 'server' && route.data.server?.state === 'upload') {
      void uploadThenRender(route.data.server.clips).catch((error: unknown) => {
        busy.current = false;
        setServerError(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (route.data && !serverRenderable(route.data)) { busy.current = false; return; }
    renderOnServer(route.data ? serverRouteLine(route.data) : null);
  };
  const locked = Boolean(renderId) || deviceBusy || Boolean(uploading);
  const needsUpload = route.data?.kind === 'server' && route.data.server?.state === 'upload' ? route.data.server.clips : null;
  const blocked = route.data?.kind === 'server' && route.data.server?.state === 'blocked';
  const renderLabel = uploading
    ? `uploading… ${describeImport(uploading)}`
    : start.isPending ? 'joining the queue…'
      : needsUpload ? `upload ${needsUpload.length === 1 ? 'clip' : `${needsUpload.length} clips`}`
        : `render ${resolution} master`;
  const routeLine = route.data?.kind === 'device' ? 'Exports on this iPhone. Keep Editify open until it finishes.' : route.data ? serverRouteLine(route.data) : null;

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
      {!renderId && !device && <Button onPress={onRender} disabled={start.isPending || Boolean(uploading) || blocked || !project.data || (Boolean(engine) && route.isLoading)} style={styles.renderButton}>{renderLabel}</Button>}
      {!renderId && !device && (serverNote ?? routeLine) && <Text testID="export-route" style={styles.note}>{serverNote ?? routeLine}</Text>}
      {uploading && <Button secondary style={styles.downloadButton} onPress={() => abort.current?.abort()}>cancel upload</Button>}
      {serverError && <Text style={styles.error}>{serverError}</Text>}
      {device && <DeviceExportCard view={device} finishing={finishing} onCancel={() => abort.current?.abort()} onRetry={() => { setServerError(null); setDevice(undefined); }} onFinishOnServer={() => { void finishOnServer(); }} />}
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
function DeviceExportCard({ view, finishing, onCancel, onRetry, onFinishOnServer }: {
  view: DeviceExportView; finishing: boolean; onCancel: () => void; onRetry: () => void; onFinishOnServer: () => void;
}) {
  const canFinish = canFinishOnServer(view);
  const running = !isTerminal(view.state);
  const stats = view.stats;
  return (
    <View testID="device-export" style={[styles.statusCard, view.state === 'done' && styles.doneCard, view.state === 'failed' && styles.errorCard]}>
      <View style={styles.statusTop}><Text style={styles.statusValue}>{exportStateLabel(view).toUpperCase()}</Text></View>
      {running && <View style={styles.progress}><View style={[styles.progressFill, { width: `${Math.round(Math.max(0.03, view.progress) * 100)}%` }]} /></View>}
      {running && <Text style={styles.qaDetail}>{view.notice ?? 'Keep Editify open until the export finishes.'} Leaving this screen stops it.</Text>}
      {running && <Button secondary style={styles.downloadButton} onPress={onCancel}>cancel</Button>}
      {view.state === 'done' && view.fileUri && <Button style={styles.downloadButton} onPress={() => void Share.share({ url: view.fileUri as string }).catch(() => undefined)}>share video</Button>}
      {view.state === 'done' && stats && (
        <Text style={styles.qaLine}>{`${stats.lufsOut === null ? 'SILENT' : `${stats.lufsOut.toFixed(1)} LUFS`}${stats.truePeakPreEncode === null ? '' : ` · PEAK ${stats.truePeakPreEncode.toFixed(1)} dBTP PRE-ENCODE`} · ${stats.xRealtime.toFixed(1)}x REALTIME`}</Text>
      )}
      {view.state === 'failed' && <Text style={styles.error}>{view.error}</Text>}
      {canFinish && <Text style={styles.qaDetail}>The server can finish it instead, and it keeps going if you leave Editify.</Text>}
      {canFinish && <Button style={styles.downloadButton} disabled={finishing} accessibilityLabel="finish on server" onPress={onFinishOnServer}>{finishing ? 'sending to the server…' : 'finish on server'}</Button>}
      {(view.state === 'failed' || view.state === 'cancelled') && <Button secondary style={styles.downloadButton} disabled={finishing} onPress={onRetry}>try again</Button>}
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
