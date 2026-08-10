import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { Clip, Operation, Project } from '@editify/shared';
import { clipTimelineDuration } from '@editify/shared';
import { AgentActivity } from '../../src/components/AgentActivity';
import { AgentTrace } from '../../src/components/AgentTrace';
import { Brand } from '../../src/components/Brand';
import { GradientButton } from '../../src/components/GradientButton';
import { ImportSheet } from '../../src/components/ImportSheet';
import { InsightsPanel } from '../../src/components/InsightsPanel';
import { PresetPicker } from '../../src/components/PresetPicker';
import { Screen } from '../../src/components/Screen';
import { api, uploadAsset, type ChatMessage } from '../../src/lib/api';
import type { AgentTraceStep } from '../../src/lib/agent';
import { presetPrompt } from '../../src/lib/presets';
import { colors } from '../../src/lib/theme';

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();
  const [selectedId, setSelectedId] = useState<string>();
  const [playhead, setPlayhead] = useState(0);
  const [chatText, setChatText] = useState('');
  /** Preset whose prompt is sitting in the composer — cleared once the text no longer matches. */
  const [selectedPreset, setSelectedPreset] = useState<string>();
  const [optimisticMessage, setOptimisticMessage] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // The trace also arrives with the persisted chat history; this covers the gap
  // between the mutation resolving and that history refetching (and any server
  // that does not persist traces on GET /chat).
  const [latestTrace, setLatestTrace] = useState<AgentTraceStep[]>();
  const projectQuery = useQuery({ queryKey: ['project', id], queryFn: () => api.getProject(id), enabled: Boolean(id) });
  const chatQuery = useQuery({ queryKey: ['chat', id], queryFn: () => api.getChat(id), enabled: Boolean(id) });
  const lastAssistantId = useMemo(() => chatQuery.data?.filter((message) => message.role === 'assistant').at(-1)?.id, [chatQuery.data]);
  const project = projectQuery.data;
  const mediaClips = useMemo(() => project?.tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips).sort((a, b) => a.start - b.start) ?? [], [project]);
  const captionClips = project?.tracks.filter((track) => track.kind === 'caption').flatMap((track) => track.clips) ?? [];
  const assetIds = [...new Set(mediaClips.flatMap((clip) => clip.assetId ? [clip.assetId] : []))];
  const assetsQuery = useQuery({
    queryKey: ['assets', assetIds],
    queryFn: async () => Object.fromEntries(await Promise.all(assetIds.map(async (assetId) => [assetId, await api.getAsset(assetId)] as const))),
    enabled: assetIds.length > 0,
  });
  const selected = mediaClips.find((clip) => clip.id === selectedId) ?? mediaClips[0];
  const selectedIndex = selected ? mediaClips.findIndex((clip) => clip.id === selected.id) : -1;
  const selectedAsset = selected?.assetId ? assetsQuery.data?.[selected.assetId] : undefined;

  useEffect(() => {
    if (!selectedId && mediaClips[0]) setSelectedId(mediaClips[0].id);
  }, [mediaClips, selectedId]);

  const apply = useMutation({
    mutationFn: async (ops: Operation[]) => {
      if (!project) throw new Error('Project is still loading');
      return await api.applyOps(project.id, ops, project.version);
    },
    onSuccess: (updated) => queryClient.setQueryData(['project', id], updated),
    onError: async () => { await queryClient.invalidateQueries({ queryKey: ['project', id] }); },
  });
  const sendChat = useMutation({
    mutationFn: (message: string) => api.chat(id, message),
    onMutate: (message) => { setOptimisticMessage(message); setChatText(''); setSelectedPreset(undefined); setLatestTrace(undefined); },
    onSuccess: async (response) => {
      queryClient.setQueryData(['project', id], response.doc);
      setLatestTrace(response.trace ?? []);
      await queryClient.invalidateQueries({ queryKey: ['chat', id] });
    },
    onSettled: () => setOptimisticMessage(undefined),
  });

  async function addMedia(): Promise<void> {
    const picked = await DocumentPicker.getDocumentAsync({ type: ['video/*', 'audio/*'], copyToCacheDirectory: true });
    if (picked.canceled || !project) return;
    setUploading(true);
    try {
      const file = picked.assets[0];
      if (!file) return;
      const asset = await uploadAsset({ uri: file.uri, name: file.name, ...(file.mimeType ? { mimeType: file.mimeType } : {}) });
      const clipId = `clip-${Date.now()}`;
      await apply.mutateAsync([{ type: 'add_clip', params: {
        trackId: 'video-main',
        clip: { id: clipId, assetId: asset.id, start: project.duration, in: 0, out: asset.duration, volume: 1, speed: 1, transform: { scale: 1, x: 0, y: 0 } },
      } }]);
      setSelectedId(clipId);
    } finally {
      setUploading(false);
    }
  }

  /** Any hand-edit that walks the text away from the preset's phrasing deselects the card. */
  function setChatDraft(text: string): void {
    setChatText(text);
    setSelectedPreset((current) => (current !== undefined && text === presetPrompt(current) ? current : undefined));
  }

  function send(): void {
    const message = chatText.trim();
    if (message && !sendChat.isPending) sendChat.mutate(message);
  }

  if (projectQuery.isLoading) return <Screen><Text style={styles.center}>Opening the cutting room…</Text></Screen>;
  if (projectQuery.error || !project) return <Screen><Text style={styles.error}>Could not open this project: {projectQuery.error?.message}</Text></Screen>;
  const compact = width < 820;

  return (
    <Screen scroll={false} header={
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Text style={styles.back}>‹  PROJECTS</Text></Pressable>
        <View style={styles.projectHeading}><Brand compact /><View style={styles.divider} /><View><Text style={styles.projectTitle}>{project.title}</Text><Text style={styles.projectMeta}>{project.format} · {project.fps} FPS · V{project.version}</Text></View></View>
        <GradientButton style={styles.exportButton} onPress={() => router.push({ pathname: '/project/[id]/export', params: { id } })}>export ↗</GradientButton>
      </View>
    }>
      <View style={[styles.workspace, compact && styles.workspaceCompact]}>
        <View style={styles.editColumn}>
          <View style={styles.previewZone}>
            <View style={styles.zoneHeader}><Text style={styles.zoneLabel}>PREVIEW</Text><Text style={styles.timecode}>{formatTime(playhead)} / {formatTime(project.duration)}</Text></View>
            <View style={styles.stage}>
              {selected && selectedAsset ? (
                <ClipPlayer
                  key={`${selected.id}-${selectedAsset.proxyUrl}`}
                  uri={selectedAsset.proxyUrl}
                  clip={selected}
                  onProgress={(sourceTime) => setPlayhead(selected.start + (sourceTime - selected.in) / (selected.speed ?? 1))}
                  onEnd={() => {
                    const next = mediaClips[selectedIndex + 1];
                    if (next) setSelectedId(next.id);
                  }}
                />
              ) : (
                <View style={styles.emptyStage}><Text style={styles.emptyStageIcon}>▶</Text><Text style={styles.emptyStageTitle}>Bring in your first shot</Text><Text style={styles.emptyStageCopy}>Upload media below to start the timeline.</Text></View>
              )}
            </View>
          </View>

          <View style={styles.timelineZone}>
            <View style={styles.zoneHeader}>
              <Text style={styles.zoneLabel}>TIMELINE · {mediaClips.length} CLIPS</Text>
              <View style={styles.zoneActions}>
                <GradientButton secondary style={styles.addButton} onPress={() => setImportOpen(true)}>↓ import test clip</GradientButton>
                <GradientButton secondary style={styles.addButton} onPress={() => void addMedia()} disabled={uploading}>{uploading ? 'processing…' : '+ add media'}</GradientButton>
              </View>
            </View>
            {selected && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actions}>
                <Action label="split" detail="at playhead" onPress={() => apply.mutate([{ type: 'split_clip', params: { clipId: selected.id, at: validSplitAt(selected, playhead), newClipId: `${selected.id}-split-${Date.now()}` } }])} />
                <Action label="trim" detail="0.1s edges" onPress={() => {
                  if (selected.out - selected.in > 0.25) apply.mutate([{ type: 'trim_clip', params: { clipId: selected.id, in: selected.in + 0.1, out: selected.out - 0.1 } }]);
                }} />
                <Action label="volume" detail={`${Math.round((selected.volume ?? 1) * 100)}%`} onPress={() => apply.mutate([{ type: 'set_volume', params: { clipId: selected.id, volume: nextVolume(selected.volume ?? 1) } }])} />
                <Action label="speed" detail={`${selected.speed ?? 1}×`} onPress={() => apply.mutate([{ type: 'set_speed', params: { clipId: selected.id, speed: nextSpeed(selected.speed ?? 1) } }])} />
                <Action danger label="delete" detail="remove clip" onPress={() => apply.mutate([{ type: 'remove_clip', params: { clipId: selected.id } }])} />
              </ScrollView>
            )}
            <View style={styles.trackLabel}><Text style={styles.trackName}>V1</Text><Text style={styles.trackType}>VIDEO</Text></View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.clipStrip}>
              {mediaClips.length === 0 && <Pressable onPress={() => void addMedia()} style={styles.emptyClip}><Text style={styles.emptyClipText}>+ UPLOAD A VIDEO OR AUDIO FILE</Text></Pressable>}
              {mediaClips.map((clip, index) => {
                const asset = clip.assetId ? assetsQuery.data?.[clip.assetId] : undefined;
                const duration = clipTimelineDuration(clip);
                return (
                  <Pressable key={clip.id} onPress={() => { setSelectedId(clip.id); setPlayhead(clip.start); }} style={[styles.clip, { width: Math.max(120, Math.min(240, duration * 42)) }, selected?.id === clip.id && styles.clipSelected]}>
                    {asset && <Image source={{ uri: asset.thumbnailUrl }} style={StyleSheet.absoluteFill} />}
                    <View style={styles.clipShade} />
                    <Text style={styles.clipNumber}>{String(index + 1).padStart(2, '0')}</Text>
                    <Text style={styles.clipDuration}>{duration.toFixed(1)}s</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.trackLabel}><Text style={styles.trackName}>CC</Text><Text style={styles.trackType}>CAPTIONS</Text></View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.captionStrip}>
              {captionClips.length === 0 ? <Text style={styles.noCaptions}>Ask the agent to “add captions”</Text> : captionClips.map((caption) => <View key={caption.id} style={[styles.captionClip, { marginLeft: Math.min(220, caption.start * 16) }]}><Text numberOfLines={1} style={styles.captionText}>{caption.text}</Text></View>)}
            </ScrollView>
            {apply.error && <Text style={styles.error}>{apply.error.message}</Text>}
          </View>

          <InsightsPanel assetIds={assetIds} />
        </View>

        <View style={styles.chatPanel}>
          <View style={styles.chatHeader}><View><Text style={styles.zoneLabel}>EDIT WITH AI</Text><Text style={styles.chatTitle}>Your creative copilot</Text></View><View style={styles.online}><View style={[styles.onlineDot, sendChat.isPending && styles.workingDot]} /><Text style={[styles.onlineText, sendChat.isPending && styles.workingText]}>{sendChat.isPending ? 'WORKING' : 'READY'}</Text></View></View>
          <ScrollView style={styles.messages} contentContainerStyle={styles.messagesContent}>
            {(chatQuery.data?.length ?? 0) === 0 && <AgentIntro />}
            {chatQuery.data?.map((message) => (
              <Message
                key={message.id}
                message={message}
                trace={message.trace ?? (message.id === lastAssistantId ? latestTrace : undefined)}
              />
            ))}
            {optimisticMessage && <Message message={{ id: 'optimistic', role: 'user', content: optimisticMessage, createdAt: '' }} trace={undefined} />}
            {sendChat.isPending && <AgentActivity />}
          </ScrollView>
          <PresetPicker
            selected={selectedPreset}
            onSelect={(preset) => { setChatText(presetPrompt(preset.name)); setSelectedPreset(preset.name); }}
          />
          <View style={styles.prompts}><Prompt text="add bold captions" onPress={setChatDraft} /><Prompt text="remove the silence" onPress={setChatDraft} /><Prompt text="speed this up" onPress={setChatDraft} /></View>
          <View style={styles.inputWrap}>
            <TextInput value={chatText} onChangeText={setChatDraft} onSubmitEditing={send} placeholder="Describe an edit…" placeholderTextColor={colors.muted} multiline style={styles.input} />
            <Pressable onPress={send} disabled={!chatText.trim() || sendChat.isPending} style={styles.send}><Text style={styles.sendText}>↑</Text></Pressable>
          </View>
          {sendChat.error && <Text style={styles.error}>{sendChat.error.message}</Text>}
        </View>
      </View>
      <ImportSheet
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { void queryClient.invalidateQueries({ queryKey: ['project', id] }); }}
      />
    </Screen>
  );
}

