import { useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { AssetMetadata } from '@editify/shared';
import { colors } from '../lib/theme';
import { api } from '../lib/api';
import { track } from '../lib/telemetry';
import { formatMegabytes } from '../lib/agent';

type ImportState = 'queued' | 'importing' | 'done' | 'error';

interface Props {
  /** Imports land in this project's library. Omitted on the home screen, where
   *  there is no project yet — those clips stay unattached until one adopts them. */
  projectId?: string;
  visible: boolean;
  onClose: () => void;
  onImported: (asset: AssetMetadata) => void;
}

/**
 * Media sheet for `GET /assets/importable` — the local test-clip drop folder.
 * Imports run strictly one at a time (ffprobe + proxy + thumbnail is slow on
 * big files); extra taps queue up behind the running one.
 */
export function ImportSheet({ projectId, visible, onClose, onImported }: Props) {
  const files = useQuery({ queryKey: ['importable'], queryFn: () => api.listImportable(), enabled: visible });
  const [states, setStates] = useState<Record<string, ImportState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Promise chain that serializes imports without blocking the UI thread.
  const queue = useRef<Promise<void>>(Promise.resolve());

  function enqueue(name: string): void {
    if (states[name]) return;
    setStates((current) => ({ ...current, [name]: 'queued' }));
    queue.current = queue.current.then(async () => {
      setStates((current) => ({ ...current, [name]: 'importing' }));
      try {
        const asset = await api.importAsset(name, projectId);
        track('import', name);
        setStates((current) => ({ ...current, [name]: 'done' }));
        onImported(asset);
        await files.refetch();
      } catch (error) {
        setStates((current) => ({ ...current, [name]: 'error' }));
        setErrors((current) => ({ ...current, [name]: error instanceof Error ? error.message : 'Import failed' }));
      }
    });
  }

  const list = files.data ?? [];
  const pending = Object.values(states).filter((state) => state === 'queued' || state === 'importing').length;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Nesting the sheet inside the backdrop keeps tap-to-dismiss working
          without relying on pointer-event pass-through, which react-native-web
          does not honour from styles. The inner Pressable swallows the tap. */}
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="close import sheet">
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>MEDIA</Text>
              <Text style={styles.title}>import test clip</Text>
              <Text style={styles.subtitle}>
                {pending > 0 ? `${pending} in queue · importing one at a time` : 'files sitting in the server media folder'}
              </Text>
            </View>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]} accessibilityRole="button">
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {files.isLoading && (
              <View style={styles.stateRow}><ActivityIndicator color={colors.purple} /><Text style={styles.stateText}>looking for clips…</Text></View>
            )}
            {files.error && <Text style={styles.error}>{files.error.message}</Text>}
            {!files.isLoading && !files.error && list.length === 0 && (
              <Text style={styles.empty}>No importable files. Drop videos into the server’s media import folder and reopen this sheet.</Text>
            )}
            {list.map((file) => {
              const state = states[file.name];
              const inLibrary = file.alreadyImported || state === 'done';
              const busy = state === 'queued' || state === 'importing';
              return (
                <Pressable
                  key={file.name}
                  onPress={() => enqueue(file.name)}
                  disabled={busy}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.file, pressed && !busy && styles.pressed, state === 'error' && styles.fileError]}
                >
                  <View style={styles.fileText}>
                    <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
                    <Text style={styles.fileMeta}>
                      {formatMegabytes(file.size)}
                      {state === 'queued' ? ' · queued' : ''}
                      {state === 'importing' ? ' · processing' : ''}
                    </Text>
                    {state === 'error' && <Text style={styles.error} numberOfLines={2}>{errors[file.name]}</Text>}
                  </View>
                  {busy ? <ActivityIndicator color={colors.purple} />
                    : inLibrary ? <View style={styles.badge}><Text style={styles.badgeText}>IN LIBRARY</Text></View>
                    : <Text style={styles.importCue}>import ↓</Text>}
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#04040899', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { width: '100%', maxWidth: 460, maxHeight: '82%', borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 16, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 12 },
  headerText: { flex: 1, gap: 4 },
  eyebrow: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 1.5 },
  title: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 17 },
  subtitle: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 10 },
  close: { width: 30, height: 30, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: colors.muted, fontSize: 17, lineHeight: 20 },
  list: { flexGrow: 0 },
  listContent: { gap: 7, paddingVertical: 2 },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 10 },
  stateText: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 11 },
  empty: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 11, lineHeight: 17, paddingVertical: 8 },
  file: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: 12, paddingVertical: 9 },
  fileError: { borderColor: '#5A2836' },
  fileText: { flex: 1, gap: 3 },
  fileName: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 12 },
  fileMeta: { color: colors.muted, fontFamily: 'Montserrat_500Medium', fontSize: 9 },
  badge: { borderRadius: 20, backgroundColor: '#1D3B2C', paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { color: colors.success, fontFamily: 'Montserrat_700Bold', fontSize: 8, letterSpacing: 0.8 },
  importCue: { color: colors.purple, fontFamily: 'Montserrat_700Bold', fontSize: 10 },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 10 },
  pressed: { opacity: 0.7 },
});
