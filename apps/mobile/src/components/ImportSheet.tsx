import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { AssetMetadata } from '@editify/shared';
import { colors, radius, space, type, fonts } from '../lib/theme';
import { api, IS_LOCAL_API } from '../lib/api';
import { track } from '../lib/telemetry';
import { formatMegabytes } from '../lib/agent';
import { pickFromFiles, pickFromPhotos, uploadFiles, type PickResult } from '../lib/pick';

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
 * Media sheet: upload from this machine (picker or, on web, drag-and-drop), with
 * the server's own drop folder kept as a secondary section when it has anything.
 * That folder is a dev-machine affordance, so the section is asked for only when
 * the API is local; against the hosted backend it would always be empty.
 * Those folder imports run strictly one at a time (ffprobe + proxy + thumbnail is
 * slow on big files); extra taps queue up behind the running one.
 */
export function ImportSheet({ projectId, visible, onClose, onImported }: Props) {
  const files = useQuery({ queryKey: ['importable'], queryFn: () => api.listImportable(), enabled: visible && IS_LOCAL_API });
  const [states, setStates] = useState<Record<string, ImportState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Promise chain that serializes imports without blocking the UI thread.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const dropRef = useRef<View>(null);
  const [dropping, setDropping] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number }>();
  const [uploadError, setUploadError] = useState<string>();

  async function upload(run: () => Promise<PickResult>): Promise<void> {
    setUploading(true);
    setUploadError(undefined);
    setUploadProgress(undefined);
    try {
      const { assets, failed } = await run();
      for (const asset of assets) onImported(asset);
      if (assets.length > 0) track('import', `upload:${assets.length}`);
      if (failed.length > 0) setUploadError(`Could not upload ${failed.length} of ${assets.length + failed.length}: ${failed.join(', ')}`);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgress(undefined);
    }
  }

  function onProgress(done: number, total: number): void {
    setUploadProgress(total > 1 ? { done, total } : undefined);
  }

  // react-native-web 0.21 picks View props from a whitelist that has no drag
  // events, so the DOM node has to be wired by hand. Native has nothing to drop.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const node = dropRef.current as unknown as HTMLElement | null;
    if (!node) return;
    // Without preventDefault the browser navigates to the dropped file.
    const onOver = (event: DragEvent): void => { event.preventDefault(); setDropping(true); };
    // A bubbling dragleave off a child is not a leave; only a pointer that left
    // the zone should clear the highlight.
    const onLeave = (event: DragEvent): void => {
      if (!node.contains(event.relatedTarget as Node | null)) setDropping(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      setDropping(false);
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (dropped.length > 0) void upload(async () => await uploadFiles(projectId, dropped, onProgress));
    };
    node.addEventListener('dragover', onOver);
    node.addEventListener('dragleave', onLeave);
    node.addEventListener('drop', onDrop);
    return () => {
      node.removeEventListener('dragover', onOver);
      node.removeEventListener('dragleave', onLeave);
      node.removeEventListener('drop', onDrop);
    };
  }, [visible, projectId]);

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
              <Text style={styles.title}>import media</Text>
              <Text style={styles.subtitle}>
                {pending > 0 ? `${pending} in queue · importing one at a time` : 'video and audio from this device'}
              </Text>
            </View>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]} accessibilityRole="button">
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          <Pressable
            ref={dropRef}
            onPress={() => void upload(async () => await pickFromFiles(projectId, onProgress))}
            disabled={uploading}
            accessibilityRole="button"
            accessibilityLabel="choose files to import"
            style={({ pressed }) => [styles.drop, dropping && styles.dropActive, pressed && !uploading && styles.pressed, uploadError && styles.dropError]}
          >
            {uploading ? <ActivityIndicator color={colors.accent} /> : null}
            <Text style={styles.dropTitle}>
              {dropping ? 'drop to upload'
                : uploadProgress ? `uploading ${uploadProgress.done} of ${uploadProgress.total}…`
                : uploading ? 'uploading…'
                : 'choose files'}
            </Text>
            {!uploading && (
              <Text style={styles.dropHint}>
                {Platform.OS === 'web' ? 'or drag videos here from your machine' : 'video and audio from your device'}
              </Text>
            )}
            {uploadError ? <Text style={styles.error} numberOfLines={3}>{uploadError}</Text> : null}
          </Pressable>

          <Pressable
            onPress={() => void upload(async () => await pickFromPhotos(projectId, onProgress))}
            disabled={uploading}
            accessibilityRole="button"
            accessibilityLabel="import from photo library"
            testID="import-sheet-photos"
            style={({ pressed }) => [styles.file, pressed && !uploading && styles.pressed, uploading && styles.disabled]}
          >
            <View style={styles.fileText}>
              <Text style={styles.fileName}>photo library</Text>
              <Text style={styles.fileMeta}>videos from your camera roll</Text>
            </View>
            <Text style={styles.importCue}>open ↗</Text>
          </Pressable>

          {IS_LOCAL_API && list.length > 0 && <Text style={styles.section}>or from the server media folder</Text>}

          {IS_LOCAL_API && (files.isLoading || files.error || list.length > 0) && (
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {files.isLoading && (
              <View style={styles.stateRow}><ActivityIndicator color={colors.accent} /><Text style={styles.stateText}>looking for clips…</Text></View>
            )}
            {files.error && <Text style={styles.error}>{files.error.message}</Text>}
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
                  {busy ? <ActivityIndicator color={colors.accent} />
                    : inLibrary ? <View style={styles.badge}><Text style={styles.badgeText}>IN LIBRARY</Text></View>
                    : <Text style={styles.importCue}>import ↓</Text>}
                </Pressable>
              );
            })}
          </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#04040899', alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  sheet: { width: '100%', maxWidth: 460, maxHeight: '82%', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.xxl, gap: space.xl },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xl, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: space.xl },
  headerText: { flex: 1, gap: space.sm },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md },
  close: { width: 30, height: 30, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: colors.muted, fontSize: type.xxl, lineHeight: 20 },
  drop: { alignItems: 'center', justifyContent: 'center', gap: space.sm, minHeight: 116, borderRadius: radius.lg, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, backgroundColor: colors.panelRaised, padding: space.xl },
  dropActive: { borderColor: colors.accent, borderStyle: 'solid' },
  dropError: { borderColor: colors.danger },
  dropTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: type.lg },
  dropHint: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md },
  section: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.sm, letterSpacing: 0.4 },
  list: { flexGrow: 0 },
  listContent: { gap: space.md, paddingVertical: space.xs },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingVertical: space.lg },
  stateText: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base },
  file: { flexDirection: 'row', alignItems: 'center', gap: space.xl, minHeight: 54, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: space.xl, paddingVertical: space.lg },
  fileError: { borderColor: colors.danger },
  fileText: { flex: 1, gap: space.xs },
  fileName: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg },
  fileMeta: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.sm },
  badge: { borderRadius: radius.lg, backgroundColor: colors.successSoft, paddingHorizontal: space.lg, paddingVertical: space.sm },
  badgeText: { color: colors.success, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.8 },
  importCue: { color: colors.accent, fontFamily: fonts.bold, fontSize: type.md },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.md },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.38 },
});
