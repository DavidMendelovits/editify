import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { VideoView, useVideoPlayer } from 'expo-video';
import { AgentActivity } from '../AgentActivity';
import { AgentTrace } from '../AgentTrace';
import { PresetPicker } from '../PresetPicker';
import { Markdown } from './Markdown';
import { ProviderPicker } from './ProviderPicker';
import { api, rebaseServerUrl, type ChatMessage, type RenderRecord } from '../../lib/api';
import { receiptItems, type AgentTraceStep } from '../../lib/agent';
import { presetPrompt } from '../../lib/presets';
import { colors } from '../../lib/theme';

const QUICK_PROMPTS = ['add bold captions', 'remove the silence', 'punch in on the hook', 'tighten the ending'];

interface Props {
  projectId: string;
  messages: ChatMessage[] | undefined;
  /** Trace for the newest assistant turn before the chat history refetches. */
  latestTrace: AgentTraceStep[] | undefined;
  latestAssistantId: string | undefined;
  /** Steps of the turn still running, polled from `/chat/live`; replaced by `latestTrace` when it lands. */
  liveTrace: AgentTraceStep[] | undefined;
  optimisticMessage: string | undefined;
  pending: boolean;
  error: string | undefined;
  onSend: (message: string) => void;
  /** Undo a whole agent turn from the reply it produced. */
  onRevert: (runId: string) => void;
  reverting: boolean;
  /** Jump the playhead — receipt chips seek to where their edit landed. */
  onSeek: (time: number) => void;
}

/**
 * Right-hand dock: full chat history with expandable agent traces, preset
 * chips, the composer, and the render strip. The project query is refreshed by
 * the parent when a turn lands, so the timeline animates itself.
 */
