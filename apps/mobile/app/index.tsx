import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NewProject, Project, ProjectFormat } from '@editify/shared';
import { Brand } from '../src/components/Brand';
import { GradientButton } from '../src/components/GradientButton';
import { ImportSheet } from '../src/components/ImportSheet';
import { ReportModal } from '../src/components/ReportModal';
import { Screen } from '../src/components/Screen';
import { api, assetThumbUrl } from '../src/lib/api';
import { supabase } from '../src/lib/supabase';
import { colors, fonts } from '../src/lib/theme';

const formats: Array<{ label: string; format: ProjectFormat; meta: string; glyph: string; tint: readonly [string, string] }> = [
  { label: 'Instagram Reel', format: '9:16', meta: '9:16 · UP TO 90S', glyph: '◉', tint: ['#213973', '#6D3C8E'] },
  { label: 'TikTok', format: '9:16', meta: '9:16 · 15-60S', glyph: '♪', tint: ['#4B276F', '#982F6D'] },
  { label: 'YouTube', format: '16:9', meta: '16:9 · LONG FORM', glyph: '▶', tint: ['#3A255C', '#71314A'] },
];

export default function HomeScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const create = useMutation({
    mutationFn: (input: NewProject) => api.createProject(input),
    onSuccess: async (project) => {
      await client.invalidateQueries({ queryKey: ['projects'] });
      router.push({ pathname: '/project/[id]', params: { id: project.id } });
    },
  });

  return (
    <Screen header={
      <View style={styles.header}>
        <Brand />
        <View style={styles.headerActions}>
          <GradientButton secondary style={styles.styleButton} onPress={() => setImportOpen(true)}>↓  import media</GradientButton>
          <GradientButton secondary style={styles.styleButton} onPress={() => router.push('/style')}>✦  learn my style</GradientButton>
          <GradientButton accessibilityLabel="send feedback" secondary style={styles.styleButton} onPress={() => setFeedbackOpen(true)}>✉  send feedback</GradientButton>
          <GradientButton accessibilityLabel="sign out" secondary style={styles.signOutButton} onPress={() => { void supabase.auth.signOut(); }}>sign out</GradientButton>
        </View>
      </View>
    }>
      <View style={styles.hero}>
        <Text style={styles.kicker}>NEW PROJECT</Text>
      </View>

      <View style={styles.formatList}>
        {formats.map((item, index) => (
          <Pressable
            key={`${item.label}-${index}`}
            accessibilityRole="button"
            onPress={() => create.mutate({ title: `${item.label} edit`, format: item.format, fps: 30 })}
            style={({ pressed }) => [styles.formatRow, pressed && styles.pressed]}
          >
            <LinearGradient colors={[colors.blue, colors.pink]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.rowAccent} />
            <LinearGradient colors={item.tint} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.rowIcon}>
              <Text style={styles.rowGlyph}>{item.glyph}</Text>
            </LinearGradient>
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>{item.label}</Text>
              <Text style={styles.rowMeta}>{item.meta}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      {create.error && <Text style={styles.error}>{create.error.message}</Text>}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Recent projects</Text>
        <Text style={styles.count}>{projects.data?.length ?? 0} CUTS</Text>
      </View>
      {projects.isLoading && <Text style={styles.empty}>Loading your cuts…</Text>}
      {projects.error && <Text style={styles.error}>The server is offstage: {projects.error.message}</Text>}
      {projects.data?.length === 0 && (
        <View style={styles.emptyCard}><Text style={styles.emptyIcon}>◫</Text><Text style={styles.empty}>Choose a format above to start a project.</Text></View>
      )}
      <View style={styles.projectGrid}>
        {projects.data?.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })}
          />
        ))}
      </View>
      {feedbackOpen && <ReportModal mode="feedback" onClose={() => setFeedbackOpen(false)} />}
      <ImportSheet
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { void client.invalidateQueries({ queryKey: ['importable'] }); }}
      />
    </Screen>
  );
}

/** Recent-project tile: poster frame, title, format badge, duration, clip count. */
function ProjectCard({ project, onPress }: { project: Project; onPress: () => void }) {
  const assetId = project.tracks.flatMap((track) => track.clips).find((clip) => clip.assetId)?.assetId;
  const clipCount = project.tracks.reduce((total, track) => total + track.clips.length, 0);
  const captionCount = project.tracks.filter((track) => track.kind === 'caption').reduce((total, track) => total + track.clips.length, 0);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.projectCard, pressed && styles.pressed]}>
      <View style={styles.poster}>
        {assetId
          ? <Image source={{ uri: assetThumbUrl(assetId) }} style={styles.posterImage} resizeMode="cover" />
          : <Text style={styles.posterText}>EMPTY TIMELINE</Text>}
        <View style={styles.formatBadge}><Text style={styles.formatBadgeText}>{project.format}</Text></View>
        <View style={styles.durationBadge}><Text style={styles.durationBadgeText}>{formatDuration(project.duration)}</Text></View>
      </View>
      <View style={styles.projectCopy}>
        <Text style={styles.projectTitle} numberOfLines={1}>{project.title}</Text>
        <Text style={styles.projectMeta}>
          {clipCount} clips · {captionCount} captions · v{project.version}
        </Text>
      </View>
    </Pressable>
  );
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  styleButton: { minHeight: 40, paddingHorizontal: 14, backgroundColor: colors.panel, borderColor: colors.border },
  signOutButton: { minHeight: 40, paddingHorizontal: 12, borderColor: colors.border },
  hero: { paddingTop: 28, paddingBottom: 8, gap: 10, maxWidth: 900, width: '100%', alignSelf: 'center' },
  kicker: { color: colors.purple, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2.4 },
  formatList: { gap: 16, maxWidth: 900, width: '100%', alignSelf: 'center' },
  formatRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 16, paddingLeft: 20, paddingRight: 18, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  rowAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  rowIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowGlyph: { color: colors.text, fontSize: 18 },
  rowCopy: { flex: 1, gap: 3 },
  rowTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: 16 },
  rowMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.4 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  sectionHeader: { marginTop: 28, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  sectionTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: 24, letterSpacing: -0.8 },
  count: { color: colors.muted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.3 },
  projectGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  projectCard: { flexGrow: 1, flexBasis: 250, maxWidth: 340, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  poster: { height: 132, backgroundColor: '#1B1826', alignItems: 'center', justifyContent: 'center' },
  posterImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  posterText: { color: colors.muted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.4 },
  formatBadge: { position: 'absolute', top: 8, left: 8, borderRadius: 5, backgroundColor: '#00000099', paddingHorizontal: 7, paddingVertical: 3 },
  formatBadgeText: { color: '#FFFFFF', fontFamily: fonts.mono, fontSize: 8, letterSpacing: 0.8 },
  durationBadge: { position: 'absolute', bottom: 8, right: 8, borderRadius: 5, backgroundColor: '#00000099', paddingHorizontal: 7, paddingVertical: 3 },
  durationBadgeText: { color: '#FFFFFF', fontFamily: fonts.semibold, fontSize: 8, fontVariant: ['tabular-nums'] },
  projectCopy: { padding: 12, gap: 4 },
  projectTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  projectMeta: { color: colors.muted, fontFamily: fonts.regular, fontSize: 10 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  emptyCard: { alignItems: 'center', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', borderRadius: 20, padding: 36, gap: 8 },
  emptyIcon: { color: colors.purple, fontSize: 28 },
  empty: { color: colors.muted, fontFamily: fonts.regular, fontSize: 13, textAlign: 'center' },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: 12 },
});
