import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetMetadata, LibrarySound, Operation, Project } from '@editify/shared';
import { Brand } from '../../src/components/Brand';
import { Button } from '../../src/components/Button';
import { EditSummaryPanel } from '../../src/components/EditSummaryPanel';
import { ImportSheet } from '../../src/components/ImportSheet';
import { InsightsPanel } from '../../src/components/InsightsPanel';
import { LIBRARY_ROOT, MediaLibrary } from '../../src/components/MediaLibrary';
import { Screen } from '../../src/components/Screen';
import { ChatDock } from '../../src/components/editor/ChatDock';
import { PreviewPlayer } from '../../src/components/editor/PreviewPlayer';
import { SoundSheet } from '../../src/components/editor/SoundSheet';
import { StickerSheet } from '../../src/components/editor/StickerSheet';
import { CleanupSheet } from '../../src/components/editor/CleanupSheet';
import { VoiceSheet } from '../../src/components/editor/VoiceSheet';
import { StylePacketSheet } from '../../src/components/editor/StylePacketSheet';
import { LayoutPresets, PanelDivider, useEditorLayout } from '../../src/components/editor/PanelLayout';
import { ReportModal } from '../../src/components/ReportModal';
import { Timeline } from '../../src/components/editor/Timeline';
import { usePlayback } from '../../src/components/editor/usePlayback';
import { api } from '../../src/lib/api';
import { captureScreen, type Screenshot } from '../../src/lib/capture';
import { packetPrompt } from '../../src/lib/packets';
import { pickFromFiles, pickFromPhotos, uploadFiles, type PickProgress, type PickResult } from '../../src/lib/pick';
import { isReadStep, type AgentTraceStep } from '../../src/lib/agent';
import { setReportContext, track } from '../../src/lib/telemetry';
import { backControlStyle, goBack } from '../../src/lib/nav';
import { sensitive } from '../../src/lib/sensitive';
import { colors, radius, space, type, fonts } from '../../src/lib/theme';

/** Above this width the editor lays out as preview + timeline | chat dock. */
const WIDE_BREAKPOINT = 1024;
const NATIVE_DRIVER = Platform.OS !== 'web';