export function ChatDock({ projectId, messages, latestTrace, latestAssistantId, liveTrace, optimisticMessage, pending, error, onSend, onRevert, reverting, onSeek }: Props) {
  const [text, setText] = useState('');
  const [preset, setPreset] = useState<string>();
  const scroller = useRef<ScrollView>(null);

  function draft(next: string): void {
    setText(next);
    setPreset((current) => (current !== undefined && next === presetPrompt(current) ? current : undefined));
  }
  function send(): void {
    const message = text.trim();
    if (!message || pending) return;
    onSend(message);
    setText('');
    setPreset(undefined);
  }

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View>
          <Text style={styles.zoneLabel}>EDIT WITH AI</Text>
          <Text style={styles.title}>Your creative copilot</Text>
        </View>
        <View style={styles.status}>
          <View style={[styles.dot, pending && styles.dotWorking]} />
          <Text style={[styles.statusText, pending && styles.statusWorking]}>{pending ? 'WORKING' : 'READY'}</Text>
        </View>
      </View>
      <ProviderPicker />

      <ScrollView
        ref={scroller}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        // Without this, Android refuses to scroll a vertical list nested in the
        // stacked layout's outer ScrollView.
        nestedScrollEnabled
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
      >
        {(messages?.length ?? 0) === 0 && !optimisticMessage && (
          <View style={styles.agentMessage}>
            <Text style={styles.agentLabel}>EDITIFY</Text>
            <Text style={styles.messageText}>
              Tell me what the cut should feel like. I’ll translate it into real, reversible timeline operations.
            </Text>
          </View>
        )}
        {messages?.map((message) => (
          <Message
            key={message.id}
            message={message}
            trace={message.trace ?? (message.id === latestAssistantId ? latestTrace : undefined)}
            onRevert={onRevert}
            reverting={reverting}
            onSeek={onSeek}
          />
        ))}
        {optimisticMessage && (
          <Message
            message={{ id: 'optimistic', role: 'user', content: optimisticMessage, createdAt: '' }}
            trace={undefined}
            onRevert={onRevert}
            reverting={reverting}
            onSeek={onSeek}
          />
        )}
        {pending && <AgentActivity {...(liveTrace?.length ? { latestStep: liveTrace[liveTrace.length - 1] } : {})} />}
        {pending && liveTrace && liveTrace.length > 0 && (
          <View style={styles.agentMessage}><AgentTrace steps={liveTrace} /></View>
        )}
      </ScrollView>

      <RenderStrip projectId={projectId} />
      <PresetPicker selected={preset} onSelect={(item) => { setText(presetPrompt(item.name)); setPreset(item.name); }} />
      <View style={styles.prompts}>
        {QUICK_PROMPTS.map((prompt) => (
          <Pressable key={prompt} onPress={() => draft(prompt)} style={({ pressed }) => [styles.prompt, pressed && styles.pressed]}>
            <Text style={styles.promptText}>{prompt}</Text>
          </Pressable>
        ))}
      </View>
      {/* Keeps the composer above the software keyboard on phones. */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={80}>
        <View style={styles.composer}>
          <TextInput
            value={text}
            onChangeText={draft}
            onSubmitEditing={send}
            blurOnSubmit
            placeholder="Describe an edit…"
            placeholderTextColor={colors.muted}
            multiline
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="send"
            hitSlop={6}
            onPress={send}
            disabled={!text.trim() || pending}
            style={({ pressed }) => [styles.send, pressed && styles.pressed, (!text.trim() || pending) && styles.sendDisabled]}
          >
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** Inline render: start a 1080p master, poll it, then play the result in place. */
function RenderStrip({ projectId }: { projectId: string }) {
  const [renderId, setRenderId] = useState<string>();
  const start = useMutation({
    mutationFn: () => api.render(projectId, '1080p'),
    onSuccess: (record: RenderRecord) => setRenderId(record.id),
  });
  const record = useQuery({
    queryKey: ['render', renderId],
    queryFn: () => api.getRender(renderId as string),
    enabled: Boolean(renderId),
    refetchInterval: (query) => (query.state.data?.status === 'done' || query.state.data?.status === 'error' ? false : 1200),
  });
  const status = record.data?.status ?? (start.isPending ? 'queued' : undefined);
  const outputUrl = record.data?.outputUrl;

  return (
    <View style={styles.render}>
      <View style={styles.renderRow}>
        <Text style={styles.renderLabel}>
          {status === undefined ? 'EXPORT' : status === 'done' ? 'MASTER READY' : `RENDERING · ${status.toUpperCase()}`}
        </Text>
        <Pressable
          onPress={() => { setRenderId(undefined); start.mutate(); }}
          disabled={start.isPending || (status !== undefined && status !== 'done' && status !== 'error')}
          style={({ pressed }) => [styles.renderButton, pressed && styles.pressed]}
        >
          <Text style={styles.renderButtonText}>{status === 'done' ? 'render again' : 'render 1080p'}</Text>
        </Pressable>
      </View>
      {status === 'done' && outputUrl && <RenderPreview url={rebaseServerUrl(outputUrl) as string} />}
      {record.data?.error && <Text style={styles.error}>{record.data.error}</Text>}
      {start.error && <Text style={styles.error}>{start.error.message}</Text>}
    </View>
  );
}

function RenderPreview({ url }: { url: string }) {
  const player = useVideoPlayer(url);
  return (
    <View style={styles.renderPreview}>
      <VideoView player={player} style={styles.renderVideo} contentFit="contain" nativeControls />
      <Pressable onPress={() => void Linking.openURL(url)} style={({ pressed }) => [styles.renderLink, pressed && styles.pressed]}>
        <Text style={styles.renderLinkText}>{Platform.OS === 'web' ? 'open master ↗' : 'download master ↗'}</Text>
      </Pressable>
    </View>
  );
}

function Message({ message, trace, onRevert, reverting, onSeek }: {
  message: ChatMessage;
  trace: AgentTraceStep[] | undefined;
  onRevert: (runId: string) => void;
  reverting: boolean;
  onSeek: (time: number) => void;
}) {
  const user = message.role === 'user';
  const runId = !user && message.ops?.length ? message.runId : undefined;
  const receipt = !user && message.ops?.length ? receiptItems(message.ops) : [];
  return (
    <View style={user ? styles.userMessage : styles.agentMessage}>
      <Text style={user ? styles.userLabel : styles.agentLabel}>{user ? 'YOU' : 'EDITIFY'}</Text>
      {!user && trace && trace.length > 0 && <AgentTrace steps={trace} />}
      {user ? <Text style={styles.messageText}>{message.content}</Text> : <Markdown text={message.content} />}
      {receipt.length > 0 && (
        <View style={styles.opChips}>
          {receipt.map((item) => (
            <Pressable
              key={item.label}
              disabled={item.at === undefined}
              onPress={() => item.at !== undefined && onSeek(item.at)}
              style={({ pressed }) => [styles.opChip, pressed && styles.pressed]}
            >
              <Text style={styles.opText}>{item.glyph} {item.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {runId && (
        <Pressable
          accessibilityRole="button"
          onPress={() => onRevert(runId)}
          disabled={reverting || message.reverted}
          style={({ pressed }) => [styles.revert, pressed && styles.pressed, (reverting || message.reverted) && styles.revertDisabled]}
        >
          <Text style={styles.revertText}>{message.reverted ? 'Reverted' : '↩ Revert'}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 380, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 12, gap: 9 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 9, borderBottomWidth: 1, borderBottomColor: colors.border },
  zoneLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5 },
  title: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 16, marginTop: 4 },
  status: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  dotWorking: { backgroundColor: colors.purple },
  statusText: { color: colors.success, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1 },
  statusWorking: { color: colors.purple },
  messages: { flex: 1, minHeight: 120 },
  messagesContent: { gap: 9, paddingVertical: 4 },
  agentMessage: { alignSelf: 'stretch', borderRadius: 12, borderTopLeftRadius: 3, backgroundColor: '#201A31', padding: 11, gap: 6 },
  userMessage: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: 12, borderTopRightRadius: 3, backgroundColor: '#30303C', padding: 11, gap: 6 },
  agentLabel: { color: colors.purple, fontFamily: 'Montserrat_800ExtraBold', fontSize: 8, letterSpacing: 1.2 },
  userLabel: { color: colors.muted, fontFamily: 'Montserrat_800ExtraBold', fontSize: 8, letterSpacing: 1.2 },
  messageText: { color: colors.text, fontFamily: 'Montserrat_400Regular', fontSize: 12, lineHeight: 18 },
  opChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  opChip: { backgroundColor: '#372A55', borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  opText: { color: '#C9B4FF', fontFamily: 'Montserrat_600SemiBold', fontSize: 8 },
  revert: { alignSelf: 'flex-start', borderRadius: 7, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 9, paddingVertical: 4 },
  revertDisabled: { opacity: 0.45 },
  revertText: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9 },
  render: { borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, padding: 8, gap: 8 },
  renderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  renderLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1.2 },
  renderButton: { borderRadius: 7, borderWidth: 1, borderColor: colors.purple, paddingHorizontal: 9, paddingVertical: 4 },
  renderButtonText: { color: '#C9B4FF', fontFamily: 'Montserrat_700Bold', fontSize: 9 },
  renderPreview: { gap: 6 },
  renderVideo: { width: '100%', height: 150, borderRadius: 8, backgroundColor: '#000000' },
  renderLink: { alignSelf: 'flex-start' },
  renderLinkText: { color: colors.success, fontFamily: 'Montserrat_700Bold', fontSize: 9 },
  prompts: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  prompt: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 4 },
  promptText: { color: colors.muted, fontFamily: 'Montserrat_500Medium', fontSize: 8 },
  composer: { minHeight: 50, flexDirection: 'row', alignItems: 'flex-end', borderRadius: 13, borderWidth: 1, borderColor: '#484459', backgroundColor: colors.background, padding: 6 },
  input: { flex: 1, minHeight: 34, maxHeight: 90, color: colors.text, fontFamily: 'Montserrat_400Regular', fontSize: 12, paddingHorizontal: 7, paddingTop: 8 },
  send: { width: 34, height: 34, borderRadius: 11, backgroundColor: colors.purple, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 10 },
  pressed: { opacity: 0.7 },
});