function ClipPlayer({ uri, clip, onProgress, onEnd }: { uri: string; clip: Clip; onProgress: (time: number) => void; onEnd: () => void }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.currentTime = clip.in;
    instance.timeUpdateEventInterval = 0.1;
  });
  useEffect(() => {
    const timeSubscription = player.addListener('timeUpdate', ({ currentTime }) => {
      onProgress(currentTime);
      if (currentTime >= clip.out) {
        player.pause();
        onEnd();
      }
    });
    return () => timeSubscription.remove();
  }, [clip.out, onEnd, onProgress, player]);
  return <VideoView player={player} style={styles.video} nativeControls contentFit="contain" />;
}

function Action({ label, detail, onPress, danger }: { label: string; detail: string; onPress: () => void; danger?: boolean }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.action, danger && styles.actionDanger, pressed && styles.pressed]}><Text style={[styles.actionLabel, danger && styles.dangerText]}>{label}</Text><Text style={styles.actionDetail}>{detail}</Text></Pressable>;
}
function Prompt({ text, onPress }: { text: string; onPress: (text: string) => void }) { return <Pressable onPress={() => onPress(text)} style={styles.prompt}><Text style={styles.promptText}>{text}</Text></Pressable>; }
function AgentIntro() { return <View style={styles.agentMessage}><Text style={styles.agentLabel}>EDITIFY</Text><Text style={styles.messageText}>Tell me what the cut should feel like. I’ll translate it into real, reversible timeline operations.</Text></View>; }
function Message({ message, trace }: { message: ChatMessage; trace: AgentTraceStep[] | undefined }) {
  const user = message.role === 'user';
  return (
    <View style={user ? styles.userMessage : styles.agentMessage}>
      <Text style={user ? styles.userLabel : styles.agentLabel}>{user ? 'YOU' : 'EDITIFY'}</Text>
      {!user && trace && trace.length > 0 && <AgentTrace steps={trace} />}
      <Text style={styles.messageText}>{message.content}</Text>
      {message.ops && message.ops.length > 0 && (
        <View style={styles.opChips}>
          {message.ops.map((op, index) => <View key={`${op.type}-${index}`} style={styles.opChip}><Text style={styles.opText}>✓ {op.type.replaceAll('_', ' ')}</Text></View>)}
        </View>
      )}
    </View>
  );
}

