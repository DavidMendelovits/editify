import { useEffect, useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deviceWords } from '../lib/device-runtime';
import { deferredVisible, useOtherModalBusy } from '../lib/modal-presence';
import { SPEECH_OFF_DETAIL, SPEECH_OFF_TEXT, SPEECH_PROMPT_TEXT, SPEECH_PROMPT_TITLE, type WordsView } from '../lib/device-words';
import { track } from '../lib/telemetry';
import { colors, fonts, radius, space, type } from '../lib/theme';
import { Button } from './Button';

function useWordsView(): WordsView {
  const [view, setView] = useState<WordsView>(() => deviceWords?.view() ?? { prompt: false, speechOff: false });
  useEffect(() => deviceWords?.subscribe(setView), []);
  return view;
}

/**
 * The speech pre-prompt (C15) and the speech-off receipt (D21), over whatever screen is up.
 * The sheet comes after an import whose words came back not asked while the speech question
 * is unanswered; Continue shows the system alert, Not now asks again next import. It waits
 * while ImportSheet or SoundSheet is up (modal-presence): iOS won't present it over them.
 */
export function SpeechPrompt() {
  const view = useWordsView();
  const otherModalBusy = useOtherModalBusy();
  const prompt = deferredVisible(view.prompt, otherModalBusy);
  const insets = useSafeAreaInsets();
  const words = deviceWords;
  if (!words) return null;
  return (
    <>
      <Modal visible={prompt} transparent animationType="slide" onRequestClose={() => words.notNow()}>
        <View style={styles.backdrop}>
          <View testID="speech-prompt" accessibilityViewIsModal style={[styles.sheet, { paddingBottom: space.xxl + insets.bottom }]}>
            <Text style={styles.kicker}>CAPTIONS</Text>
            <Text style={styles.title}>{SPEECH_PROMPT_TITLE}</Text>
            <Text style={styles.body}>{SPEECH_PROMPT_TEXT}</Text>
            <View style={styles.actions}>
              <Button secondary style={styles.action} accessibilityLabel="not now" onPress={() => { track('speech_prompt', 'not-now'); words.notNow(); }}>not now</Button>
              <Button style={styles.action} accessibilityLabel="continue" onPress={() => { track('speech_prompt', 'continue'); void words.continuePrompt(); }}>continue</Button>
            </View>
          </View>
        </View>
      </Modal>
      {view.speechOff && !view.prompt && (
        <View testID="speech-off" accessibilityRole="summary" style={[styles.receipt, { bottom: space.xl + insets.bottom }]}>
          <View style={styles.receiptText}>
            <Text style={styles.receiptTitle}>{SPEECH_OFF_TEXT}</Text>
            <Text style={styles.receiptDetail}>{SPEECH_OFF_DETAIL}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="open settings" onPress={() => void Linking.openSettings()} style={({ pressed }) => [styles.settings, pressed && styles.pressed]}>
            <Text style={styles.settingsText}>SETTINGS</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="dismiss speech notice" hitSlop={8} onPress={() => words.dismissSpeechOff()} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
            <Text style={styles.closeGlyph}>✕</Text>
          </Pressable>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { gap: space.lg, padding: space.xxl, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  kicker: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  body: { color: colors.text, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: space.lg, marginTop: space.md },
  action: { flex: 1, minHeight: 44 },
  receipt: {
    position: 'absolute', left: space.xl, right: space.xl, flexDirection: 'row', alignItems: 'center', gap: space.lg,
    padding: space.xl, borderRadius: radius.md, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border,
  },
  receiptText: { flex: 1, minWidth: 0, gap: space.sm },
  receiptTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.md },
  receiptDetail: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md },
  settings: { minHeight: 36, justifyContent: 'center', paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent },
  settingsText: { color: colors.accent, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.2 },
  close: { padding: space.sm },
  closeGlyph: { color: colors.muted, fontSize: type.md },
  pressed: { opacity: 0.7 },
});
