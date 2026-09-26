import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AssetMetadata, CaptionStyle, Clip, ClipTransform, ClipTransition, Operation } from '@editify/shared';
import { clipTimelineDuration } from '@editify/shared';
import { colors, radius, space, type, fonts } from '../../lib/theme';
import { formatTimecode } from '../../lib/timeline';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const VOLUME_STEP = 0.1;

/**
 * Two-pose zoom presets (iMovie's Ken Burns mental model): a start transform,
 * an end transform, tweened across the clip. ~8–15% pushes read as intentional
 * without making viewers seasick.
 */
const IDENTITY: ClipTransform = { scale: 1, x: 0, y: 0 };
const ZOOM_PRESETS: Array<{ key: string; label: string; from: ClipTransform; to?: ClipTransform }> = [
  { key: 'none', label: 'none', from: IDENTITY },
  { key: 'punch', label: 'punch in', from: IDENTITY, to: { scale: 1.12, x: 0, y: 0 } },
  { key: 'push', label: 'slow push', from: IDENTITY, to: { scale: 1.06, x: 0, y: 0 } },
  { key: 'pull', label: 'pull back', from: { scale: 1.12, x: 0, y: 0 }, to: IDENTITY },
];

/**
 * Transition INTO the clip (video track only). The duration chips re-emit the
 * active type, so type and duration always travel as one operation.
 */
const TRANSITIONS: Array<{ key: ClipTransition['type']; label: string }> = [
  { key: 'crossfade', label: 'crossfade' },
  { key: 'dip', label: 'dip to black' },
];
const TRANSITION_DURATIONS = [0.3, 0.5, 1];
const DEFAULT_TRANSITION_DURATION = 0.5;

/** Where the caption draws in the frame — the same three the style schema allows. */
const CAPTION_POSITIONS: Array<CaptionStyle['position']> = ['top', 'center', 'bottom'];

/** Caption size as a share of frame height, stepped inside the schema's 1–25 range. */
const CAPTION_SIZE_STEP = 0.5;
const CAPTION_SIZE_MIN = 1;
const CAPTION_SIZE_MAX = 25;
/**
 * A short palette, not a picker: white plus the fills the style packets reach
 * for. No font row — Space Grotesk (preview) and Montserrat (export) are the
 * only families bundled, so a family picker would change nothing.
 */
const CAPTION_COLORS = ['#FFFFFF', '#FACC15', '#4ADE80', '#F472B6', '#111111'];
const CAPTION_EMPHASES: Array<CaptionStyle['emphasis']> = ['none', 'bold', 'highlight'];

const STICKER_SIZE_STEP = 0.04;
const STICKER_ROTATION_STEP = 15;

/** One sync attempt on an audio clip; the strip shows it while that clip is selected. */
export interface SyncState { clipId: string; busy: boolean; message?: string; failed?: boolean }

interface Props {
  clip: Clip | undefined;
  asset: AssetMetadata | undefined;
  kind: 'video' | 'audio' | 'caption' | 'overlay' | undefined;
  /** Every caption clip in the project — what "apply to all" writes to. */
  captionClips?: Clip[];
  pending: boolean;
  /** Present for audio clips: line this clip up under the video by its sound. */
  onSync?: () => void;
  sync?: SyncState;
  /** `extra` carries the optimistic patch for clips other than the selected one. */
  onApply: (ops: Operation[], patch: Partial<Clip>, extra?: Array<{ clipId: string; patch: Partial<Clip> }>) => void;
}

/**
 * Selection strip under the lanes: read-only geometry plus the properties
 * worth nudging by hand — speed/volume/zoom for media clips, size/rotation
 * for stickers. Every control commits one operation with an optimistic patch.
 */
