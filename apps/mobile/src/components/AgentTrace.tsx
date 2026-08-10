import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../lib/theme';
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
        <Text style={[styles.label, read && styles.labelRead, failed && styles.labelError]} numberOfLines={2}>
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
  feed: { gap: 2, marginTop: 2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  headerLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1.2 },
  headerFailures: { color: colors.danger, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 0.8 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  rail: { width: 18, alignItems: 'center' },
  bubble: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#372A55', alignItems: 'center', justifyContent: 'center' },
  bubbleRead: { backgroundColor: '#252135' },
  bubbleError: { backgroundColor: '#43202B' },
  railLine: { flex: 1, width: 1, minHeight: 6, backgroundColor: '#3B3752', marginVertical: 2 },
  glyph: { color: '#C9B4FF', fontFamily: 'Montserrat_700Bold', fontSize: 9, lineHeight: 12 },
  glyphRead: { color: colors.muted },
  glyphError: { color: colors.danger },
  body: { flex: 1, paddingBottom: 7, gap: 3 },
  bodyError: { borderRadius: 8, backgroundColor: '#3A1B24', borderWidth: 1, borderColor: '#5A2836', paddingHorizontal: 8, paddingVertical: 6, marginBottom: 5 },
  label: { color: colors.text, fontFamily: 'Montserrat_500Medium', fontSize: 11, lineHeight: 16 },
  labelRead: { color: colors.muted },
  labelError: { color: colors.danger, fontFamily: 'Montserrat_600SemiBold' },
  errorText: { color: '#FFA8B4', fontFamily: 'Montserrat_400Regular', fontSize: 10, lineHeight: 14 },
  toggle: { alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 4, marginTop: 2 },
  toggleText: { color: colors.muted, fontFamily: 'Montserrat_600SemiBold', fontSize: 8, letterSpacing: 0.6 },
  pressed: { opacity: 0.7 },
});
