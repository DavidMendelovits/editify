import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AssetMetadata } from '@editify/shared';
import { AssetActionSheet } from '../src/components/AssetActionSheet';
import { Markdown } from '../src/components/editor/Markdown';
import { Brand } from '../src/components/Brand';
import { Button } from '../src/components/Button';
import { Screen } from '../src/components/Screen';
import { api, uploadAsset, type StyleProfile, type StyleProgress } from '../src/lib/api';
import { backControlStyle, goBack } from '../src/lib/nav';
import { colors, radius, space, type, fonts } from '../src/lib/theme';

/** One line on where the brief came from: a watching analyzer, or ffmpeg numbers alone. */
function watchedLine(profile: StyleProfile): string {
  const template = profile.template;
  if (!template || template.watchedCount === 0) return 'Measured with ffmpeg only. No video was watched.';
  return `${template.watchedCount} of ${template.videoCount} videos watched by ${template.analyzers.join(', ')}.`;
}

function progressLine(progress: StyleProgress | undefined, analyzerLabel: string | undefined): string {
  if (!progress) return 'Detecting scene changes and measuring loudness.';
  const count = `${Math.min(progress.done, progress.total)} of ${progress.total}`;
  switch (progress.stage) {
    case 'measuring': return `Measuring scene changes and loudness, ${count} videos.`;
    case 'watching': return `${analyzerLabel ?? 'The analyzer'} is watching video ${count}.`;
    case 'aggregating': return 'Folding the observations into one template.';
    case 'distilling': return 'Writing the style brief.';
  }
}

