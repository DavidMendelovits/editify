import { useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { GradientButton } from './GradientButton';
import { sendReport } from '../lib/telemetry';
import { colors, fonts } from '../lib/theme';

interface Props {
  mode: 'error' | 'feedback';
  /** Present in error mode — what the crash actually was. */
  error?: { message: string; stack?: string };
  onClose: () => void;
}

/**
 * The one place a report leaves the client: a crash we caught, or feedback the
 * user opened themselves. Both send the same payload, and both end by showing
 * the issue the server filed — or the note explaining where it went instead.
 */
export function ReportModal({ mode, error, onClose }: Props) {
  const [comment, setComment] = useState('');
  const report = useMutation({
    mutationFn: () => sendReport(mode, {
      ...(error ? { error } : {}),
      ...(comment.trim() ? { feedback: comment.trim() } : {}),
    }),
  });
  const receipt = report.data;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="close report">
        <Pressable style={[styles.sheet, mode === 'error' && styles.sheetError]} onPress={() => undefined}>
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
              <GradientButton onPress={onClose}>done</GradientButton>
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
              {report.error && <Text style={styles.error}>{report.error.message}</Text>}
              <View style={styles.actions}>
                <GradientButton secondary style={styles.dismiss} onPress={onClose}>dismiss</GradientButton>
                <GradientButton
                  style={styles.send}
                  disabled={report.isPending || (mode === 'feedback' && !comment.trim())}
                  onPress={() => report.mutate()}
                >
                  {report.isPending ? 'sending…' : 'report'}
                </GradientButton>
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#04040899', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { width: '100%', maxWidth: 460, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 20, gap: 10 },
  sheetError: { borderColor: colors.danger, backgroundColor: '#221420' },
  eyebrow: { color: colors.purple, fontFamily: fonts.bold, fontSize: 9, letterSpacing: 1.5 },
  eyebrowError: { color: colors.danger },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 19 },
  message: { color: colors.danger, fontFamily: fonts.medium, fontSize: 11, lineHeight: 17 },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: 12, lineHeight: 19 },
  input: {
    minHeight: 84, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised,
    color: colors.text, fontFamily: fonts.regular, fontSize: 13, padding: 12, textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', gap: 10, marginTop: 2 },
  dismiss: { flex: 1, borderColor: colors.border },
  send: { flex: 1 },
  issue: { color: colors.purple, fontFamily: fonts.bold, fontSize: 13 },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: 11 },
});
