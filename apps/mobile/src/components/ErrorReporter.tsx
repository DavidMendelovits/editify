import { Component, useEffect, useState, type ErrorInfo, type PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { captureError, startTelemetry, type CapturedError } from '../lib/telemetry';
import { ReportModal } from './ReportModal';
import { colors, radius, space, type, fonts } from '../lib/theme';

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

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the one thing a bare stack trace cannot give us:
    // which screen and which subtree the failure happened inside.
    captureError(error, info.componentStack ?? undefined);
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
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.xl, backgroundColor: colors.background, padding: space.xxl },
  fallbackTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  retry: { minHeight: 36, paddingHorizontal: space.xxl, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  retryText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.lg },
  pressed: { opacity: 0.7 },
});
