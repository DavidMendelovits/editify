import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { Alert, Image, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NewProject, Project, ProjectFormat } from '@editify/shared';
import { Brand } from '../src/components/Brand';
import { Button } from '../src/components/Button';
import { ImportSheet } from '../src/components/ImportSheet';
import { ReportModal } from '../src/components/ReportModal';
import { Screen } from '../src/components/Screen';
import { api, assetThumbUrl } from '../src/lib/api';
import { supabase } from '../src/lib/supabase';
import { captureScreen, type Screenshot } from '../src/lib/capture';
import { setReportContext, track } from '../src/lib/telemetry';
import { colors, radius, space, type, fonts } from '../src/lib/theme';
import { appVersion } from '../src/lib/version';

const formats: Array<{ label: string; format: ProjectFormat; meta: string }> = [
  { label: 'Instagram Reel', format: '9:16', meta: '9:16 · UP TO 90S' },
  { label: 'TikTok', format: '9:16', meta: '9:16 · 15-60S' },
  { label: 'YouTube', format: '16:9', meta: '16:9 · LONG FORM' },
];

export default function HomeScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Taken before the sheet covers the screen. It stays in memory unless the
  // user attaches it.
  const [shot, setShot] = useState<Screenshot>();
  const [accountError, setAccountError] = useState<string>();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const create = useMutation({
    mutationFn: (input: NewProject) => api.createProject(input),
    onSuccess: async (project) => {
      await client.invalidateQueries({ queryKey: ['projects'] });
      router.push({ pathname: '/project/[id]', params: { id: project.id } });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: async () => { track('project_delete'); await client.invalidateQueries({ queryKey: ['projects'] }); },
  });

  // App Store guideline 5.1.1(v). The server erases the rows, the media and the
  // Supabase login; signing out is what sends the root layout to /sign-in.
  const deleteAccount = async (): Promise<void> => {
    try {
      track('account_delete');
      await api.deleteAccount();
      await supabase.auth.signOut();
      router.replace('/sign-in');
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : String(error));
    }
  };

  // Feedback sent from here cannot name a project, so it says what this screen
  // does know: how many cuts the user has and whether the list even loaded.
  const snapshot = useRef({ projects });
  snapshot.current = { projects };
  // Focus-scoped, not mount-scoped: the router keeps this screen mounted behind
  // the editor, so the screen the user is actually looking at owns the context.
  useFocusEffect(useCallback(() => setReportContext(() => {
    const query = snapshot.current.projects;
    return {
      screen: 'home',
      projectCount: query.data?.length ?? 0,
      projectsLoaded: !query.isLoading && !query.error,
      ...(query.error ? { projectsError: query.error.message.slice(0, 200) } : {}),
    };
  }), []));

  return (
    <Screen header={
      <View style={styles.header}>
        <Brand />
        <View style={styles.headerActions}>
          <Text style={styles.version}>{appVersion}</Text>
          <Button secondary style={styles.styleButton} onPress={() => setImportOpen(true)}>import media</Button>
          <Button secondary style={styles.styleButton} onPress={() => router.push('/style')}>learn my style</Button>
          <Button accessibilityLabel="send feedback" secondary style={styles.styleButton} onPress={() => { track('feedback_open', 'home'); void captureScreen().then(setShot); setFeedbackOpen(true); }}>send feedback</Button>
          <Button accessibilityLabel="sign out" secondary style={styles.signOutButton} onPress={() => { void supabase.auth.signOut(); }}>sign out</Button>
          <Button accessibilityLabel="delete account" secondary style={styles.signOutButton} onPress={() => confirmDeleteAccount(() => { void deleteAccount(); })}>delete account</Button>
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
            onPress={() => { track('project_create', item.label); create.mutate({ title: `${item.label} edit`, format: item.format, fps: 30 }); }}
            style={({ pressed }) => [styles.formatRow, pressed && styles.pressed]}
          >
            <View style={styles.rowFormat}><Text style={styles.rowFormatText}>{item.format}</Text></View>
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
        <View style={styles.emptyCard}><Text style={styles.empty}>Choose a format above to start a project.</Text></View>
      )}
      <View style={styles.projectGrid}>
        {projects.data?.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })}
            onExport={() => router.push({ pathname: '/project/[id]/export', params: { id: project.id } })}
            onDelete={() => remove.mutate(project.id)}
          />
        ))}
      </View>
      {remove.error && <Text style={styles.error}>Could not delete: {remove.error.message}</Text>}
      {accountError && <Text style={styles.error}>Could not delete your account: {accountError}</Text>}
      {feedbackOpen && (
        <ReportModal
          mode="feedback"
          {...(shot ? { screenshot: shot } : {})}
          onClose={() => { setFeedbackOpen(false); setShot(undefined); }}
        />
      )}
      <ImportSheet
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { void client.invalidateQueries({ queryKey: ['importable'] }); }}
      />
    </Screen>
  );
}

