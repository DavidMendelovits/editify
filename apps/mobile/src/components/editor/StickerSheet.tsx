import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { AssetMetadata, Callout } from '@editify/shared';
import { uploadAsset } from '../../lib/api';
import { colors, radius, space, type, fonts } from '../../lib/theme';

/** The three card treatments, in the order they read: right, wrong, plain. */
const CALLOUT_VARIANTS: readonly { variant: Callout['variant']; glyph: string; label: string }[] = [
  { variant: 'check', glyph: '✓', label: 'check' },
  { variant: 'x', glyph: '✗', label: 'x' },
  { variant: 'card', glyph: '▢', label: 'plain card' },
];

/** The short-form editing staples; anything else can be typed in below. */
const EMOJI = [
  '🔥', '😂', '💀', '😭', '❤️', '👀', '💯', '✨', '🎉', '👇', '👆', '➡️',
  '⚠️', '❗', '❓', '🤯', '🫡', '😅', '🥹', '🤣', '😳', '🙏', '💪', '🧠',
  '🎬', '🎤', '🔊', '📢', '💰', '📈', '🚀', '⭐', '🏆', '⏰', '🍿', '🤝',
];

interface Props {
  projectId: string;
  visible: boolean;
  onClose: () => void;
  /** Adds an emoji sticker at the playhead. */
  onAddEmoji: (emoji: string) => void;
  /** Adds an uploaded image/GIF sticker at the playhead. */
  onAddImage: (asset: AssetMetadata) => void;
  /** Adds a callout card — one line of text on a rounded plate — at the playhead. */
  onAddCallout: (callout: { variant: Callout['variant']; text: string }) => void;
}

/**
 * Sticker picker: an emoji grid, a free-text emoji field, and an image/GIF
 * import from the photo library. Selection closes the sheet — the sticker
 * lands at the playhead and is immediately draggable on the preview.
 */
export function StickerSheet({ projectId, visible, onClose, onAddEmoji, onAddImage, onAddCallout }: Props) {
  const [custom, setCustom] = useState('');
  const [line, setLine] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  function addEmoji(emoji: string): void {
    onAddEmoji(emoji);
    setCustom('');
    onClose();
  }

  function addCallout(variant: Callout['variant']): void {
    const text = line.trim();
    if (!text) return;
    onAddCallout({ variant, text });
    setLine('');
    onClose();
  }

  async function pickImage(): Promise<void> {
    setError(undefined);
    let picked: ImagePicker.ImagePickerResult;
    try {
      picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false });
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : 'Could not open the photo library');
      return;
    }
    const file = picked.assets?.[0];
    if (picked.canceled || !file) return;
    setUploading(true);
    try {
      const asset = await uploadAsset({
        uri: file.uri,
        name: file.fileName ?? `sticker-${Date.now()}.png`,
        mimeType: file.mimeType ?? 'image/png',
        projectId,
      });
      onAddImage(asset);
      onClose();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>STICKERS</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="close" hitSlop={10} onPress={onClose}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>lands at the playhead · drag it on the preview to place it</Text>
          <ScrollView style={styles.body} nestedScrollEnabled>
            <View style={styles.grid}>
              {EMOJI.map((emoji) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={`add ${emoji} sticker`}
                  onPress={() => addEmoji(emoji)}
                  style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
                >
                  <Text style={styles.cellEmoji}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.customRow}>
              <TextInput
                value={custom}
                onChangeText={setCustom}
                placeholder="any emoji or short text…"
                placeholderTextColor={colors.muted}
                style={styles.input}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="add custom sticker"
                disabled={!custom.trim()}
                onPress={() => addEmoji(custom.trim())}
                style={({ pressed }) => [styles.add, pressed && styles.pressed, !custom.trim() && styles.disabled]}
              >
                <Text style={styles.addText}>add</Text>
              </Pressable>
            </View>
            <Text style={styles.section}>CALLOUTS</Text>
            <View style={styles.calloutRow}>
              <TextInput
                value={line}
                onChangeText={setLine}
                placeholder="one point per card"
                placeholderTextColor={colors.muted}
                style={styles.input}
              />
              {CALLOUT_VARIANTS.map(({ variant, glyph, label }) => (
                <Pressable
                  key={variant}
                  accessibilityRole="button"
                  accessibilityLabel={`add ${label} callout`}
                  disabled={!line.trim()}
                  onPress={() => addCallout(variant)}
                  style={({ pressed }) => [styles.calloutButton, pressed && styles.pressed, !line.trim() && styles.disabled]}
                >
                  <Text style={styles.calloutGlyph}>{glyph}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="import image or GIF sticker"
              disabled={uploading}
              onPress={() => void pickImage()}
              style={({ pressed }) => [styles.imageButton, pressed && styles.pressed, uploading && styles.disabled]}
            >
              <Text style={styles.imageButtonText}>{uploading ? 'uploading…' : 'image / GIF from photos'}</Text>
            </Pressable>
            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000AA' },
  sheet: {
    maxHeight: '72%', borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.xxl, gap: space.lg,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  close: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.xl, padding: space.sm },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm },
  body: { minHeight: 200 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingVertical: space.lg },
  cell: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panelRaised },
  cellEmoji: { fontSize: type.title },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingVertical: space.lg },
  input: {
    flex: 1, minHeight: 44, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, color: colors.text, paddingHorizontal: space.xl,
    fontFamily: fonts.medium, fontSize: type.lg,
  },
  add: {
    minWidth: 64, minHeight: 44, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accentStrong,
  },
  addText: { color: '#FFFFFF', fontFamily: fonts.bold, fontSize: type.lg },
  section: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5, paddingTop: space.sm },
  calloutRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingVertical: space.lg },
  calloutButton: {
    width: 44, height: 44, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panelRaised,
  },
  calloutGlyph: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xxl },
  imageButton: {
    minHeight: 48, borderRadius: radius.lg, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', marginTop: space.sm,
  },
  imageButtonText: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.md, paddingTop: space.lg },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.65 },
});
