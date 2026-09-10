import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type, fonts } from '../lib/theme';
import { describeTraceStep, isReadStep, traceGlyph, type AgentTraceStep } from '../lib/agent';

/** Steps shown before the feed collapses behind a "show all N steps" toggle. */
const COLLAPSE_AFTER = 8;

/**
 * Vertical step feed for one agent turn: a row per tool call, glyph by tool
 * kind, humanized label, and the error text inline on any failed step.
 */
export function AgentTrace({ steps }: { steps: AgentTraceStep[] }) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;

  const collapsible = steps.length > COLLAPSE_AFTER;
  const visible = collapsible && !expanded ? steps.slice(0, COLLAPSE_AFTER) : steps;
  const failures = steps.filter((step) => !step.ok).length;

  return (
    <View style={styles.feed}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>AGENT STEPS · {steps.length}</Text>
        {failures > 0 && <Text style={styles.headerFailures}>{failures} failed</Text>}
      </View>
      {visible.map((step, index) => (
        <TraceRow
          key={`${step.tool}-${index}`}
          step={step}
          last={index === visible.length - 1 && !(collapsible && !expanded)}
        />
      ))}
      {collapsible && (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Text style={styles.toggleText}>
            {expanded ? 'show fewer steps' : `show all ${steps.length} steps`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function TraceRow({ step, last }: { step: AgentTraceStep; last: boolean }) {
  const failed = !step.ok;
  const read = isReadStep(step);
  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        <View style={[styles.bubble, read && styles.bubbleRead, failed && styles.bubbleError]}>
          <Text style={[styles.glyph, read && styles.glyphRead, failed && styles.glyphError]}>{traceGlyph(step)}</Text>
        </View>
        {!last && <View style={styles.railLine} />}
      </View>
      <View style={[styles.body, failed && styles.bodyError]}>
        {/* Thoughts are prose, not a one-liner — give them room and their own voice. */}
        <Text
          style={[styles.label, read && styles.labelRead, step.kind === 'thought' && styles.labelThought, failed && styles.labelError]}
          numberOfLines={step.kind === 'thought' ? 6 : 2}
        >
          {describeTraceStep(step)}
        </Text>
        {failed && step.summary.length > 0 && (
          <Text style={styles.errorText} numberOfLines={3}>{step.summary}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  feed: { gap: space.xs, marginTop: space.xs },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.lg, marginBottom: space.sm },
  headerLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.2 },
  headerFailures: { color: colors.danger, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.8 },
  row: { flexDirection: 'row', gap: space.lg, alignItems: 'stretch' },
  rail: { width: 18, alignItems: 'center' },
  bubble: { width: 18, height: 18, borderRadius: radius.md, backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center' },
  bubbleRead: { backgroundColor: colors.panelRaised },
  bubbleError: { backgroundColor: colors.dangerSoft },
  railLine: { flex: 1, width: 1, minHeight: 6, backgroundColor: colors.borderStrong, marginVertical: space.xs },
  glyph: { color: colors.text, fontFamily: fonts.bold, fontSize: type.sm, lineHeight: 12 },
  glyphRead: { color: colors.muted },
  glyphError: { color: colors.danger },
  body: { flex: 1, paddingBottom: space.md, gap: space.xs },
  bodyError: { borderRadius: radius.md, backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: colors.danger, paddingHorizontal: space.lg, paddingVertical: space.md, marginBottom: space.sm },
  label: { color: colors.text, fontFamily: fonts.medium, fontSize: type.base, lineHeight: 16 },
  labelRead: { color: colors.muted },
  labelThought: { color: colors.muted, fontFamily: fonts.regular, fontStyle: 'italic' },
  labelError: { color: colors.danger, fontFamily: fonts.semibold },
  errorText: { color: colors.danger, fontFamily: fonts.regular, fontSize: type.md, lineHeight: 14 },
  toggle: { alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.sm, marginTop: space.xs },
  toggleText: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.6 },
  pressed: { opacity: 0.7 },
});
