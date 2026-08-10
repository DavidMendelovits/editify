import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';
import { api, type AssetInsights, type InsightHighlight } from '../lib/api';
import { colors, gradient } from '../lib/theme';

/** Highlights shown per asset — the ranked list is long and this panel is a glance, not a report. */
const TOP_HIGHLIGHTS = 3;

/**
 * Read-only "what's strong in this footage" panel: the transcript hook and the
 * top scored highlights for every asset on the video track. Assets without a
 * transcript 404 and are skipped without comment.
 */
export function InsightsPanel({ assetIds }: { assetIds: string[] }) {
  const [open, setOpen] = useState(false);
  if (assetIds.length === 0) return null;

  return (
    <View style={styles.zone}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={styles.label}>INSIGHTS · {assetIds.length} {assetIds.length === 1 ? 'ASSET' : 'ASSETS'}</Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open && (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled>
          {assetIds.map((assetId, index) => <AssetInsightCard key={assetId} assetId={assetId} index={index} />)}
        </ScrollView>
      )}
    </View>
  );
}

function AssetInsightCard({ assetId, index }: { assetId: string; index: number }) {
  const insightsQuery = useQuery({
    queryKey: ['insights', assetId],
    queryFn: () => api.getInsights(assetId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
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
          <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hookChip}>
            <Text style={styles.hookChipText}>HOOK</Text>
          </LinearGradient>
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
        <LinearGradient
          colors={gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.barFill, { width: `${Math.round(score * 100)}%` }]}
        />
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
  zone: { borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12, paddingVertical: 9, gap: 7 },
  header: { minHeight: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  label: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5 },
  chevron: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 10 },
  list: { maxHeight: 210 },
  listContent: { gap: 7, paddingBottom: 2 },
  card: { borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  cardHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  source: { color: colors.purple, fontFamily: 'Montserrat_800ExtraBold', fontSize: 8, letterSpacing: 1.1 },
  summary: { flex: 1, color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 9 },
  pending: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 9 },
  hookRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  hookChip: { borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  hookChipText: { color: colors.text, fontFamily: 'Montserrat_800ExtraBold', fontSize: 8, letterSpacing: 1 },
  hookBody: { flex: 1, gap: 2 },
  hookText: { color: colors.text, fontFamily: 'Montserrat_500Medium', fontSize: 10, lineHeight: 15 },
  span: { color: colors.muted, fontFamily: 'Montserrat_600SemiBold', fontSize: 8 },
  highlight: { gap: 3 },
  highlightHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  highlightLabel: { flex: 1, color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 0.8, textTransform: 'uppercase' },
  score: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 8 },
  highlightText: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 9, lineHeight: 13 },
  bar: { height: 3, borderRadius: 2, backgroundColor: '#2A2937', overflow: 'hidden' },
  barFill: { height: 3, borderRadius: 2 },
  pressed: { opacity: 0.7 },
});