interface ApplyVariables {
  ops: Operation[];
  /** Paints the expected result before the round trip; rolled back by a refetch on error. */
  optimistic?: (project: Project) => Project;
}

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { width, height } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  // Stacked mode gives the preview a real share of the screen instead of the
  // leftovers under the library and timeline.
  const previewHeight = Math.min(620, Math.max(320, Math.round(height * 0.5)));
  // Measured once per window size; the wide layout's minimums are enforced
  // against the room the workspace actually has.
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const { layout, resize, commit, preset, reset } = useEditorLayout(id, bounds);
  // The panel size a drag started from; the divider reports travel, not position.
  const dragBase = useRef(layout);

  const [selectedId, setSelectedId] = useState<string>();
  const [openPanel, setOpenPanel] = useState<'summary' | 'insights' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  /** Captured when feedback is opened, before the sheet covers the timeline. */
  const [shot, setShot] = useState<Screenshot>();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  /** Only set while a multi-file import is running. */
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [optimisticMessage, setOptimisticMessage] = useState<string>();
  // Covers the gap between the chat mutation resolving and the history refetch.
  const [latestTrace, setLatestTrace] = useState<AgentTraceStep[]>();

  const projectQuery = useQuery({ queryKey: ['project', id], queryFn: () => api.getProject(id), enabled: Boolean(id) });
  const chatQuery = useQuery({ queryKey: ['chat', id], queryFn: () => api.getChat(id), enabled: Boolean(id) });
  // Drives the ↶ / ↷ buttons. Refetched after every edit — including the ones
  // the agent applies — so the controls always match the server's log.
  const historyQuery = useQuery({ queryKey: ['history', id], queryFn: () => api.getHistory(id), enabled: Boolean(id) });
  const project = projectQuery.data;

  const assetIds = useMemo(() => [...new Set(
    (project?.tracks ?? [])
      .filter((track) => track.kind !== 'caption')
      .flatMap((track) => track.clips)
      .flatMap((clip) => (clip.assetId ? [clip.assetId] : [])),
  )], [project]);
  const assetsQuery = useQuery({
    queryKey: ['assets', assetIds],
    queryFn: async (): Promise<Record<string, AssetMetadata>> => Object.fromEntries(
      await Promise.all(assetIds.map(async (assetId) => [assetId, await api.getAsset(assetId)] as const)),
    ),
    enabled: assetIds.length > 0,
    staleTime: 5 * 60 * 1000,
    // A clip can land on the timeline while its proxy is still encoding; keep
    // polling until every asset is ready so the player picks the video up.
    refetchInterval: (query) => (Object.values(query.state.data ?? {}).some((asset) => asset.status === 'processing') ? 2000 : false),
  });
  const assets: Record<string, AssetMetadata | undefined> = assetsQuery.data ?? {};

  // `clock` is an external store, not state: the playhead ticks at ~60Hz and
  // only the components that draw it subscribe, so this screen does not
  // re-render during playback.
  const { clock, playing, seek, toggle, stop } = usePlayback(project?.duration ?? 0);
  const lastAssistantId = useMemo(
    () => chatQuery.data?.filter((message) => message.role === 'assistant').at(-1)?.id,
    [chatQuery.data],
  );

  // Ops are serialized through this chain: each batch waits for the previous
  // one and reads the freshest doc from the cache, so a burst of quick edits
  // (stepper taps, rapid imports) no longer races itself into 409s.
  const opChain = useRef<Promise<unknown>>(Promise.resolve());
  const apply = useMutation({
    mutationFn: ({ ops }: ApplyVariables) => {
      const run = opChain.current.catch(() => undefined).then(async () => {
        const current = queryClient.getQueryData<Project>(['project', id]);
        if (!current) throw new Error('Project is still loading');
        const updated = await api.applyOps(current.id, ops, current.version);
        // Written here, not just in onSuccess, so the next queued batch sees it.
        queryClient.setQueryData(['project', id], updated);
        return updated;
      });
      opChain.current = run;
      return run;
    },
    onMutate: ({ optimistic }: ApplyVariables) => {
      if (!optimistic) return;
      const current = queryClient.getQueryData<Project>(['project', id]);
      if (current) queryClient.setQueryData(['project', id], { ...optimistic(current), version: current.version });
    },
    onSuccess: (updated) => queryClient.setQueryData(['project', id], updated),
    onError: async () => { await queryClient.invalidateQueries({ queryKey: ['project', id] }); },
    onSettled: async () => { await queryClient.invalidateQueries({ queryKey: ['history', id] }); },
  });

  /** Undo and redo ride the same chain as `apply`, so they never race an in-flight batch. */
  const history = useMutation({
    mutationFn: (direction: 'undo' | 'redo') => {
      const run = opChain.current.catch(() => undefined).then(async () => {
        const current = queryClient.getQueryData<Project>(['project', id]);
        if (!current) throw new Error('Project is still loading');
        const updated = direction === 'undo'
          ? await api.undo(current.id, current.version)
          : await api.redo(current.id, current.version);
        queryClient.setQueryData(['project', id], updated);
        return updated;
      });
      opChain.current = run;
      return run;
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: ['project', id] }); },
    onSettled: async () => { await queryClient.invalidateQueries({ queryKey: ['history', id] }); },
  });
  // Queued behind the same chain as `apply`: a revert must not race a batch of
  // ops that is still in flight.
  const revertRun = useMutation({
    mutationFn: (runId: string) => {
      const run = opChain.current.catch(() => undefined).then(() => api.revertRun(id, runId));
      opChain.current = run;
      return run;
    },
    onSuccess: async (doc: Project) => {
      queryClient.setQueryData(['project', id], doc);
      await queryClient.invalidateQueries({ queryKey: ['chat', id] });
      await queryClient.invalidateQueries({ queryKey: ['history', id] });
    },
  });
  const sendChat = useMutation({
    mutationFn: (message: string) => api.chat(id, message),
    onMutate: (message: string) => { track('chat_message'); setOptimisticMessage(message); setLatestTrace(undefined); },
    onSuccess: async (response) => {
      queryClient.setQueryData(['project', id], response.doc);
      setLatestTrace(response.trace ?? []);
      await queryClient.invalidateQueries({ queryKey: ['chat', id] });
      await queryClient.invalidateQueries({ queryKey: ['history', id] });
    },
    onSettled: () => setOptimisticMessage(undefined),
  });
  // Follow the running turn's steps so the trace fills in while the agent works.
  const liveQuery = useQuery({
    queryKey: ['chat-live', id],
    queryFn: () => api.getChatLive(id),
    enabled: sendChat.isPending,
    refetchInterval: 900,
  });

  // The timeline is the trace: refetch the project as live mutation steps land
  // so agent edits appear while the turn is still running, not only at the end.
  useEffect(() => { if (id) track('project_open', id); }, [id]);

  // What a report sent from this screen should carry. Read at send time, so the
  // numbers describe the timeline the user is looking at, not the one that was
  // loaded when the effect ran. Refs feed the parts this screen deliberately
  // does not re-render for, like the playhead.
  const snapshot = useRef({ project, selectedId, openPanel, wide, playing, layout });
  snapshot.current = { project, selectedId, openPanel, wide, playing, layout };
  // Focus-scoped for the same reason as the overscroll guard below: export is
  // pushed on top of this screen without unmounting it.
  useFocusEffect(useCallback(() => setReportContext(() => {
    const { project: doc, selectedId: selected, openPanel: panel, wide: isWide, playing: isPlaying, layout: panels } = snapshot.current;
    const clips = (doc?.tracks ?? []).flatMap((track) => track.clips);
    return {
      screen: 'editor',
      layout: isWide ? 'wide' : 'stacked',
      ...(doc ? {
        projectId: doc.id,
        projectFormat: doc.format,
        projectFps: doc.fps,
        projectVersion: doc.version,
        trackCount: doc.tracks.length,
        clipCount: clips.length,
        captionCount: doc.tracks.filter((track) => track.kind === 'caption').flatMap((track) => track.clips).length,
        timelineSeconds: Math.round(doc.duration),
      } : { projectLoaded: false }),
      selectedClip: selected ?? 'none',
      openPanel: panel ?? 'none',
      // Panel sizes are persisted per project and have already caused one
      // layout bug, so a report from a dragged-about editor has to say so.
      panelSizes: Object.entries(panels).map(([key, value]) => `${key}:${Math.round(Number(value))}`).join(' '),
      playhead: Math.round(clock.get() * 10) / 10,
      playing: isPlaying,
    };
  }), [clock]));

  const liveSteps = sendChat.isPending ? liveQuery.data?.steps : undefined;
  const seenLiveSteps = useRef(0);
  useEffect(() => {
    if (!liveSteps) { seenLiveSteps.current = 0; return; }
    if (liveSteps.length <= seenLiveSteps.current) return;
    const fresh = liveSteps.slice(seenLiveSteps.current);
    seenLiveSteps.current = liveSteps.length;
    if (fresh.some((step) => step.ok && !isReadStep(step))) {
      void queryClient.invalidateQueries({ queryKey: ['project', id] });
      void queryClient.invalidateQueries({ queryKey: ['history', id] });
    }
  }, [liveSteps, queryClient, id]);

  // Flash the timeline whenever a new project version lands, so an agent edit
  // is visible even when it changed something off-screen.
  const flash = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (project?.version === undefined) return;
    flash.setValue(0.4);
    Animated.timing(flash, { toValue: 1, duration: 420, useNativeDriver: NATIVE_DRIVER }).start();
  }, [flash, project?.version]);

  // Stage changes are click-only in the editor. A horizontal trackpad/touch
  // swipe used to leave mid-edit: on web the browser turns horizontal
  // overscroll into back/forward history navigation (format selection /
  // export), and on iOS the stack's edge swipe pops the screen. Both are
  // switched off here only, so the other stages keep their normal gestures.
  // Focus-scoped, not mount-scoped: the router keeps this screen mounted while
  // export is pushed on top of it, so a plain effect would leak the guard onto
  // the other stages and never clean up.
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'web') return undefined;
    const root = document.documentElement;
    const previous = root.style.overscrollBehaviorX;
    root.style.overscrollBehaviorX = 'none';
    return () => { root.style.overscrollBehaviorX = previous; };
  }, []));

  // Space toggles playback on web, unless the composer has focus.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  const canUndo = Boolean(historyQuery.data?.canUndo) && !history.isPending;
  const canRedo = Boolean(historyQuery.data?.canRedo) && !history.isPending;
  const runHistory = useCallback((direction: 'undo' | 'redo') => { history.mutate(direction); }, [history]);

  // cmd/ctrl+Z undoes, cmd/ctrl+shift+Z and ctrl+Y redo — web only, and never
  // while the caret is in the composer, where the browser's own undo belongs.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      const key = event.key.toLowerCase();
      // ctrl+Y is the Windows redo; cmd+Y is a browser shortcut and stays put.
      const redoing = key === 'z' ? event.shiftKey : true;
      if (key !== 'z' && !(key === 'y' && event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      if (redoing ? canRedo : canUndo) runHistory(redoing ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canRedo, canUndo, runHistory]);

  function applyOps(ops: Operation[], optimistic?: (current: Project) => Project): void {
    // One line per edit batch, so a report can show what the user did by hand
    // right before they hit a wall (or a crash).
    track('edit', ops.map((op) => op.type).join(','));
    apply.mutate(optimistic ? { ops, optimistic } : { ops });
  }

  /** Lays imported assets back-to-back at the end of the video track, in one batch. */
  function appendAssets(assetList: AssetMetadata[]): void {
    // A probe that could not read a duration would make an invalid clip; skip those.
    const added = assetList.filter((asset) => asset.duration > 0);
    if (!project || added.length === 0) return;
    const videoTrack = project.tracks.find((track) => track.kind === 'video');
    const trackId = videoTrack?.id ?? 'video-main';
    const stamp = Date.now();
    // The end of the VIDEO track — project.duration can be stretched by a
    // caption or sticker, which would leave a silent gap before the new clip.
    let start = (videoTrack?.clips ?? []).reduce(
      (end, clip) => Math.max(end, clip.start + (clip.out - clip.in) / (clip.speed ?? 1)),
      0,
    );
    const ops = added.map((asset, index): Operation => {
      const clip = { id: `clip-${stamp}-${index}`, assetId: asset.id, start, in: 0, out: asset.duration, volume: 1, speed: 1 };
      start += asset.duration;
      return { type: 'add_clip', params: { trackId, clip } };
    });
    applyOps(ops);
    setSelectedId(`clip-${stamp}-${added.length - 1}`);
  }

  const round3 = (value: number): number => Math.round(value * 1000) / 1000;

  /** CapCut model: `+` on a sound row drops it on the audio track at the playhead. */
  async function addSound(sound: LibrarySound): Promise<void> {
    if (!project) return;
    const trackId = project.tracks.find((track) => track.kind === 'audio')?.id ?? 'audio-main';
    try {
      await api.linkAsset(id, sound.assetId); // so the agent's list_assets sees it
    } catch { /* the clip still works unlinked */ }
    applyOps([{
      type: 'add_clip',
      params: {
        trackId,
        clip: { id: `sfx-${sound.id}-${Date.now()}`, assetId: sound.assetId, start: round3(clock.get()), in: 0, out: sound.duration, volume: 1, speed: 1 },
      },
    }]);
  }

  /** Voiceover recordings land on the audio track at the playhead and duck everything else. */
  function addVoiceover(asset: AssetMetadata): void {
    if (!project) return;
    const trackId = project.tracks.find((track) => track.kind === 'audio')?.id ?? 'audio-main';
    const clipId = `voice-${Date.now()}`;
    applyOps([{
      type: 'add_clip',
      params: {
        trackId,
        clip: { id: clipId, assetId: asset.id, start: round3(clock.get()), in: 0, out: asset.duration, volume: 1, speed: 1, duck: true },
      },
    }]);
    setSelectedId(clipId);
  }

  /** Stickers land at the playhead for 3 seconds and are draggable on the preview. */
  function addSticker(content: {
    emoji?: string;
    asset?: AssetMetadata;
    callout?: { variant: 'check' | 'x' | 'card'; text: string };
  }): void {
    const clipId = `sticker-${Date.now()}`;
    applyOps([{
      type: 'add_clip',
      params: {
        trackId: 'overlays',
        clip: {
          id: clipId,
          ...(content.callout
            ? { text: content.callout.text, callout: { variant: content.callout.variant } }
            : content.asset ? { assetId: content.asset.id } : { text: content.emoji ?? '★' }),
          start: round3(clock.get()),
          in: 0,
          out: 3,
          // Callout cards read as text, so they land wider than a sticker.
          overlay: { x: 0.5, y: content.callout ? 0.3 : 0.35, width: content.callout ? 0.56 : 0.28, rotation: 0 },
        },
      },
    }]);
    setSelectedId(clipId);
  }

  /** Run a source picker, then land whatever it uploaded in the library and on the timeline. */
  async function addFrom(pick: (projectId: string, onProgress: PickProgress) => Promise<PickResult>): Promise<void> {
    if (!project) return;
    setUploading(true);
    setUploadError(undefined);
    setProgress(undefined);
    try {
      // One clip needs no counter; a batch does.
      const { assets: added, failed } = await pick(id, (done, total) => setProgress(total > 1 ? { done, total } : undefined));
      appendAssets(added);
      if (added.length > 0) await queryClient.invalidateQueries({ queryKey: LIBRARY_ROOT });
      if (failed.length > 0) setUploadError(`Could not import ${failed.length} of ${added.length + failed.length}: ${failed.join(', ')}`);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not add that media');
    } finally {
      setUploading(false);
      setProgress(undefined);
    }
  }

  if (projectQuery.isLoading) return <Screen><Text style={styles.center}>Opening the cutting room…</Text></Screen>;
  if (projectQuery.error || !project) {
    return <Screen><Text style={styles.error}>Could not open this project: {projectQuery.error?.message}</Text></Screen>;
  }

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => goBack(router, '/')} accessibilityRole="button" style={backControlStyle}><Text style={styles.back}>‹  PROJECTS</Text></Pressable>
      <View style={styles.heading}>
        {/* The wordmark is decoration; on a phone the title needs the room. */}
        {width >= 560 && (
          <>
            <Brand compact />
            <View style={styles.divider} />
          </>
        )}
        <View style={styles.headingText}>
          <Text style={styles.projectTitle} {...sensitive} numberOfLines={1}>{project.title}</Text>
          <Text style={styles.projectMeta} numberOfLines={1}>
            {project.format} · {project.fps} FPS · V{project.version} · {project.tracks.reduce((total, track) => total + track.clips.length, 0)} CLIPS
          </Text>
        </View>
      </View>
      <View style={styles.headerActions}>
        <HistoryButton label="↶" accessibilityLabel="Undo" testID="undo-button" enabled={canUndo} onPress={() => runHistory('undo')} />
        <HistoryButton label="↷" accessibilityLabel="Redo" testID="redo-button" enabled={canRedo} onPress={() => runHistory('redo')} />
        {/* Adding media lives in the library (+ photos / + files / + folder), which also
            reports import progress. The header keeps only the global action. */}
        {/* Feedback belongs here and not just on the home screen: sent from the
            editor it carries the open project, the timeline, and the last edits
            the user made, which is most of what triage needs. */}
        <Button
          accessibilityLabel="send feedback"
          secondary
          style={styles.feedbackButton}
          onPress={() => { track('feedback_open', 'editor'); void captureScreen().then(setShot); setFeedbackOpen(true); }}
        >
          feedback
        </Button>
        <Button style={styles.exportButton} onPress={() => router.push({ pathname: '/project/[id]/export', params: { id } })}>
          export ↗
        </Button>
      </View>
    </View>
  );

  const timeline = (
    <Animated.View style={{ opacity: flash }}>
      <Timeline
        project={project}
        assets={assets}
        clock={clock}
        playing={playing}
        selectedId={selectedId}
        pending={apply.isPending}
        errorMessage={apply.error?.message}
        onSeek={(time) => { stop(); seek(time); }}
        onScrub={setScrubbing}
        onSelect={setSelectedId}
        onApply={applyOps}
        onImport={() => void addFrom(pickFromFiles)}
        onImportFiles={(files) => void addFrom((projectId, onProgress) => uploadFiles(projectId, files, onProgress))}
        importing={uploading}
        importProgress={progress}
        importError={uploadError}
        onAddSound={() => setSoundOpen(true)}
        onAddSticker={() => setStickerOpen(true)}
        onCleanup={() => setCleanupOpen(true)}
        onRecordVoice={() => setVoiceOpen(true)}
        onStyle={() => setStyleOpen(true)}
      />
    </Animated.View>
  );

  const library = (
    <MediaLibrary
      projectId={id}
      busy={uploading}
      {...(progress ? { progress } : {})}
      {...(uploadError ? { error: uploadError } : {})}
      onPickPhotos={() => void addFrom(pickFromPhotos)}
      onPickFiles={() => void addFrom(pickFromFiles)}
      onOpenFolder={() => setImportOpen(true)}
      onAdd={(asset) => appendAssets([asset])}
    />
  );

  // Accordion: one panel at a time, so an expanded panel always has room in the
  // dock column instead of squeezing its neighbour's header out of view (#50).
  const summary = (
    <EditSummaryPanel
      messages={chatQuery.data}
      open={openPanel === 'summary'}
      onToggle={() => setOpenPanel((current) => (current === 'summary' ? null : 'summary'))}
    />
  );
  const insights = (
    <InsightsPanel
      assetIds={assetIds}
      project={project}
      open={openPanel === 'insights'}
      onToggle={() => setOpenPanel((current) => (current === 'insights' ? null : 'insights'))}
    />
  );

  const dock = (
    <ChatDock
      projectId={id}
      messages={chatQuery.data}
      latestTrace={latestTrace}
      latestAssistantId={lastAssistantId}
      liveTrace={sendChat.isPending ? liveQuery.data?.steps : undefined}
      optimisticMessage={optimisticMessage}
      pending={sendChat.isPending}
      error={sendChat.error?.message}
      onSend={(message) => sendChat.mutate(message)}
      onRevert={(runId) => revertRun.mutate(runId)}
      reverting={revertRun.isPending}
      onSeek={(time) => { stop(); seek(time); }}
    />
  );

  return (
    <Screen scroll={!wide} bleed header={header}>
      {/* Native counterpart of the overscroll guard above: no edge-swipe back. */}
      <Stack.Screen options={{ gestureEnabled: false }} />
      {feedbackOpen && (
        <ReportModal
          mode="feedback"
          {...(shot ? { screenshot: shot } : {})}
          onClose={() => { setFeedbackOpen(false); setShot(undefined); }}
        />
      )}
      {wide && <View style={styles.layoutBar}><LayoutPresets onPreset={preset} onReset={reset} /></View>}
      <View
        style={[styles.workspace, !wide && styles.workspaceStacked]}
        onLayout={(event) => {
          const { width: w, height: h } = event.nativeEvent.layout;
          setBounds((current) => (current.width === w && current.height === h ? current : { width: w, height: h }));
        }}
      >
        <View style={[styles.editColumn, !wide && styles.editColumnStacked]}>
          {/* The preview is the editor's centrepiece: stacked mode hands it half
              the screen outright, wide mode the whole column above the timeline
              (the library and insights move to the dock column there). */}
          <View style={wide ? { height: layout.previewHeight } : { height: previewHeight }}>
            <PreviewPlayer
              project={project}
              assets={assets}
              clock={clock}
              playing={playing}
              scrubbing={scrubbing}
              selectedId={selectedId}
              onTogglePlay={toggle}
              onSeek={(time) => { stop(); seek(time); }}
              onSelect={setSelectedId}
              onApply={applyOps}
            />
          </View>
          {!wide && library}
          {wide && (
            <PanelDivider
              orientation="horizontal"
              testID="divider-preview"
              accessibilityLabel="Resize the preview"
              onDragStart={() => { dragBase.current = layout; }}
              onDrag={(delta) => resize({ previewHeight: dragBase.current.previewHeight + delta })}
              onDragEnd={commit}
            />
          )}
          {wide ? <View style={styles.timelineWide}>{timeline}</View> : timeline}
          {!wide && summary}
          {!wide && insights}
        </View>
        {wide && (
          <PanelDivider
            orientation="vertical"
            testID="divider-dock"
            accessibilityLabel="Resize the chat dock"
            onDragStart={() => { dragBase.current = layout; }}
            onDrag={(delta) => resize({ dockWidth: dragBase.current.dockWidth - delta })}
            onDragEnd={commit}
          />
        )}
        <View style={[styles.dockColumn, !wide && styles.dockColumnStacked, wide && { width: layout.dockWidth }]}>
          {wide && library}
          {dock}
          {wide && summary}
          {wide && insights}
        </View>
      </View>
      <ImportSheet
        projectId={id}
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(asset) => {
          appendAssets([asset]);
          void queryClient.invalidateQueries({ queryKey: LIBRARY_ROOT });
        }}
      />
      <SoundSheet
        visible={soundOpen}
        onClose={() => setSoundOpen(false)}
        onAdd={(sound) => void addSound(sound)}
      />
      <StickerSheet
        projectId={id}
        visible={stickerOpen}
        onClose={() => setStickerOpen(false)}
        onAddEmoji={(emoji) => addSticker({ emoji })}
        onAddImage={(asset) => addSticker({ asset })}
        onAddCallout={(callout) => addSticker({ callout })}
      />
      <CleanupSheet
        projectId={id}
        project={project}
        visible={cleanupOpen}
        onClose={() => setCleanupOpen(false)}
        onApply={applyOps}
      />
      <VoiceSheet
        projectId={id}
        visible={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onRecorded={addVoiceover}
      />
      <StylePacketSheet
        visible={styleOpen}
        busy={sendChat.isPending}
        onClose={() => setStyleOpen(false)}
        onApply={(packet) => {
          // The sheet stays open so the row can show applying/applied — it closes itself.
          // The agent runs apply_style_packet, then judges the creative parts.
          sendChat.mutate(packetPrompt(packet));
        }}
      />
    </Screen>
  );
}