export default function StyleScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const profile = useQuery({
    queryKey: ['style-profile'], queryFn: api.getStyle, retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'processing' ? 1500 : false),
  });
  const analyze = useMutation({
    mutationFn: async () => {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['video/*'], multiple: true, copyToCacheDirectory: true });
      if (picked.canceled) return undefined;
      const uploaded = [];
      for (const asset of picked.assets.slice(0, 10)) {
        uploaded.push(await uploadAsset({ uri: asset.uri, name: asset.name, ...(asset.mimeType ? { mimeType: asset.mimeType } : {}), ...(asset.file ? { file: asset.file } : {}) }));
      }
      return await api.analyzeStyle(uploaded.map((asset) => asset.id));
    },
    // The POST only starts the scan — refetch so the poll above picks it up.
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['style-profile'] }); },
  });
  // Which row's ⋯ menu is open, and the row being renamed inline (no window.prompt on web).
  const [menuId, setMenuId] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const styleList = useQuery({ queryKey: ['style-profiles'], queryFn: api.listStyles });
  // Every mutation moves both the list and the selected profile, so refresh both.
  const refreshStyles = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['style-profiles'] }),
      client.invalidateQueries({ queryKey: ['style-profile'] }),
    ]);
  };
  const selectStyle = useMutation({ mutationFn: api.selectStyle, onSuccess: refreshStyles });
  const renameStyle = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameStyle(id, name),
    onSuccess: async () => { setRenaming(undefined); await refreshStyles(); },
  });
  const duplicateStyle = useMutation({ mutationFn: api.duplicateStyle, onSuccess: refreshStyles });
  const deleteStyle = useMutation({ mutationFn: api.deleteStyle, onSuccess: refreshStyles });
  // Every clip on the server, so a reference can be measured before any project
  // adopts it — dissection is a pre-edit decision, not a timeline action.
  const clips = useQuery({ queryKey: ['library', 'all'], queryFn: () => api.listAssets() });
  const [actionAsset, setActionAsset] = useState<AssetMetadata>();
  const references = (clips.data ?? []).filter((asset) => asset.width > 0 && !asset.mimeType.startsWith('image/'));
  const current = profile.data?.profile;
  const saved = styleList.data?.profiles ?? [];
  const selectedId = styleList.data?.selectedId ?? current?.id;
  // Uploading, or the server still scanning after the 202.
  const busy = analyze.isPending || profile.data?.status === 'processing';
  // The pluggable "watch" step: ffmpeg only keeps footage local, anything else uploads it.
  const analyzerStatus = useQuery({ queryKey: ['style-analyzer'], queryFn: api.getStyleAnalyzer, retry: false });
  const analyzer = analyzerStatus.data?.options.find((option) => option.id === analyzerStatus.data?.active);
  const selectAnalyzer = useMutation({
    mutationFn: api.selectStyleAnalyzer,
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['style-analyzer'] }); },
  });
  const progress = profile.data?.progress;
  const failure = analyze.error?.message ?? (profile.data?.status === 'error' ? profile.data.error ?? 'Analysis failed' : undefined);

  return (
    <Screen header={<View style={styles.header}><Pressable onPress={() => goBack(router, '/')} accessibilityRole="button" style={backControlStyle}><Text style={styles.back}>‹  HOME</Text></Pressable><Brand compact /></View>}>
      <View style={styles.hero}>
        <Text style={styles.title}>Style memory</Text>
        <Text style={styles.subtitle}>{analyzer?.watches
          ? `Cuts, loudness, framing, and pace are measured with ffmpeg, then each video is watched by ${analyzer.label}.`
          : 'Cuts, loudness, framing, and pace are measured with ffmpeg. Your footage is never sent to an AI model.'}</Text>
      </View>
      <View style={styles.uploadCard}>
        <Text style={styles.uploadTitle}>{busy ? 'Analyzing…' : 'Add past cuts'}</Text>
        <Text style={styles.uploadSubtitle}>{busy ? progressLine(progress, analyzer?.label) : 'MP4, MOV, or WebM · up to 10 videos'}</Text>
        <Button disabled={busy} onPress={() => analyze.mutate()} style={styles.uploadButton}>
          {busy ? 'analyzing…' : current ? 'analyze new videos' : 'choose videos'}
        </Button>
        {busy && <View style={styles.progress}><View style={styles.progressFill} /></View>}
        {analyzerStatus.data && (
          <View style={styles.analyzerRow}>
            <Text style={styles.analyzerLabel}>WATCHED BY</Text>
            {analyzerStatus.data.options.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityLabel={`${option.label}: ${option.detail}`}
                disabled={!option.available || busy || selectAnalyzer.isPending}
                onPress={() => selectAnalyzer.mutate(option.id)}
                style={[styles.analyzerChip, option.id === analyzerStatus.data?.active && styles.analyzerChipActive, !option.available && styles.analyzerChipOff]}
              >
                <Text style={[styles.analyzerChipText, option.id === analyzerStatus.data?.active && styles.analyzerChipTextActive]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {analyzer && <Text style={styles.analyzerDetail}>{analyzer.detail}</Text>}
      </View>
      {failure && <Text style={styles.error}>{failure}</Text>}
      {selectAnalyzer.error && <Text style={styles.error}>{selectAnalyzer.error.message}</Text>}
      {saved.length > 0 && (
        <>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Your styles</Text>
              <Text style={styles.sectionNote}>Tap a style to brief the agent with it.</Text>
            </View>
            <Text style={styles.count}>{saved.length} STYLES</Text>
          </View>
          <View style={styles.clipList}>
            {saved.map((item) => (
              <View key={item.id} style={[styles.clipRow, item.id === selectedId && styles.styleRowSelected]}>
                {renaming?.id === item.id ? (
                  <TextInput
                    value={renaming.name}
                    onChangeText={(name) => setRenaming({ id: item.id, name })}
                    onSubmitEditing={() => renameStyle.mutate(renaming)}
                    onBlur={() => renameStyle.mutate(renaming)}
                    autoFocus
                    accessibilityLabel={`new name for ${item.name}`}
                    style={styles.renameInput}
                  />
                ) : (
                  <Pressable
                    onPress={() => selectStyle.mutate(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`select style ${item.name}`}
                    style={styles.styleNameTap}
                  >
                    <Text style={styles.clipName} numberOfLines={1}>{item.name}</Text>
                  </Pressable>
                )}
                <Text style={styles.clipMeta}>{item.id === selectedId ? 'SELECTED' : `${item.metrics.length} VIDEOS`}</Text>
                <Pressable
                  onPress={() => setMenuId(menuId === item.id ? undefined : item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`actions for ${item.name}`}
                  hitSlop={10}
                  style={({ pressed }) => [styles.clipMore, pressed && styles.clipMorePressed]}
                >
                  <Text style={styles.clipMoreText}>⋯</Text>
                </Pressable>
                {menuId === item.id && (
                  <View style={styles.styleMenu}>
                    <StyleAction label="rename" onPress={() => { setMenuId(undefined); setRenaming({ id: item.id, name: item.name }); }} />
                    <StyleAction label="duplicate" onPress={() => { setMenuId(undefined); duplicateStyle.mutate(item.id); }} />
                    <StyleAction label="delete" onPress={() => { setMenuId(undefined); deleteStyle.mutate(item.id); }} danger />
                  </View>
                )}
              </View>
            ))}
          </View>
        </>
      )}
      {current && (
        <>
          <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Style metrics</Text><Text style={styles.count}>{current.metrics.length} VIDEOS</Text></View>
          <View style={styles.metricGrid}>
            <Metric label="AVERAGE SHOT" value={`${average(current.metrics.map((metric) => metric.averageShotLength)).toFixed(1)}s`} detail="scene-change spacing" />
            <Metric label="CUT DENSITY" value={`${average(current.metrics.map((metric) => metric.cutDensity)).toFixed(2)}/s`} detail={`${current.metrics.reduce((sum, metric) => sum + metric.cutCount, 0)} detected cuts`} />
            <Metric label="LOUDNESS" value={loudness(current.metrics.map((metric) => metric.loudnessLufs))} detail="integrated LUFS" />
            <Metric label="PRIMARY FORMAT" value={mode(current.metrics.map((metric) => metric.format))} detail="frame orientation" />
          </View>
          <View style={styles.styleDoc}>
            <Text style={styles.styleDocEyebrow}>STYLE BRIEF</Text>
            <Text style={styles.styleFoot}>{watchedLine(current)}</Text>
            <Markdown text={current.styleDoc} />
            <Text style={styles.styleFoot}>This brief is injected into every edit conversation.</Text>
          </View>
        </>
      )}
      {references.length > 0 && (
        <>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Your clips</Text>
              <Text style={styles.sectionNote}>Long-press a clip to dissect it into a preset.</Text>
            </View>
            <Text style={styles.count}>{references.length} CLIPS</Text>
          </View>
          <View style={styles.clipList}>
            {references.map((asset) => (
              <Pressable
                key={asset.id}
                onLongPress={() => setActionAsset(asset)}
                accessibilityRole="button"
                accessibilityLabel={`actions for ${asset.label ?? asset.originalName}`}
                style={styles.clipRow}
              >
                <Text style={styles.clipName} numberOfLines={1}>{asset.label ?? asset.originalName}</Text>
                <Text style={styles.clipMeta}>{asset.duration.toFixed(1)}s</Text>
                <Pressable
                  onPress={() => setActionAsset(asset)}
                  accessibilityRole="button"
                  accessibilityLabel={`actions for ${asset.label ?? asset.originalName}`}
                  hitSlop={10}
                  style={({ pressed }) => [styles.clipMore, pressed && styles.clipMorePressed]}
                >
                  <Text style={styles.clipMoreText}>⋯</Text>
                </Pressable>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {actionAsset && <AssetActionSheet asset={actionAsset} onClose={() => setActionAsset(undefined)} />}
    </Screen>
  );
}

function StyleAction({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.styleMenuItem, pressed && styles.clipMorePressed]}>
      <Text style={[styles.styleMenuText, danger && styles.styleMenuDanger]}>{label}</Text>
    </Pressable>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricDetail}>{detail}</Text></View>;
}
function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function loudness(values: Array<number | null>): string { const valid = values.filter((value): value is number => value !== null); return valid.length ? `${average(valid).toFixed(1)}` : 'silent'; }
function mode(values: string[]): string { return values.sort((a, b) => values.filter((v) => v === a).length - values.filter((v) => v === b).length).at(-1) ?? 'n/a'; }

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.md, letterSpacing: 1.4 },
  hero: { paddingVertical: space.xl, gap: space.md, maxWidth: 760 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.display, lineHeight: 34, letterSpacing: -0.8 },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 18, maxWidth: 650 },
  uploadCard: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.panel, minHeight: 200, alignItems: 'center', justifyContent: 'center', padding: space.section, gap: space.lg },
  uploadTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xl, textAlign: 'center' },
  uploadSubtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, textAlign: 'center' },
  uploadButton: { width: 210, marginTop: space.xl },
  progress: { height: 4, width: 210, marginTop: space.lg, borderRadius: radius.md, backgroundColor: colors.border, overflow: 'hidden' },
  progressFill: { width: '68%', height: '100%', backgroundColor: colors.accent },
  analyzerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: space.md, marginTop: space.lg },
  analyzerLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5, marginRight: space.sm },
  analyzerChip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: colors.panel },
  analyzerChipActive: { borderColor: colors.accent },
  analyzerChipOff: { opacity: 0.4 },
  analyzerChipText: { color: colors.muted, fontFamily: fonts.semibold, fontSize: type.sm },
  analyzerChipTextActive: { color: colors.text },
  analyzerDetail: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'center' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xl },
  sectionTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  sectionNote: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, marginTop: space.sm, maxWidth: 520 },
  clipList: { gap: space.lg },
  clipRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.xl, minHeight: 40, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: space.xl, paddingVertical: space.lg,
  },
  styleRowSelected: { borderColor: colors.accent },
  styleNameTap: { flex: 1 },
  renameInput: {
    flex: 1, color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg,
    borderWidth: 1, borderColor: colors.accent, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm,
  },
  // Inline, not a popover: a floating menu on the last row opens below the fold
  // and RN Web gives each row its own stacking context, so it ended up
  // unreachable. Expanding inside the row is always on screen and always on top.
  styleMenu: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.panel, overflow: 'hidden',
  },
  styleMenuItem: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  styleMenuText: { color: colors.text, fontFamily: fonts.medium, fontSize: type.md },
  styleMenuDanger: { color: colors.danger },
  clipName: { flex: 1, color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg },
  clipMeta: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.md, fontVariant: ['tabular-nums'] },
  clipMore: { width: 28, height: 28, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  clipMorePressed: { opacity: 0.6 },
  clipMoreText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xl, lineHeight: 17 },
  count: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.4 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xl },
  metric: { flexGrow: 1, flexBasis: 180, borderRadius: radius.md, padding: space.xl, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  metricLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.3 },
  metricValue: { color: colors.text, fontFamily: fonts.bold, fontSize: type.title, marginTop: space.md },
  metricDetail: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, marginTop: space.sm },
  styleDoc: { borderRadius: radius.md, padding: space.xxl, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, gap: space.lg },
  styleDocEyebrow: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  styleFoot: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.lg },
});
