import { useContext, useEffect, useRef, useState } from 'react';
import { Keyboard, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { VideoView, useVideoPlayer } from 'expo-video';
import { AgentActivity } from '../AgentActivity';
import { AgentTrace } from '../AgentTrace';
import { PresetPicker } from '../PresetPicker';
import { ScreenScroll } from '../Screen';
import { Markdown } from './Markdown';
import { api, rebaseServerUrl, type ChatMessage, type RenderRecord } from '../../lib/api';
import { receiptItems, type AgentTraceStep } from '../../lib/agent';
import { presetPrompt } from '../../lib/presets';
import { sensitive } from '../../lib/sensitive';
import { colors, radius, space, type, fonts } from '../../lib/theme';

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
  // The improver's suggestion, held until the user picks: nothing is ever sent
  // behind their back (issue #19 — "never silently rewrites and sends").
  const [suggestion, setSuggestion] = useState<{ original: string; improved: string; changes: string[] }>();
  const [improving, setImproving] = useState(false);
  const scroller = useRef<ScrollView>(null);
  const screenScroll = useContext(ScreenScroll);
  const composerBlock = useRef<View>(null);
  const composing = useRef(false);
  const lastUserMessage = [...(messages ?? [])].reverse().find((message) => message.role === 'user')?.content;

  function draft(next: string): void {
    setText(next);
    setPreset((current) => (current !== undefined && next === presetPrompt(current) ? current : undefined));
  }
  function dispatch(message: string): void {
    onSend(message);
    setText('');
    setPreset(undefined);
    setSuggestion(undefined);
  }
  function send(): void {
    const message = text.trim();
    if (!message || pending || improving) return;
    setImproving(true);
    // A failed improve must never block the edit: fall through to the raw send.
    api.improvePrompt(projectId, message, lastUserMessage)
      .then((result) => {
        if (result.improved) setSuggestion({ original: message, improved: result.improved, changes: result.changes ?? [] });
        else dispatch(message);
      })
      .catch(() => dispatch(message))
      .finally(() => setImproving(false));
  }

  // Stacked on iOS, UIKit lifts only the caret above the keyboard, leaving the
  // composer's border and the error line under it (issue #111). Once the
  // keyboard is up, lift the whole block clear. Wide mode has no screen scroll
  // (its KeyboardAvoidingView already does this) and Android resizes instead.
  useEffect(() => {
    if (Platform.OS !== 'ios' || !screenScroll) return;
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      const scroll = screenScroll.current;
      const block = composerBlock.current;
      if (!composing.current || !scroll || !block) return;
      // The helper assumes the scroll view starts at the top of the window, so
      // its real top goes in the offset, plus a little air above the keyboard.
      scroll.getNativeScrollRef()?.measureInWindow((_x, top) => {
        scroll.scrollResponderScrollNativeHandleToKeyboard(block, top + space.xl, true);
      });
    });
    return () => subscription.remove();
  }, [screenScroll]);

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View>
          <Text style={styles.zoneLabel}>AGENT</Text>
          <Text style={styles.title}>Editor</Text>
        </View>
        <View style={styles.status}>
          <View style={[styles.dot, pending && styles.dotWorking]} />
          <Text style={[styles.statusText, pending && styles.statusWorking]}>{pending ? 'WORKING' : 'READY'}</Text>
        </View>
      </View>

      <ScrollView
        ref={scroller}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        // Without this, Android refuses to scroll a vertical list nested in the
        // stacked layout's outer ScrollView.
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
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
      {/* The keyboard is handled by Screen: stacked, this dock sits in the
          screen's scroll view, and wide it sits in its KeyboardAvoidingView. */}
      <View ref={composerBlock} style={styles.composerLayer}>
        {suggestion && (
          <ImprovedPrompt
            suggestion={suggestion}
            onChange={(improved) => setSuggestion((current) => (current ? { ...current, improved } : current))}
            onUse={() => dispatch(suggestion.improved.trim() || suggestion.original)}
            onOriginal={() => dispatch(suggestion.original)}
            onDismiss={() => setSuggestion(undefined)}
          />
        )}
        <View style={styles.composer}>
          <TextInput
            value={text}
            onChangeText={draft}
            onFocus={() => { composing.current = true; }}
            onBlur={() => { composing.current = false; }}
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
            disabled={!text.trim() || pending || improving}
            style={({ pressed }) => [styles.send, pressed && styles.pressed, (!text.trim() || pending || improving) && styles.sendDisabled]}
          >
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        </View>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </View>
  );
}

/**
 * The improver's preview, wedged between the prompt chips and the composer:
 * the rewritten instruction is editable in place, and nothing leaves the
 * client until the user picks "use this", "send original", or dismisses.
 */