/**
 * Native gets the destructive Alert; react-native-web's `Alert.alert` is a
 * no-op stub, so the browser build asks with the one confirm it does have.
 */
function confirmDeleteAccount(onConfirm: () => void): void {
  const body = 'This erases your projects, media and login. It cannot be undone.';
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`Delete your account?\n\n${body}`)) onConfirm();
    return;
  }
  Alert.alert('Delete your account?', body, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}

/** Recent-project tile: poster frame, title, format badge, duration, clip count. */
function ProjectCard({ project, onPress, onExport, onDelete }: {
  project: Project; onPress: () => void; onExport: () => void; onDelete: () => void;
}) {
  const assetId = project.tracks.flatMap((track) => track.clips).find((clip) => clip.assetId)?.assetId;
  const clipCount = project.tracks.reduce((total, track) => total + track.clips.length, 0);
  const captionCount = project.tracks.filter((track) => track.kind === 'caption').reduce((total, track) => total + track.clips.length, 0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The menu sits inside the card's Pressable, so every press it owns has to
  // stop there or the card would navigate out from under the menu.
  const swallow = (event: { stopPropagation?: () => void }, run: () => void) => { event.stopPropagation?.(); run(); };
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.projectCard, pressed && styles.pressed]}>
      <View style={styles.poster}>
        {assetId
          ? <Image source={{ uri: assetThumbUrl(assetId) }} style={styles.posterImage} resizeMode="cover" />
          : <Text style={styles.posterText}>EMPTY TIMELINE</Text>}
        <View style={styles.formatBadge}><Text style={styles.formatBadgeText}>{project.format}</Text></View>
        <View style={styles.durationBadge}><Text style={styles.durationBadgeText}>{formatDuration(project.duration)}</Text></View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="project menu"
          hitSlop={8}
          onPress={(event) => swallow(event, () => setMenuOpen((open) => !open))}
          style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}
        >
          <Text style={styles.menuGlyph}>⋯</Text>
        </Pressable>
        {menuOpen && (
          <View style={styles.menu}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Export video"
              onPress={(event) => swallow(event, () => { setMenuOpen(false); onExport(); })}
              style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}
            >
              <Text style={styles.menuItemText}>Export video</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete project"
              onPress={(event) => swallow(event, () => { setMenuOpen(false); setConfirming(true); })}
              style={({ pressed }) => [styles.menuItem, styles.menuItemLast, pressed && styles.pressed]}
            >
              <Text style={[styles.menuItemText, styles.menuItemDanger]}>Delete project</Text>
            </Pressable>
          </View>
        )}
      </View>
      <Modal visible={confirming} transparent animationType="fade" onRequestClose={() => setConfirming(false)}>
        <Pressable style={styles.dialogBackdrop} onPress={() => setConfirming(false)}>
          <Pressable style={styles.dialog} onPress={() => undefined}>
            <Text style={styles.dialogTitle}>Delete “{project.title}”?</Text>
            <Text style={styles.dialogBody}>
              This removes the project and its rendered exports. Media stays in your library for other projects.
            </Text>
            <View style={styles.dialogActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                onPress={() => setConfirming(false)}
                style={({ pressed }) => [styles.dialogButton, pressed && styles.pressed]}
              >
                <Text style={styles.dialogButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete"
                onPress={() => { setConfirming(false); onDelete(); }}
                style={({ pressed }) => [styles.dialogButton, styles.dialogDanger, pressed && styles.pressed]}
              >
                <Text style={[styles.dialogButtonText, styles.menuItemDanger]}>Delete</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.xl },
  styleButton: { minHeight: 32, paddingHorizontal: space.xl },
  signOutButton: { minHeight: 32, paddingHorizontal: space.xl },
  version: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1 },
  hero: { paddingTop: space.section, paddingBottom: space.lg, gap: space.lg, maxWidth: 900, width: '100%', alignSelf: 'center' },
  kicker: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.6 },
  formatList: { gap: space.lg, maxWidth: 900, width: '100%', alignSelf: 'center' },
  formatRow: { flexDirection: 'row', alignItems: 'center', gap: space.xl, paddingVertical: space.xl, paddingHorizontal: space.xxl, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  rowFormat: { width: 44, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center' },
  rowFormatText: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.5 },
  rowCopy: { flex: 1, gap: space.xs },
  rowTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xl },
  rowMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.4 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  sectionHeader: { marginTop: space.xl, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  sectionTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.title, letterSpacing: -0.8 },
  count: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.md, letterSpacing: 1.3 },
  projectGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xl },
  projectCard: { flexGrow: 1, flexBasis: 250, maxWidth: 340, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  poster: { height: 120, backgroundColor: colors.panelSunken, alignItems: 'center', justifyContent: 'center' },
  posterImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  posterText: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.4 },
  formatBadge: { position: 'absolute', top: 8, left: 8, borderRadius: radius.md, backgroundColor: '#00000099', paddingHorizontal: space.md, paddingVertical: space.xs },
  formatBadgeText: { color: '#FFFFFF', fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.8 },
  durationBadge: { position: 'absolute', bottom: 8, right: 8, borderRadius: radius.md, backgroundColor: '#00000099', paddingHorizontal: space.md, paddingVertical: space.xs },
  durationBadgeText: { color: '#FFFFFF', fontFamily: fonts.semibold, fontSize: type.xs, fontVariant: ['tabular-nums'] },
  menuButton: { position: 'absolute', top: 6, right: 6, width: 30, height: 30, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000000AA' },
  menuGlyph: { color: '#FFFFFF', fontFamily: fonts.bold, fontSize: type.xxl, lineHeight: 16 },
  menu: { position: 'absolute', top: 38, right: 6, minWidth: 152, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, overflow: 'hidden' },
  menuItem: { paddingHorizontal: space.xl, paddingVertical: space.xl, borderBottomWidth: 1, borderBottomColor: colors.border },
  menuItemLast: { borderBottomWidth: 0 },
  menuItemText: { color: colors.text, fontFamily: fonts.medium, fontSize: type.lg },
  menuItemDanger: { color: colors.danger },
  dialogBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.section, backgroundColor: '#000000AA' },
  dialog: { width: '100%', maxWidth: 380, gap: space.xl, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.section },
  dialogTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  dialogBody: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 18 },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.xl, marginTop: space.sm },
  dialogButton: { minHeight: 38, paddingHorizontal: space.xxl, justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  dialogDanger: { borderColor: colors.danger },
  dialogButtonText: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg },
  projectCopy: { padding: space.xl, gap: space.sm },
  projectTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.xl },
  projectMeta: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.lg, flexWrap: 'wrap' },
  emptyCard: { alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', borderRadius: radius.md, padding: space.section, gap: space.md },
  empty: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg, textAlign: 'center' },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.lg },
});
