import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQueries, useQuery } from '@tanstack/react-query';
import { CHECKLIST_PRESETS, CHECKLIST_PRESET_NAMES, evaluateChecklist, type Project } from '@editify/shared';
import { api, type AssetInsights, type InsightHighlight } from '../lib/api';
import { colors, radius, space, type, fonts } from '../lib/theme';

/** Highlights shown per asset — the ranked list is long and this panel is a glance, not a report. */
const TOP_HIGHLIGHTS = 3;

/** Shared by the checklist and the per-asset cards so neither refetches the other's data. */
function insightsQueryOptions(assetId: string) {
  return {
    queryKey: ['insights', assetId] as const,
    queryFn: () => api.getInsights(assetId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  };
}

/**
 * Read-only "what's strong in this footage" panel: a preset checklist that
 * scores the cut, then the transcript hook and the top scored highlights for
 * every asset on the video track. Assets without a transcript 404 and are
 * skipped without comment.
 */
export function InsightsPanel({ assetIds, project, open, onToggle }: { assetIds: string[]; project: Project; open: boolean; onToggle: () => void }) {
  if (assetIds.length === 0) return null;

  return (
    <View style={[styles.zone, open && styles.zoneOpen]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={styles.label}>INSIGHTS · {assetIds.length} {assetIds.length === 1 ? 'ASSET' : 'ASSETS'}</Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open && (
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={styles.listContent} nestedScrollEnabled>
          <ChecklistSection assetIds={assetIds} project={project} />
          {assetIds.map((assetId, index) => <AssetInsightCard key={assetId} assetId={assetId} index={index} />)}
        </ScrollView>
      )}
    </View>
  );
}

/** Scores the current cut against one preset's checklist and says what to fix. */
function ChecklistSection({ assetIds, project }: { assetIds: string[]; project: Project }) {
  const [presetName, setPresetName] = useState<string>('talking_head_punchy');
  // Same query keys as the cards below, so the checklist rides their cache.
  const insights = useQueries({
    queries: assetIds.map(insightsQueryOptions),
    combine: (results) => results.flatMap((result) => (result.data ? [result.data] : [])),
  });
  const result = evaluateChecklist(presetName, project, insights);

  return (
    <View style={styles.checklist}>
      <Text style={styles.label}>CHECKLIST</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {CHECKLIST_PRESET_NAMES.map((name) => {
          const selected = name === presetName;
          const title = CHECKLIST_PRESETS[name]?.title ?? name;
          return (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setPresetName(name)}
              style={({ pressed }) => [styles.chip, selected && styles.chipActive, pressed && styles.pressed]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextActive]}>{title.toUpperCase()}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.scoreRow}>
        <Text style={styles.checklistScore}>{result.score}/{result.total}</Text>
        <View style={styles.scoreBar}>
          <View style={[styles.scoreFill, { width: `${Math.round((result.score / result.total) * 100)}%` }]} />
        </View>
      </View>
      {result.items.map((item) => (
        <View key={item.id} style={styles.criterion}>
          <Text style={[styles.tick, item.met ? styles.tickMet : styles.tickUnmet]}>{item.met ? '✓' : '○'}</Text>
          <View style={styles.criterionBody}>
            <Text style={[styles.criterionLabel, !item.met && styles.criterionLabelUnmet]}>{item.label}</Text>
            {!item.met && <Text style={styles.suggestion}>{item.suggestion}</Text>}
          </View>
        </View>
      ))}
    </View>
  );
}

function AssetInsightCard({ assetId, index }: { assetId: string; index: number }) {
  const insightsQuery = useQuery(insightsQueryOptions(assetId));
  const insights: AssetInsights | null | undefined = insightsQuery.data;
  // 404 (no transcript) and outright failures both mean "nothing to show here".
  if (insightsQuery.isError || insights === null) return null;
  const source = `SOURCE ${String(index + 1).padStart(2, '0')}`;

  if (!insights) return <View style={styles.card}><Text style={styles.source}>{source}</Text><Text style={styles.pending}>reading the transcript…</Text></View>;

  const highlights = [...insights.highlights].sort((a, b) => b.score - a.score).slice(0, TOP_HIGHLIGHTS);
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.source}>{source}</Text>
        {insights.summary.length > 0 && <Text style={styles.summary} numberOfLines={1}>{insights.summary}</Text>}
      </View>
      {insights.hook && (
        <View style={styles.hookRow}>
          <View style={styles.hookChip}><Text style={styles.hookChipText}>HOOK</Text></View>
          <View style={styles.hookBody}>
            <Text style={styles.span}>{formatSpan(insights.hook.start, insights.hook.end)}</Text>
            <Text style={styles.hookText} numberOfLines={2}>{insights.hook.text}</Text>
          </View>
        </View>
      )}
      {highlights.map((highlight, position) => <HighlightRow key={`${highlight.start}-${position}`} highlight={highlight} />)}
      {!insights.hook && highlights.length === 0 && <Text style={styles.pending}>no standout moments found</Text>}
    </View>
  );
}