export function Inspector({ clip, asset, kind, captionClips, pending, onSync, sync, onApply }: Props) {
  if (!clip) {
    return (
      <View style={styles.bar}>
        <Text style={styles.hint}>Select a clip to inspect it, or ask the agent for an edit.</Text>
      </View>
    );
  }

  const isCaption = kind === 'caption';
  const isSticker = kind === 'overlay';
  const speed = clip.speed ?? 1;
  const volume = clip.volume ?? 1;
  const stepSpeed = (direction: -1 | 1): void => {
    const index = SPEEDS.indexOf(speed);
    const fallback = SPEEDS.findIndex((value) => value > speed);
    const current = index >= 0 ? index : Math.max(0, fallback);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, current + direction))];
    if (next === undefined || next === speed) return;
    onApply([{ type: 'set_speed', params: { clipId: clip.id, speed: next } }], { speed: next });
  };
  const stepVolume = (direction: -1 | 1): void => {
    const next = Math.round(Math.max(0, Math.min(1, volume + direction * VOLUME_STEP)) * 100) / 100;
    if (next === volume) return;
    onApply([{ type: 'set_volume', params: { clipId: clip.id, volume: next } }], { volume: next });
  };

  const activeZoom = ZOOM_PRESETS.find((preset) => sameTransform(clip.transform, preset.from)
    && sameTransform(clip.transformEnd, preset.to))?.key
    ?? (clip.transformEnd || (clip.transform && !sameTransform(clip.transform, IDENTITY)) ? 'custom' : 'none');
  const applyZoom = (preset: typeof ZOOM_PRESETS[number]): void => {
    const params = preset.to
      ? { clipId: clip.id, transform: preset.from, transformEnd: preset.to }
      : { clipId: clip.id, transform: preset.from };
    const patch: Partial<Clip> = { transform: preset.from };
    // `set_transform` without transformEnd clears the zoom server-side; mirror
    // that optimistically (undefined removes it from the patched clip).
    (patch as Record<string, unknown>).transformEnd = preset.to;
    onApply([{ type: 'set_transform', params }], patch);
  };

  const transition = clip.transition;
  const applyTransition = (next: ClipTransition | null): void => {
    // `null` clears it server-side; `undefined` does the same to the patched
    // clip, which the exact-optional type needs the cast to express.
    const patch: Partial<Clip> = {};
    (patch as Record<string, unknown>).transition = next ?? undefined;
    onApply([{ type: 'set_transition', params: { clipId: clip.id, transition: next } }], patch);
  };

  const applyText = (text: string): void => {
    onApply([{ type: 'update_caption', params: { clipId: clip.id, text } }], { text });
  };

  // `anchorPct` outranks `position` in both the preview overlay and the ASS
  // export, so a styled caption would ignore these chips unless picking a
  // position drops the explicit anchor.
  const captionPosition = clip.style?.position ?? 'bottom';
  const applyCaptionPosition = (position: CaptionStyle['position']): void => {
    const { anchorPct: _anchorPct, ...rest } = clip.style ?? {};
    const style = { ...rest, position } as CaptionStyle;
    onApply([{ type: 'update_caption', params: { clipId: clip.id, style } }], { style });
  };

  // `update_caption` REPLACES the style object, so every edit merges onto the
  // clip's own style — that is what carries `words`, the karaoke timings.
  const applyCaptionStyle = (patch: Partial<CaptionStyle>): void => {
    const style = { ...clip.style, ...patch } as CaptionStyle;
    onApply([{ type: 'update_caption', params: { clipId: clip.id, style } }], { style });
  };

  // `size` is pixels at a 1080-wide frame while `sizePct` is a share of frame
  // height, so converting needs the aspect the inspector does not have.
  // ponytail: seed from 9:16, the project default; the first nudge pins an
  // explicit `sizePct`, which the preview and the ASS export both prefer.
  const captionSizePct = clip.style?.sizePct ?? round1(((clip.style?.size ?? 52) / 1080) * (9 / 16) * 100);
  const stepCaptionSize = (direction: -1 | 1): void => {
    const next = round1(Math.max(CAPTION_SIZE_MIN, Math.min(CAPTION_SIZE_MAX, captionSizePct + direction * CAPTION_SIZE_STEP)));
    if (next === captionSizePct) return;
    applyCaptionStyle({ sizePct: next });
  };

  /**
   * One look across the whole track. `words` stays per caption (they are that
   * line's timings), and `anchorPct` is dropped from every clip — including the
   * selected one, so the source cannot sit somewhere the copies cannot reach —
   * which is the same trade the POSITION chips make.
   */
  const captionSiblings = captionClips ?? [];
  const applyCaptionStyleToAll = (): void => {
    const { words: _words, anchorPct: _anchorPct, ...shared } = clip.style ?? {};
    const ops: Operation[] = [];
    const extra: Array<{ clipId: string; patch: Partial<Clip> }> = [];
    let selectedPatch: Partial<Clip> = {};
    for (const caption of captionSiblings) {
      const words = caption.style?.words;
      const style = { ...shared, ...(words ? { words } : {}) } as CaptionStyle;
      ops.push({ type: 'update_caption', params: { clipId: caption.id, style } });
      if (caption.id === clip.id) selectedPatch = { style };
      else extra.push({ clipId: caption.id, patch: { style } });
    }
    if (ops.length === 0) return;
    onApply(ops, selectedPatch, extra);
  };

  const placement = clip.overlay ?? { x: 0.5, y: 0.35, width: 0.28, rotation: 0 };
  const stepSticker = (field: 'width' | 'rotation', direction: -1 | 1): void => {
    const next = field === 'width'
      ? { ...placement, width: clamp(placement.width + direction * STICKER_SIZE_STEP, 0.06, 0.9) }
      : { ...placement, rotation: clampRotation(placement.rotation + direction * STICKER_ROTATION_STEP) };
    if (next.width === placement.width && next.rotation === placement.rotation) return;
    onApply([{ type: 'set_overlay', params: { clipId: clip.id, overlay: next } }], { overlay: next });
  };

  return (
    <View style={[styles.bar, pending && styles.barPending]} pointerEvents={pending ? 'none' : 'auto'}>
      <View style={styles.identity}>
        <Text style={styles.kind}>{isCaption ? 'CAPTION' : isSticker ? 'STICKER' : kind === 'audio' ? 'SOUND' : 'CLIP'}</Text>
        {isCaption ? (
          <CaptionText clipId={clip.id} text={clip.text} onCommit={applyText} />
        ) : (
          <Text style={styles.name} numberOfLines={1}>
            {isSticker && !clip.assetId
              ? clip.text ?? clip.id
              : asset?.label ?? asset?.originalName ?? clip.assetId ?? clip.id}
          </Text>
        )}
      </View>
      <Field label="START" value={formatTimecode(clip.start)} />
      <Field label="DURATION" value={`${clipTimelineDuration(clip).toFixed(2)}s`} />
      {!isCaption && !isSticker && (
        <>
          {/* A synced memo can carry a drift correction like 1.00006×: two places are plenty. */}
          <Stepper label="SPEED" value={`${Number(speed.toFixed(2))}×`} onDown={() => stepSpeed(-1)} onUp={() => stepSpeed(1)} />
          <Stepper label="VOLUME" value={`${Math.round(volume * 100)}%`} onDown={() => stepVolume(-1)} onUp={() => stepVolume(1)} />
        </>
      )}
      {onSync && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>SYNC</Text>
          <View style={styles.chipRow}>
            <Chip
              label={sync?.busy ? 'listening…' : 'sync to video'}
              hint="sync to video"
              active={false}
              onPress={() => { if (!sync?.busy) onSync(); }}
            />
            {sync?.message !== undefined && (
              <Text style={[styles.syncMessage, sync.failed && styles.syncFailed]} numberOfLines={2}>{sync.message}</Text>
            )}
          </View>
        </View>
      )}
      {kind === 'video' && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>ZOOM</Text>
          <View style={styles.chipRow}>
            {ZOOM_PRESETS.map((preset) => (
              <Chip
                key={preset.key}
                label={preset.label}
                hint={`zoom ${preset.label}`}
                active={activeZoom === preset.key}
                onPress={() => applyZoom(preset)}
              />
            ))}
            {activeZoom === 'custom' && <Text style={styles.zoomCustom}>custom</Text>}
          </View>
        </View>
      )}
      {kind === 'video' && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>TRANSITION</Text>
          <View style={styles.chipRow}>
            <Chip label="none" hint="transition none" active={!transition} onPress={() => applyTransition(null)} />
            {TRANSITIONS.map((option) => (
              <Chip
                key={option.key}
                label={option.label}
                hint={`transition ${option.label}`}
                active={transition?.type === option.key}
                onPress={() => applyTransition({ type: option.key, duration: transition?.duration ?? DEFAULT_TRANSITION_DURATION })}
              />
            ))}
            {transition && TRANSITION_DURATIONS.map((duration) => (
              <Chip
                key={duration}
                label={`${duration.toFixed(1)}s`}
                hint={`transition ${duration} seconds`}
                active={Math.abs(transition.duration - duration) < 1e-6}
                onPress={() => applyTransition({ type: transition.type, duration })}
              />
            ))}
          </View>
        </View>
      )}
      {isCaption && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>POSITION</Text>
          <View style={styles.chipRow}>
            {CAPTION_POSITIONS.map((position) => (
              <Chip
                key={position}
                label={position}
                hint={`caption ${position}`}
                active={captionPosition === position}
                onPress={() => applyCaptionPosition(position)}
              />
            ))}
          </View>
        </View>
      )}
      {isCaption && (
        <Stepper
          label="SIZE"
          hint="caption size"
          value={`${captionSizePct.toFixed(1)}%`}
          onDown={() => stepCaptionSize(-1)}
          onUp={() => stepCaptionSize(1)}
        />
      )}
      {isCaption && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>COLOR</Text>
          <View style={styles.chipRow}>
            {CAPTION_COLORS.map((color) => (
              <Pressable
                key={color}
                accessibilityRole="button"
                accessibilityLabel={`caption color ${color}`}
                onPress={() => applyCaptionStyle({ color })}
                style={({ pressed }) => [
                  styles.swatch,
                  { backgroundColor: color },
                  (clip.style?.color ?? '#FFFFFF').toUpperCase() === color && styles.swatchActive,
                  pressed && styles.pressed,
                ]}
              />
            ))}
          </View>
        </View>
      )}
      {isCaption && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>EMPHASIS</Text>
          <View style={styles.chipRow}>
            {CAPTION_EMPHASES.map((emphasis) => (
              <Chip
                key={emphasis}
                label={emphasis}
                hint={`caption emphasis ${emphasis}`}
                active={(clip.style?.emphasis ?? 'bold') === emphasis}
                onPress={() => applyCaptionStyle({ emphasis })}
              />
            ))}
          </View>
        </View>
      )}
      {isCaption && captionSiblings.length > 1 && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>STYLE</Text>
          <View style={styles.chipRow}>
            <Chip
              label="apply to all"
              hint="apply caption style to all"
              active={false}
              onPress={applyCaptionStyleToAll}
            />
          </View>
        </View>
      )}
      {isSticker && (
        <>
          <Stepper label="SIZE" value={`${Math.round(placement.width * 100)}%`} onDown={() => stepSticker('width', -1)} onUp={() => stepSticker('width', 1)} />
          <Stepper label="ROTATE" value={`${Math.round(placement.rotation)}°`} onDown={() => stepSticker('rotation', -1)} onUp={() => stepSticker('rotation', 1)} />
        </>
      )}
      {asset && !isSticker && <Field label="SOURCE" value={`${asset.width}×${asset.height} · ${asset.duration.toFixed(1)}s`} />}
    </View>
  );
}

