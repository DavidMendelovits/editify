import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import type { AssetMetadata, Operation, Project } from '@editify/shared';
import { Brand } from '../../src/components/Brand';
import { GradientButton } from '../../src/components/GradientButton';
import { ImportSheet } from '../../src/components/ImportSheet';
import { InsightsPanel } from '../../src/components/InsightsPanel';
import { Screen } from '../../src/components/Screen';
import { ChatDock } from '../../src/components/editor/ChatDock';
import { PreviewPlayer } from '../../src/components/editor/PreviewPlayer';
import { Timeline } from '../../src/components/editor/Timeline';
import { usePlayback } from '../../src/components/editor/usePlayback';
import { api, uploadAsset } from '../../src/lib/api';
import type { AgentTraceStep } from '../../src/lib/agent';
import { colors } from '../../src/lib/theme';

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
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;

  const [selectedId, setSelectedId] = useState<string>();
  const [importOpen, setImportOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState<string>();
  // Covers the gap between the chat mutation resolving and the history refetch.
  const [latestTrace, setLatestTrace] = useState<AgentTraceStep[]>();

  const projectQuery = useQuery({ queryKey: ['project', id], queryFn: () => api.getProject(id), enabled: Boolean(id) });
  const chatQuery = useQuery({ queryKey: ['chat', id], queryFn: () => api.getChat(id), enabled: Boolean(id) });
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
  });
  const assets: Record<string, AssetMetadata | undefined> = assetsQuery.data ?? {};

  const { playhead, playing, seek, toggle, stop } = usePlayback(project?.duration ?? 0);
  const lastAssistantId = useMemo(
    () => chatQuery.data?.filter((message) => message.role === 'assistant').at(-1)?.id,
    [chatQuery.data],
  );

  const apply = useMutation({
    mutationFn: async ({ ops }: ApplyVariables) => {
      if (!project) throw new Error('Project is still loading');
      return await api.applyOps(project.id, ops, project.version);
    },
    onMutate: ({ optimistic }: ApplyVariables) => {
      if (!optimistic) return;
      const current = queryClient.getQueryData<Project>(['project', id]);
      if (current) queryClient.setQueryData(['project', id], optimistic(current));
    },
    onSuccess: (updated) => queryClient.setQueryData(['project', id], updated),
    onError: async () => { await queryClient.invalidateQueries({ queryKey: ['project', id] }); },
  });
  const sendChat = useMutation({
    mutationFn: (message: string) => api.chat(id, message),
    onMutate: (message: string) => { setOptimisticMessage(message); setLatestTrace(undefined); },
    onSuccess: async (response) => {
      queryClient.setQueryData(['project', id], response.doc);
      setLatestTrace(response.trace ?? []);
      await queryClient.invalidateQueries({ queryKey: ['chat', id] });
    },
    onSettled: () => setOptimisticMessage(undefined),
  });

  // Flash the timeline whenever a new project version lands, so an agent edit
  // is visible even when it changed something off-screen.
  const flash = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (project?.version === undefined) return;
    flash.setValue(0.4);
    Animated.timing(flash, { toValue: 1, duration: 420, useNativeDriver: NATIVE_DRIVER }).start();
  }, [flash, project?.version]);

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

  function applyOps(ops: Operation[], optimistic?: (current: Project) => Project): void {
    apply.mutate(optimistic ? { ops, optimistic } : { ops });
  }

  /** Drops a freshly imported/uploaded asset at the end of the video track. */
  function appendAsset(asset: AssetMetadata): void {
    if (!project) return;
    const clipId = `clip-${Date.now()}`;
    applyOps([{
      type: 'add_clip',
      params: {
        trackId: project.tracks.find((track) => track.kind === 'video')?.id ?? 'video-main',
        clip: { id: clipId, assetId: asset.id, start: project.duration, in: 0, out: asset.duration, volume: 1, speed: 1 },
      },
    }]);
    setSelectedId(clipId);
  }

  async function uploadMedia(): Promise<void> {
    const picked = await DocumentPicker.getDocumentAsync({ type: ['video/*', 'audio/*'], copyToCacheDirectory: true });
    if (picked.canceled || !project) return;
    const file = picked.assets[0];
    if (!file) return;
    setUploading(true);
    try {
      appendAsset(await uploadAsset({ uri: file.uri, name: file.name, ...(file.mimeType ? { mimeType: file.mimeType } : {}) }));
    } finally {
      setUploading(false);
    }
  }

  if (projectQuery.isLoading) return <Screen><Text style={styles.center}>Opening the cutting room…</Text></Screen>;
  if (projectQuery.error || !project) {
    return <Screen><Text style={styles.error}>Could not open this project: {projectQuery.error?.message}</Text></Screen>;
  }

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} accessibilityRole="button"><Text style={styles.back}>‹  PROJECTS</Text></Pressable>
      <View style={styles.heading}>
        <Brand compact />
        <View style={styles.divider} />
        <View>
          <Text style={styles.projectTitle}>{project.title}</Text>
          <Text style={styles.projectMeta}>
            {project.format} · {project.fps} FPS · V{project.version} · {project.tracks.reduce((total, track) => total + track.clips.length, 0)} CLIPS
          </Text>
        </View>
      </View>
      <View style={styles.headerActions}>
        <GradientButton secondary style={styles.headerButton} onPress={() => void uploadMedia()} disabled={uploading}>
          {uploading ? 'processing…' : '+ media'}
        </GradientButton>
        <GradientButton style={styles.exportButton} onPress={() => router.push({ pathname: '/project/[id]/export', params: { id } })}>
          export ↗
        </GradientButton>
      </View>
    </View>
  );

  const timeline = (
    <Animated.View style={{ opacity: flash }}>
      <Timeline
        project={project}
        assets={assets}
        playhead={playhead}
        playing={playing}
        selectedId={selectedId}
        pending={apply.isPending}
        errorMessage={apply.error?.message}
        onSeek={(time) => { stop(); seek(time); }}
        onSelect={setSelectedId}
        onApply={applyOps}
        onImport={() => setImportOpen(true)}
      />
    </Animated.View>
  );

  const dock = (
    <ChatDock
      projectId={id}
      messages={chatQuery.data}
      latestTrace={latestTrace}
      latestAssistantId={lastAssistantId}
      optimisticMessage={optimisticMessage}
      pending={sendChat.isPending}
      error={sendChat.error?.message}
      onSend={(message) => sendChat.mutate(message)}
    />
  );

  return (
    <Screen scroll={!wide} bleed header={header}>
      <View style={[styles.workspace, !wide && styles.workspaceStacked]}>
        <View style={[styles.editColumn, !wide && styles.editColumnStacked]}>
          <PreviewPlayer
            project={project}
            assets={assets}
            playhead={playhead}
            playing={playing}
            onTogglePlay={toggle}
            onSeek={seek}
          />
          {timeline}
          <InsightsPanel assetIds={assetIds} />
        </View>
        <View style={[styles.dockColumn, !wide && styles.dockColumnStacked]}>{dock}</View>
      </View>
      <ImportSheet
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(asset) => appendAsset(asset)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  back: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.2 },
  heading: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  divider: { width: 1, height: 26, backgroundColor: colors.border },
  projectTitle: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  projectMeta: { color: colors.muted, fontFamily: 'Montserrat_500Medium', fontSize: 8, marginTop: 3, letterSpacing: 0.5 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerButton: { minHeight: 36, paddingHorizontal: 12, borderColor: colors.border, backgroundColor: colors.panel },
  exportButton: { width: 104, minHeight: 36 },
  workspace: { flex: 1, flexDirection: 'row', gap: 12, minHeight: 0 },
  workspaceStacked: { flexDirection: 'column' },
  editColumn: { flex: 1, minWidth: 0, gap: 10 },
  editColumnStacked: { minHeight: 620 },
  dockColumn: { width: 372, minHeight: 0 },
  dockColumnStacked: { width: '100%', height: 560 },
  center: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', textAlign: 'center', marginTop: 120 },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 12 },
});