function validSplitAt(clip: Clip, playhead: number): number { const end = clip.start + clipTimelineDuration(clip); return playhead > clip.start + 0.05 && playhead < end - 0.05 ? playhead : clip.start + (end - clip.start) / 2; }
function nextVolume(value: number): number { return value > 0.75 ? 0.5 : value > 0.25 ? 0 : 1; }
function nextSpeed(value: number): number { const values = [1, 1.25, 1.5, 2]; const index = values.indexOf(value); return values[(index + 1) % values.length] ?? 1; }
function formatTime(seconds: number): string { const safe = Math.max(0, seconds); return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${Math.floor(safe % 60).toString().padStart(2, '0')}.${Math.floor((safe % 1) * 10)}`; }

const styles = StyleSheet.create({
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  back: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.2 },
  projectHeading: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  divider: { width: 1, height: 28, backgroundColor: colors.border },
  projectTitle: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  projectMeta: { color: colors.muted, fontFamily: 'Montserrat_500Medium', fontSize: 8, marginTop: 3, letterSpacing: 0.5 },
  exportButton: { width: 112, minHeight: 40 },
  workspace: { flex: 1, flexDirection: 'row', gap: 14, minHeight: 0 },
  workspaceCompact: { flexDirection: 'column' },
  editColumn: { flex: 1.75, gap: 12, minWidth: 0 },
  previewZone: { flex: 1.05, minHeight: 250, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: '#101016', padding: 12 },
  zoneHeader: { minHeight: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 },
  zoneLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5 },
  timecode: { color: colors.muted, fontFamily: 'Montserrat_600SemiBold', fontSize: 10 },
  stage: { flex: 1, borderRadius: 14, overflow: 'hidden', backgroundColor: '#050507', alignItems: 'center', justifyContent: 'center' },
  video: { width: '100%', height: '100%' },
  emptyStage: { alignItems: 'center', gap: 8 },
  emptyStageIcon: { color: colors.purple, fontSize: 30 },
  emptyStageTitle: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 15 },
  emptyStageCopy: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 11 },
  timelineZone: { flex: 0.95, minHeight: 290, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 12, gap: 7 },
  zoneActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  addButton: { minHeight: 32, paddingHorizontal: 12, borderColor: colors.border, backgroundColor: colors.panelRaised },
  actions: { gap: 6, paddingVertical: 3 },
  action: { minWidth: 95, borderRadius: 10, backgroundColor: colors.panelRaised, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 7 },
  actionDanger: { borderColor: '#5A2836' },
  actionLabel: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 10 },
  actionDetail: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 8, marginTop: 2 },
  dangerText: { color: colors.danger },
  trackLabel: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 2 },
  trackName: { color: colors.purple, fontFamily: 'Montserrat_800ExtraBold', fontSize: 9 },
  trackType: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1.1 },
  clipStrip: { minHeight: 66, gap: 4, alignItems: 'stretch' },
  clip: { height: 66, borderRadius: 9, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent', justifyContent: 'space-between', padding: 7 },
  clipSelected: { borderColor: colors.purple },
  clipShade: { ...StyleSheet.absoluteFillObject, backgroundColor: '#05040A55' },
  clipNumber: { color: colors.text, fontFamily: 'Montserrat_800ExtraBold', fontSize: 10 },
  clipDuration: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 9, alignSelf: 'flex-end' },
  emptyClip: { width: 280, height: 62, borderRadius: 9, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  emptyClipText: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1 },
  captionStrip: { minHeight: 34, alignItems: 'center' },
  noCaptions: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 10, paddingVertical: 8 },
  captionClip: { width: 150, height: 28, borderRadius: 6, backgroundColor: '#49316F', justifyContent: 'center', paddingHorizontal: 9, marginRight: 4 },
  captionText: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 9 },
  chatPanel: { flex: 0.75, minWidth: 300, minHeight: 400, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 14, gap: 10 },
  chatHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  chatTitle: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 17, marginTop: 5 },
  online: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  onlineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  onlineText: { color: colors.success, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1 },
  workingDot: { backgroundColor: colors.purple },
  workingText: { color: colors.purple },
  messages: { flex: 1 },
  messagesContent: { gap: 10, paddingVertical: 4 },
  agentMessage: { alignSelf: 'stretch', borderRadius: 14, borderTopLeftRadius: 4, backgroundColor: '#201A31', padding: 12, gap: 7 },
  userMessage: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: 14, borderTopRightRadius: 4, backgroundColor: '#30303C', padding: 12, gap: 7 },
  agentLabel: { color: colors.purple, fontFamily: 'Montserrat_800ExtraBold', fontSize: 8, letterSpacing: 1.2 },
  userLabel: { color: colors.muted, fontFamily: 'Montserrat_800ExtraBold', fontSize: 8, letterSpacing: 1.2 },
  messageText: { color: colors.text, fontFamily: 'Montserrat_400Regular', fontSize: 12, lineHeight: 19 },
  opChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  opChip: { backgroundColor: '#372A55', borderRadius: 20, paddingHorizontal: 8, paddingVertical: 4 },
  opText: { color: '#C9B4FF', fontFamily: 'Montserrat_600SemiBold', fontSize: 8 },
  prompts: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  prompt: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 5 },
  promptText: { color: colors.muted, fontFamily: 'Montserrat_500Medium', fontSize: 8 },
  inputWrap: { minHeight: 54, flexDirection: 'row', alignItems: 'flex-end', borderRadius: 15, borderWidth: 1, borderColor: '#484459', backgroundColor: colors.background, padding: 7 },
  input: { flex: 1, minHeight: 38, maxHeight: 90, color: colors.text, fontFamily: 'Montserrat_400Regular', fontSize: 12, paddingHorizontal: 7, paddingTop: 9 },
  send: { width: 38, height: 38, borderRadius: 12, backgroundColor: colors.purple, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: colors.text, fontSize: 20, fontWeight: '700' },
  center: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', textAlign: 'center', marginTop: 120 },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 10 },
  pressed: { opacity: 0.7 },
});