function sameTransform(left: ClipTransform | undefined, right: ClipTransform | undefined): boolean {
  if (!left || !right) return !left && !right;
  return Math.abs(left.scale - right.scale) < 1e-6 && Math.abs(left.x - right.x) < 1e-6 && Math.abs(left.y - right.y) < 1e-6;
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, value)) * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampRotation(value: number): number {
  return Math.max(-180, Math.min(180, value));
}

/**
 * The caption's own words, edited in place. Kept as local draft state so every
 * keystroke does not fire an operation; the edit commits on blur or submit,
 * and an unchanged or empty draft commits nothing.
 */
function CaptionText({ clipId, text, onCommit }: { clipId: string; text: string | undefined; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(text ?? '');
  // Re-seed on selection change only: re-seeding on every `text` change would
  // fight the typist while an optimistic patch lands mid-edit.
  useEffect(() => { setDraft(text ?? ''); }, [clipId]);
  const commit = (): void => {
    const next = draft.trim();
    if (next.length === 0 || next === (text ?? '')) {
      setDraft(text ?? '');
      return;
    }
    onCommit(next);
  };
  return (
    <TextInput
      accessibilityLabel="caption text"
      value={draft}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      blurOnSubmit
      multiline={false}
      returnKeyType="done"
      placeholder="caption text"
      placeholderTextColor={colors.muted}
      style={styles.captionInput}
    />
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

/** One preset chip — the shared language for the zoom and transition rows. */
function Chip({ label, hint, active, onPress }: { label: string; hint: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/** `hint` names the control when the bare label is ambiguous (two SIZE steppers). */
function Stepper({ label, hint, value, onDown, onUp }: { label: string; hint?: string; value: string; onDown: () => void; onUp: () => void }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable accessibilityRole="button" accessibilityLabel={hint ? `${hint} down` : `decrease ${label}`} hitSlop={8} onPress={onDown} style={({ pressed }) => [styles.step, pressed && styles.pressed]}>
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text style={styles.stepValue}>{value}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={hint ? `${hint} up` : `increase ${label}`} hitSlop={8} onPress={onUp} style={({ pressed }) => [styles.step, pressed && styles.pressed]}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 40, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xxl,
    borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.lg, marginTop: space.md,
  },
  barPending: { opacity: 0.55 },
  identity: { minWidth: 140, maxWidth: 240, gap: space.xs },
  kind: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.2 },
  name: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.base },
  captionInput: {
    color: colors.text, fontFamily: fonts.semibold, fontSize: type.base,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised,
    paddingHorizontal: space.md, minHeight: 26,
  },
  field: { gap: space.xs },
  fieldLabel: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1 },
  fieldValue: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.base, fontVariant: ['tabular-nums'] },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  step: {
    width: 26, height: 26, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center',
  },
  stepText: { color: colors.text, fontFamily: fonts.bold, fontSize: type.lg, lineHeight: 15 },
  stepValue: { minWidth: 42, textAlign: 'center', color: colors.text, fontFamily: fonts.semibold, fontSize: type.base, fontVariant: ['tabular-nums'] },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chip: {
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised,
    paddingHorizontal: space.lg, minHeight: 26, justifyContent: 'center',
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { color: colors.muted, fontFamily: fonts.semibold, fontSize: type.sm },
  chipTextActive: { color: colors.text },
  swatch: { width: 22, height: 22, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  swatchActive: { borderWidth: 2, borderColor: colors.accent },
  zoomCustom: { color: colors.muted, fontFamily: fonts.semibold, fontSize: type.sm },
  syncMessage: { flexShrink: 1, maxWidth: 320, color: colors.muted, fontFamily: fonts.medium, fontSize: type.sm },
  syncFailed: { color: colors.danger },
  hint: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.md },
  pressed: { opacity: 0.6 },
});