function HighlightRow({ highlight }: { highlight: InsightHighlight }) {
  const score = Math.min(1, Math.max(0, Number.isFinite(highlight.score) ? highlight.score : 0));
  return (
    <View style={styles.highlight}>
      <View style={styles.highlightHeader}>
        <Text style={styles.highlightLabel} numberOfLines={1}>{highlight.label.replaceAll('_', ' ')}</Text>
        <Text style={styles.span}>{formatSpan(highlight.start, highlight.end)}</Text>
        <Text style={styles.score}>{score.toFixed(2)}</Text>
      </View>
      <Text style={styles.highlightText} numberOfLines={2}>{highlight.text}</Text>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${Math.round(score * 100)}%` }]} />
      </View>
    </View>
  );
}

/** Source-time seconds → `0:04.2 → 0:09.8`, the same clock the timecode uses. */
function formatSpan(start: number, end: number): string {
  return `${stamp(start)} → ${stamp(end)}`;
}

function stamp(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}.${Math.floor((safe % 1) * 10)}`;
}

const styles = StyleSheet.create({
  // minHeight 0 + hidden overflow let the expanded panel shrink inside the wide dock
  // column instead of spilling over its neighbours; collapsed zones keep flexShrink 0
  // so their header is never squeezed.
  zone: { minHeight: 0, overflow: 'hidden', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: space.xl, paddingVertical: space.lg, gap: space.md },
  zoneOpen: { flexShrink: 1, minHeight: 40 },
  header: { minHeight: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.lg },
  label: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  chevron: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.md },
  listContent: { gap: space.md, paddingBottom: space.xs },
  card: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: space.lg, paddingVertical: space.lg, gap: space.md },
  cardHeader: { flexDirection: 'row', alignItems: 'baseline', gap: space.lg },
  source: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.1 },
  summary: { flex: 1, color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm },
  pending: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm },
  hookRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  hookChip: { borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: space.lg, paddingVertical: space.xs },
  hookChipText: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1 },
  hookBody: { flex: 1, gap: space.xs },
  hookText: { color: colors.text, fontFamily: fonts.medium, fontSize: type.md, lineHeight: 15 },
  span: { color: colors.muted, fontFamily: fonts.semibold, fontSize: type.xs },
  highlight: { gap: space.xs },
  highlightHeader: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  highlightLabel: { flex: 1, color: colors.text, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.8, textTransform: 'uppercase' },
  score: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.xs },
  highlightText: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm, lineHeight: 13 },
  bar: { height: 3, backgroundColor: colors.panelSunken, overflow: 'hidden' },
  barFill: { height: 3, backgroundColor: colors.borderStrong },
  checklist: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: space.lg, paddingVertical: space.lg, gap: space.md },
  chipRow: { gap: space.sm, paddingRight: space.sm },
  chip: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: space.lg, paddingVertical: space.sm },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1 },
  chipTextActive: { color: colors.text },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  checklistScore: { color: colors.text, fontFamily: fonts.mono, fontSize: type.base },
  scoreBar: { flex: 1, height: 3, backgroundColor: colors.panelSunken, overflow: 'hidden' },
  scoreFill: { height: 3, backgroundColor: colors.accent },
  criterion: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  criterionBody: { flex: 1, gap: space.xs },
  tick: { fontFamily: fonts.bold, fontSize: type.md, lineHeight: 14, width: 10 },
  tickMet: { color: colors.success },
  tickUnmet: { color: colors.muted },
  criterionLabel: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.md, lineHeight: 14 },
  criterionLabelUnmet: { color: colors.muted },
  suggestion: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm, lineHeight: 13 },
  pressed: { opacity: 0.7 },
});