/** Greyed out and unpressable when the server says there is nothing to step to. */
function HistoryButton({ label, accessibilityLabel, testID, enabled, onPress }: {
  label: string; accessibilityLabel: string; testID: string; enabled: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !enabled }}
      testID={testID}
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [styles.historyButton, !enabled && styles.historyButtonDisabled, pressed && enabled && styles.historyButtonPressed]}
    >
      <Text style={[styles.historyLabel, !enabled && styles.historyLabelDisabled]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.xl },
  back: { flexShrink: 0, color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.2 },
  heading: { flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xl },
  headingText: { flexShrink: 1, minWidth: 0 },
  divider: { width: 1, height: 26, backgroundColor: colors.border },
  projectTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg },
  projectMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, marginTop: space.xs, letterSpacing: 0.5 },
  headerActions: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: space.lg },
  feedbackButton: { paddingHorizontal: space.xl, minHeight: 30 },
  exportButton: { minWidth: 96, minHeight: 30 },
  historyButton: {
    minWidth: 30, minHeight: 30, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised,
  },
  historyButtonDisabled: { opacity: 0.38 },
  historyButtonPressed: { borderColor: colors.accent },
  historyLabel: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.xl },
  historyLabelDisabled: { color: colors.muted },
  layoutBar: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: space.md },
  // Wide mode: the dividers occupy the gutter between panels, so no gap here.
  workspace: { flex: 1, flexDirection: 'row', minHeight: 0 },
  workspaceStacked: { flexDirection: 'column', gap: space.xl },
  editColumn: { flex: 1, minWidth: 0, gap: space.lg },
  timelineWide: { flex: 1, minHeight: 180 },
  editColumnStacked: {},
  dockColumn: { width: 372, minHeight: 0, gap: space.lg },
  dockColumnStacked: { width: '100%', minHeight: 560 },
  center: { color: colors.text, fontFamily: fonts.semibold, textAlign: 'center', marginTop: 120 },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.lg },
});
