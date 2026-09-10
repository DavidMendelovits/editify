import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetMetadata } from '@editify/shared';
import { api, assetThumbUrl } from '../lib/api';
import { formatTimecode } from '../lib/timeline';
import { colors, radius, space, type, fonts } from '../lib/theme';

interface Props {
  projectId: string;
  /** A source picker is running — every add button is disabled meanwhile. */
  busy: boolean;
  /** Set only while a multi-file import is uploading, one clip at a time. */
  progress?: { done: number; total: number };
  error?: string;
  onPickPhotos: () => void;
  onPickFiles: () => void;
  onOpenFolder: () => void;
  /** Drop a library asset onto the end of the timeline. */
  onAdd: (asset: AssetMetadata) => void;
}

/** Invalidate this after any import, upload or link — it covers every project and scope. */
export const LIBRARY_ROOT = ['library'] as const;

function libraryKey(projectId: string, scope: Scope): [string, string, Scope] {
  return ['library', projectId, scope];
}

type Scope = 'project' | 'all';

/**
 * The media library. It shows this project's own imports — nothing another
 * project pulled in — with an "all clips" scope for borrowing footage across
 * projects (Final Cut's library/event split). Adding a borrowed clip adopts it
 * into this project. Tap a card to append it to the timeline, tap its name to
 * relabel it.
 */
