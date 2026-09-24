import { useState } from 'react';
import { KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation } from '@tanstack/react-query';
import { Button } from './Button';
import { ScreenshotField } from './ScreenshotField';
import { annotate, describeHighlight, type HighlightRect, type Screenshot } from '../lib/capture';
import { describeAttachments, sendReport } from '../lib/telemetry';
import { colors, radius, space, type, fonts } from '../lib/theme';

interface Props {
  mode: 'error' | 'feedback';
  /** Present in error mode — what the crash actually was. */
  error?: { message: string; stack?: string; componentStack?: string };
  /**
   * Taken by the caller before this sheet covered the screen, so it shows what
   * the user was looking at. Held here and sent only if they attach it.
   */
  screenshot?: Screenshot;
  onClose: () => void;
}

/**
 * The one place a report leaves the client: a crash we caught, or feedback the
 * user opened themselves. Both send the same payload, and both end by showing
 * the issue the server filed — or the note explaining where it went instead.
 */
export function ReportModal({ mode, error, screenshot, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [comment, setComment] = useState('');
  const [attached, setAttached] = useState(false);
  const [highlight, setHighlight] = useState<HighlightRect>();
  const report = useMutation({
    mutationFn: async () => {
      // The highlight is burned into the image here rather than on the server,
      // so what the issue shows is exactly what the user drew.
      const shot = attached && screenshot
        ? (highlight ? await annotate(screenshot, highlight) : screenshot)
        : undefined;
      // Resolved against the element index taken with the shot, not the live
      // DOM: this sheet is on top of the app by now.
      const target = attached && highlight && screenshot ? describeHighlight(highlight, screenshot.elements) : undefined;
      return await sendReport(mode, {
        ...(error ? { error } : {}),
        ...(comment.trim() ? { feedback: comment.trim() } : {}),
        ...(shot ? {
          screenshot: {
            data: shot.data,
            width: shot.width,
            height: shot.height,
            ...(highlight ? { highlight } : {}),
            ...(target ? { highlightTarget: target } : {}),
          },
        } : {}),
      });
    },
  });
  const receipt = report.data;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          style={[styles.backdrop, { paddingTop: space.xxl + insets.top, paddingBottom: space.xxl + insets.bottom }]}
          onPress={onClose}
          accessibilityLabel="close report"
        >
          <Pressable style={[styles.sheet, mode === 'error' && styles.sheetError]} onPress={() => undefined}>
            <ScrollView
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
              <Text style={[styles.eyebrow, mode === 'error' && styles.eyebrowError]}>
                {mode === 'error' ? 'SOMETHING BROKE' : 'SEND FEEDBACK'}
              </Text>
              <Text style={styles.title}>
                {mode === 'error' ? 'Editify hit an error.' : 'What should we change?'}
              </Text>
              {mode === 'error' && error && <Text style={styles.message} numberOfLines={3}>{error.message}</Text>}

              {receipt ? (
                <>
                  <Text style={styles.subtitle}>{receipt.note}</Text>
                  {receipt.issueNumber !== null && receipt.issueUrl && (
                    <Pressable accessibilityRole="link" onPress={() => { Linking.openURL(receipt.issueUrl as string).catch(() => undefined); }}>
                      <Text style={styles.issue}>issue #{receipt.issueNumber} ↗</Text>
                    </Pressable>
                  )}
                  <Button onPress={onClose}>done</Button>
                </>
              ) : (
                <>
                  <Text style={styles.subtitle}>
                    {mode === 'error'
                      ? 'Send it over and we will open a tracked issue. Add anything you were doing (optional).'
                      : 'Tell us what is missing or wrong. We assess it and open a tracked issue.'}
                  </Text>
                  <TextInput
                    value={comment}
                    onChangeText={setComment}
                    placeholder={mode === 'error' ? 'What were you doing? (optional)' : 'Describe the change…'}
                    placeholderTextColor={colors.muted}
                    multiline
                    style={styles.input}
                  />
                  {screenshot && (
                    <ScreenshotField
                      shot={screenshot}
                      attached={attached}
                      onAttachedChange={setAttached}
                      {...(highlight ? { highlight } : {})}
                      onHighlight={setHighlight}
                    />
                  )}
                  {/* Say what rides along, so nobody has to guess what they just sent. */}
                  <Text style={styles.attachments}>Attached: {describeAttachments(attached)}</Text>
                  {report.error && <Text style={styles.error}>{report.error.message}</Text>}
                  <View style={styles.actions}>
                    <Button secondary style={styles.dismiss} onPress={onClose}>dismiss</Button>
                    <Button
                      style={styles.send}
                      disabled={report.isPending || (mode === 'feedback' && !comment.trim())}
                      onPress={() => report.mutate()}
                    >
                      {report.isPending ? 'sending…' : 'report'}
                    </Button>
                  </View>
                </>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: '#04040899', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xxl },
  sheet: { width: '100%', maxWidth: 460, maxHeight: '90%', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  sheetContent: { padding: space.xxl, gap: space.lg },
  sheetError: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  eyebrow: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.sm, letterSpacing: 1.5 },
  eyebrowError: { color: colors.danger },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.title },
  message: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.base, lineHeight: 17 },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 19 },
  input: {
    minHeight: 84, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised,
    color: colors.text, fontFamily: fonts.regular, fontSize: type.lg, padding: space.xl, textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', gap: space.lg, marginTop: space.xs },
  dismiss: { flex: 1, borderColor: colors.border },
  send: { flex: 1 },
  issue: { color: colors.accent, fontFamily: fonts.bold, fontSize: type.lg },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.base },
  attachments: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, lineHeight: 15 },
});
