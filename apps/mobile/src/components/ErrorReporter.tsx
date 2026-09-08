import { Component, useEffect, useState, type PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { captureError, startTelemetry } from '../lib/telemetry';
import { ReportModal } from './ReportModal';
import { colors, fonts } from '../lib/theme';

interface CapturedError { message: string; stack?: string }

/**
 * A render error takes its whole subtree with it, so the boundary swaps in a
 * retry card. The report prompt itself lives above the boundary — it has to
 * outlive the tree that crashed.
 */
class ErrorBoundary extends Component<PropsWithChildren, { crashed: boolean }> {
  override state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: Error): void {
    captureError(error);
  }

  override render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackTitle}>This screen stopped.</Text>
        <Pressable accessibilityRole="button" onPress={() => this.setState({ crashed: false })} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
          <Text style={styles.retryText}>try again</Text>
        </Pressable>
      </View>
    );
  }
}

/**
 * Session tracking plus every route an error reaches us by: uncaught JS errors,
 * unhandled rejections, and React render failures. Any of them opens the report
 * modal, which the user can send with a comment or dismiss.
 */
export function ErrorReporter({ children }: PropsWithChildren) {
  const [error, setError] = useState<CapturedError>();

  useEffect(() => startTelemetry(setError), []);

  return (
    <>
      <ErrorBoundary>{children}</ErrorBoundary>
      {error && <ReportModal mode="error" error={error} onClose={() => setError(undefined)} />}
    </>
  );
}

const styles = StyleSheet.create({
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: colors.background, padding: 24 },
  fallbackTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: 17 },
  retry: { minHeight: 44, paddingHorizontal: 18, borderRadius: 14, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  retryText: { color: colors.text, fontFamily: fonts.bold, fontSize: 13 },
  pressed: { opacity: 0.7 },
});