function ImprovedPrompt({ suggestion, onChange, onUse, onOriginal, onDismiss }: {
  suggestion: { original: string; improved: string; changes: string[] };
  onChange: (improved: string) => void;
  onUse: () => void;
  onOriginal: () => void;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.improve}>
      <View style={styles.improveHead}>
        <Text style={styles.improveLabel}>IMPROVED PROMPT</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="dismiss improved prompt" hitSlop={8} onPress={onDismiss}>
          <Text style={styles.improveClose}>✕</Text>
        </Pressable>
      </View>
      {suggestion.changes.map((change) => (
        <Text key={change} style={styles.improveChange}>• {change}</Text>
      ))}
      <TextInput
        value={suggestion.improved}
        onChangeText={onChange}
        multiline
        accessibilityLabel="improved prompt text"
        style={styles.improveInput}
      />
      <View style={styles.improveActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="use this"
          onPress={onUse}
          style={({ pressed }) => [styles.improveUse, pressed && styles.pressed]}
        >
          <Text style={styles.improveUseText}>use this</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="send original"
          onPress={onOriginal}
          style={({ pressed }) => [styles.improveOriginal, pressed && styles.pressed]}
        >
          <Text style={styles.improveOriginalText}>send original</Text>
        </Pressable>
      </View>
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
        <Text style={styles.renderLabel} numberOfLines={1}>
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
      <View {...sensitive}>
        {user ? <Text style={styles.messageText}>{message.content}</Text> : <Markdown text={message.content} />}
      </View>
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
  // On short viewports the dock's content spills past its box; the collapsed summary
  // panels below it in the column would otherwise paint over the composer and improver card.
  panel: { flex: 1, minHeight: 470, overflow: 'hidden', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.xl, gap: space.lg, zIndex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: space.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  zoneLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl, marginTop: space.sm },
  status: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: radius.md, backgroundColor: colors.success },
  dotWorking: { backgroundColor: colors.accent },
  statusText: { color: colors.success, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1 },
  statusWorking: { color: colors.accent },
  messages: { flex: 1, minHeight: 60 },
  messagesContent: { gap: space.lg, paddingVertical: space.sm },
  agentMessage: { alignSelf: 'stretch', borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: space.lg, paddingVertical: space.xs, gap: space.md },
  userMessage: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: radius.md, backgroundColor: colors.panelRaised, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  agentLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.2 },
  userLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.2 },
  messageText: { color: colors.text, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 18 },
  opChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  opChip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.xs },
  opText: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.xs },
  revert: { alignSelf: 'flex-start', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space.lg, paddingVertical: space.sm },
  revertDisabled: { opacity: 0.45 },
  revertText: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.sm },
  render: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, padding: space.lg, gap: space.lg },
  renderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.lg },
  renderLabel: { flexShrink: 1, color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.2 },
  renderButton: { flexShrink: 0, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: space.lg, paddingVertical: space.sm },
  renderButtonText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.sm },
  renderPreview: { gap: space.md },
  renderVideo: { width: '100%', height: 150, borderRadius: radius.md, backgroundColor: '#000000' },
  renderLink: { alignSelf: 'flex-start' },
  renderLinkText: { color: colors.success, fontFamily: fonts.bold, fontSize: type.sm },
  prompts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  prompt: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  promptText: { color: colors.text, fontFamily: fonts.medium, fontSize: type.sm },
  improve: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accentSoft, padding: space.lg, gap: space.sm },
  composerLayer: { gap: space.lg },
  improveHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  improveLabel: { color: colors.accent, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.4 },
  improveClose: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.base },
  improveChange: { color: colors.text, fontFamily: fonts.medium, fontSize: type.sm, lineHeight: 13 },
  improveInput: { color: colors.text, fontFamily: fonts.regular, fontSize: type.base, lineHeight: 16, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, padding: space.md, maxHeight: 120 },
  improveActions: { flexDirection: 'row', gap: space.md },
  improveUse: { borderRadius: radius.md, backgroundColor: colors.accentStrong, paddingHorizontal: space.xl, paddingVertical: space.sm },
  improveUseText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.sm },
  improveOriginal: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space.xl, paddingVertical: space.sm },
  improveOriginalText: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.sm },
  composer: { minHeight: 50, flexDirection: 'row', alignItems: 'flex-end', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background, padding: space.md },
  input: { flex: 1, minHeight: 34, maxHeight: 90, color: colors.text, fontFamily: fonts.regular, fontSize: type.lg, paddingHorizontal: space.md, paddingTop: space.lg },
  send: { width: 30, height: 30, borderRadius: radius.md, backgroundColor: colors.accentStrong, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.text, fontSize: type.xxl, fontWeight: '700' },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.md },
  pressed: { opacity: 0.7 },
});
