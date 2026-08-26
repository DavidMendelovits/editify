import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { NewProject, Project, ProjectFormat } from '@editify/shared';
import { Brand } from '../src/components/Brand';
import { GradientButton } from '../src/components/GradientButton';
import { ImportSheet } from '../src/components/ImportSheet';
import { Screen } from '../src/components/Screen';
import { api, assetThumbUrl } from '../src/lib/api';
import { supabase } from '../src/lib/supabase';
import { colors } from '../src/lib/theme';

const formats: Array<{ label: string; format: ProjectFormat; eyebrow: string; ratio: string; tint: readonly [string, string] }> = [
  { label: 'Instagram Reel', format: '9:16', eyebrow: 'VERTICAL STORY', ratio: '9 : 16', tint: ['#213973', '#6D3C8E'] },
  { label: 'TikTok', format: '9:16', eyebrow: 'FAST & SOCIAL', ratio: '9 : 16', tint: ['#4B276F', '#982F6D'] },
  { label: 'YouTube', format: '16:9', eyebrow: 'WIDE SCREEN', ratio: '16 : 9', tint: ['#3A255C', '#71314A'] },
];

export default function HomeScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const { width } = useWindowDimensions();
  const [importOpen, setImportOpen] = useState(false);
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const create = useMutation({
    mutationFn: (input: NewProject) => api.createProject(input),
    onSuccess: async (project) => {
      await client.invalidateQueries({ queryKey: ['projects'] });
      router.push({ pathname: '/project/[id]', params: { id: project.id } });
    },
  });
  const compact = width < 760;

  return (
    <Screen header={
      <View style={styles.header}>
        <Brand />
        <View style={styles.headerActions}>
          <GradientButton secondary style={styles.styleButton} onPress={() => setImportOpen(true)}>↓  import media</GradientButton>
          <GradientButton secondary style={styles.styleButton} onPress={() => router.push('/style')}>✦  learn my style</GradientButton>
          <GradientButton accessibilityLabel="sign out" secondary style={styles.signOutButton} onPress={() => { void supabase.auth.signOut(); }}>sign out</GradientButton>
        </View>
      </View>
    }>
      <View style={styles.hero}>
        <Text style={styles.kicker}>START A NEW CUT</Text>
        <Text style={styles.title}>What are you{compact ? '\n' : ' '}creating today?</Text>
        <Text style={styles.subtitle}>Pick a canvas. Edit with a conversation. Export something worth watching.</Text>
      </View>

      <View style={[styles.formatGrid, compact && styles.formatGridCompact]}>
        {formats.map((item, index) => (
          <Pressable
            key={`${item.label}-${index}`}
            accessibilityRole="button"
            onPress={() => create.mutate({ title: `${item.label} edit`, format: item.format, fps: 30 })}
            style={({ pressed }) => [styles.formatCard, pressed && styles.pressed]}
          >
            <LinearGradient colors={item.tint} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.formatGradient}>
              <View style={styles.cardTop}><Text style={styles.eyebrow}>{item.eyebrow}</Text><Text style={styles.arrow}>↗</Text></View>
              <View style={[styles.ratioFrame, item.format === '16:9' && styles.ratioWide]}><Text style={styles.ratioText}>{item.ratio}</Text></View>
              <View><Text style={styles.cardTitle}>{item.label}</Text><Text style={styles.cardMeta}>{item.format} · 30 FPS</Text></View>
            </LinearGradient>
          </Pressable>
        ))}
      </View>
      {create.error && <Text style={styles.error}>{create.error.message}</Text>}

      <View style={styles.sectionHeader}>
        <View><Text style={styles.sectionKicker}>PICK UP WHERE YOU LEFT OFF</Text><Text style={styles.sectionTitle}>Recent projects</Text></View>
        <Text style={styles.count}>{projects.data?.length ?? 0} CUTS</Text>
      </View>
      {projects.isLoading && <Text style={styles.empty}>Loading your cuts…</Text>}
      {projects.error && <Text style={styles.error}>The server is offstage: {projects.error.message}</Text>}
      {projects.data?.length === 0 && (
        <View style={styles.emptyCard}><Text style={styles.emptyIcon}>◫</Text><Text style={styles.emptyTitle}>Your first cut starts above.</Text><Text style={styles.empty}>Choose a format and Editify will build the timeline.</Text></View>
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
  hero: { alignItems: 'center', paddingVertical: 42, gap: 12 },
  kicker: { color: colors.purple, fontFamily: 'Montserrat_700Bold', fontSize: 11, letterSpacing: 2.4 },
  title: { color: colors.text, fontFamily: 'Montserrat_800ExtraBold', fontSize: 46, lineHeight: 51, letterSpacing: -2.2, textAlign: 'center' },
  subtitle: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 15, lineHeight: 23, textAlign: 'center', maxWidth: 620 },
  formatGrid: { flexDirection: 'row', gap: 16 },
  formatGridCompact: { flexDirection: 'column' },
  formatCard: { flex: 1, minHeight: 280, borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: '#FFFFFF1A' },
  formatGradient: { flex: 1, padding: 20, justifyContent: 'space-between' },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between' },
  eyebrow: { color: '#FFFFFFA8', fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.6 },
  arrow: { color: colors.text, fontSize: 20 },
  ratioFrame: { width: 64, height: 106, borderRadius: 12, borderWidth: 2, borderColor: '#FFFFFF55', alignSelf: 'center', justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFFFFF0C' },
  ratioWide: { width: 118, height: 68 },
  ratioText: { color: '#FFFFFFCC', fontFamily: 'Montserrat_700Bold', fontSize: 10 },
  cardTitle: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 19 },
  cardMeta: { color: '#FFFFFF88', fontFamily: 'Montserrat_500Medium', fontSize: 11, marginTop: 5 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  sectionHeader: { marginTop: 28, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  sectionKicker: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.6, marginBottom: 6 },
  sectionTitle: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 24, letterSpacing: -0.8 },
  count: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 10, letterSpacing: 1.3 },
  projectGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  projectCard: { flexGrow: 1, flexBasis: 250, maxWidth: 340, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  poster: { height: 132, backgroundColor: '#1B1826', alignItems: 'center', justifyContent: 'center' },
  posterImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  posterText: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.4 },
  formatBadge: { position: 'absolute', top: 8, left: 8, borderRadius: 5, backgroundColor: '#00000099', paddingHorizontal: 7, paddingVertical: 3 },
  formatBadgeText: { color: '#FFFFFF', fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 0.8 },
  durationBadge: { position: 'absolute', bottom: 8, right: 8, borderRadius: 5, backgroundColor: '#00000099', paddingHorizontal: 7, paddingVertical: 3 },
  durationBadgeText: { color: '#FFFFFF', fontFamily: 'Montserrat_600SemiBold', fontSize: 8, fontVariant: ['tabular-nums'] },
  projectCopy: { padding: 12, gap: 4 },
  projectTitle: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 14 },
  projectMeta: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 10 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  emptyCard: { alignItems: 'center', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', borderRadius: 20, padding: 36, gap: 8 },
  emptyIcon: { color: colors.purple, fontSize: 28 },
  emptyTitle: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 15 },
  empty: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 13, textAlign: 'center' },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 12 },
});