export function MediaLibrary({ projectId, busy, progress, error, onPickPhotos, onPickFiles, onOpenFolder, onAdd }: Props) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>('project');
  const library = useQuery({
    queryKey: libraryKey(projectId, scope),
    queryFn: () => api.listAssets(scope === 'project' ? projectId : undefined),
    // Imports land instantly and finish encoding in the background — follow them until they do.
    refetchInterval: (query) => (query.state.data?.some((asset) => asset.status === 'processing') ? 1500 : false),
  });
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');
  // Mirrors `editingId` synchronously so the blur that follows a submit does not
  // fire a second rename off a stale closure.
  const editing = useRef<string | undefined>(undefined);

  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => api.setAssetLabel(id, label),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: LIBRARY_ROOT }); },
  });

  /** Borrowing from "all clips" adopts the asset, so it stops being someone else's. */
  function add(asset: AssetMetadata): void {
    onAdd(asset);
    if (scope === 'project') return;
    void api.linkAsset(projectId, asset.id)
      .then(async () => { await queryClient.invalidateQueries({ queryKey: LIBRARY_ROOT }); })
      .catch(() => undefined);
  }

  function startEdit(asset: AssetMetadata): void {
    editing.current = asset.id;
    setEditingId(asset.id);
    setDraft(asset.label ?? '');
  }

  function commitEdit(id: string): void {
    if (editing.current !== id) return;
    editing.current = undefined;
    setEditingId(undefined);
    rename.mutate({ id, label: draft });
  }

  const assets = library.data ?? [];

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <View style={styles.scopeRow}>
            <Text style={styles.eyebrow}>LIBRARY</Text>
            <Pressable
              onPress={() => setScope(scope === 'project' ? 'all' : 'project')}
              accessibilityRole="button"
              accessibilityLabel={scope === 'project' ? 'show clips from every project' : 'show only this project'}
              style={({ pressed }) => [styles.scope, pressed && styles.pressed]}
            >
              <Text style={styles.scopeText}>{scope === 'project' ? 'this project' : 'all clips'}</Text>
            </Pressable>
          </View>
          <Text style={styles.count}>
            {progress ? `importing ${progress.done} of ${progress.total} · one at a time`
              : library.isLoading ? 'loading…'
              : `${assets.length} clip${assets.length === 1 ? '' : 's'} · ${scope === 'project' ? 'imported into this project' : 'every project · adding adopts a clip'}`}
          </Text>
        </View>
        <View style={styles.sources}>
          <Source label="photos" hint="device library" onPress={onPickPhotos} disabled={busy} />
          <Source label="files" hint="documents" onPress={onPickFiles} disabled={busy} />
          <Source label="folder" hint="server media" onPress={onOpenFolder} disabled={busy} />
          {busy && <ActivityIndicator color={colors.accent} />}
        </View>
      </View>

      {(error ?? library.error) && <Text style={styles.error}>{error ?? library.error?.message}</Text>}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
        {!library.isLoading && assets.length === 0 && (
          <Text style={styles.empty}>
            {scope === 'project'
              ? 'No media in this project yet. Add from photos, files, or the server media folder.'
              : 'Nothing on the server yet. Pull a clip in from photos, files, or the server media folder.'}
          </Text>
        )}
        {assets.map((asset) => (
          <View key={asset.id} style={styles.card}>
            <Pressable
              onPress={() => add(asset)}
              accessibilityRole="button"
              accessibilityLabel={`add ${asset.label ?? asset.originalName} to the timeline`}
              style={({ pressed }) => [styles.thumbWrap, pressed && styles.pressed]}
            >
              {/* Mounted only once ready: a thumb requested mid-processing 409s and
                  the failed load would stick to the unchanged URI. */}
              {asset.status === 'ready'
                ? <Image source={{ uri: assetThumbUrl(asset.id) }} style={styles.thumb} resizeMode="cover" />
                : <View style={styles.thumb} />}
              {asset.status !== 'ready' && (
                <View style={styles.processing}>
                  {asset.status === 'processing' && <ActivityIndicator size="small" color={colors.accent} />}
                  <Text style={styles.processingText}>{asset.status === 'processing' ? 'processing…' : 'failed'}</Text>
                </View>
              )}
              <Text style={styles.duration}>{formatTimecode(asset.duration, false)}</Text>
              <View style={styles.addCue}><Text style={styles.addCueText}>+</Text></View>
            </Pressable>
            {editingId === asset.id ? (
              <TextInput
                autoFocus
                // Unlabelled cards start empty — the file name is only a placeholder,
                // so typing a label does not mean deleting the name first.
                value={draft}
                onChangeText={setDraft}
                placeholder={asset.originalName}
                placeholderTextColor={colors.muted}
                style={styles.nameInput}
                onSubmitEditing={() => commitEdit(asset.id)}
                onBlur={() => commitEdit(asset.id)}
              />
            ) : (
              <Pressable onPress={() => startEdit(asset)} accessibilityRole="button" accessibilityLabel={`rename ${asset.originalName}`}>
                <Text style={[styles.name, !asset.label && styles.nameUnlabelled]} numberOfLines={1}>
                  {asset.label ?? asset.originalName}
                </Text>
              </Pressable>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function Source({ label, hint, onPress, disabled }: { label: string; hint: string; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`add media from ${hint}`}
      style={({ pressed }) => [styles.source, pressed && styles.pressed, disabled && styles.sourceDisabled]}
    >
      <Text style={styles.sourceText}>+ {label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.lg, gap: space.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.lg },
  headerText: { gap: space.xs, flexShrink: 1 },
  scopeRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  scope: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: space.lg, paddingVertical: space.xs },
  scopeText: { color: colors.text, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.6 },
  eyebrow: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.5 },
  count: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.sm },
  sources: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  source: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, paddingHorizontal: space.lg, paddingVertical: space.md },
  sourceDisabled: { opacity: 0.45 },
  sourceText: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.sm },
  strip: { gap: space.lg, paddingVertical: space.xs, alignItems: 'flex-start' },
  empty: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md, lineHeight: 16, maxWidth: 460, paddingVertical: space.xl },
  card: { width: 128, gap: space.sm },
  thumbWrap: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  thumb: { width: '100%', height: 72 },
  processing: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: '#0404089C' },
  processingText: { color: colors.text, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 0.6 },
  duration: { position: 'absolute', left: 5, bottom: 5, color: colors.text, fontFamily: fonts.bold, fontSize: type.xs, backgroundColor: '#04040899', paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md },
  addCue: { position: 'absolute', right: 5, bottom: 5, width: 18, height: 18, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentStrong },
  addCueText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.base, lineHeight: 13 },
  name: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.md },
  nameUnlabelled: { color: colors.muted, fontFamily: fonts.medium },
  nameInput: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent, paddingHorizontal: space.md, paddingVertical: space.xs },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.md },
  pressed: { opacity: 0.7 },
});
