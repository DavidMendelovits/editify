import { useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { HighlightRect, Screenshot } from '../lib/capture';
import { colors, radius, space, type, fonts } from '../lib/theme';

interface Props {
  shot: Screenshot;
  attached: boolean;
  onAttachedChange: (attached: boolean) => void;
  highlight?: HighlightRect;
  onHighlight: (rect: HighlightRect | undefined) => void;
}

/** Drag start and current point, in the preview's own pixels. */
interface Drag { fromX: number; fromY: number; toX: number; toY: number }

function rectOf(drag: Drag, size: { width: number; height: number }): HighlightRect | undefined {
  if (!size.width || !size.height) return undefined;
  // A drag that runs off the edge of the preview still reports coordinates
  // outside it, and a highlight outside the image is not a highlight: both
  // corners are clamped before the box is measured, so the result is always
  // inside 0..1 and always something the report schema accepts.
  const clamp = (value: number, limit: number): number => Math.min(Math.max(value, 0), limit);
  const left = clamp(Math.min(drag.fromX, drag.toX), size.width);
  const top = clamp(Math.min(drag.fromY, drag.toY), size.height);
  const right = clamp(Math.max(drag.fromX, drag.toX), size.width);
  const bottom = clamp(Math.max(drag.fromY, drag.toY), size.height);
  // A tap is not a box. Anything smaller than this is almost certainly a
  // mis-press on the preview rather than an attempt to highlight something.
  if (right - left < 12 || bottom - top < 12) return undefined;
  return {
    x: left / size.width,
    y: top / size.height,
    width: (right - left) / size.width,
    height: (bottom - top) / size.height,
  };
}

/**
 * The screenshot the app took when the sheet opened. It is attached only if the
 * user says so, and the preview is right here so nobody sends a picture of
 * their screen without seeing it first. Dragging on the preview marks the area
 * the report is about.
 */
export function ScreenshotField({ shot, attached, onAttachedChange, highlight, onHighlight }: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag>();
  const dragRef = useRef<Drag | undefined>(undefined);

  if (!attached) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="attach a screenshot" onPress={() => onAttachedChange(true)}>
        <Text style={styles.offer}>+ attach a screenshot of this screen</Text>
        <Text style={styles.privacy}>
          Goes on a tracked issue. Your footage and your words are left out of it: frames, thumbnails,
          captions, chat and file names are all replaced with placeholders. Check the preview before you send.
        </Text>
      </Pressable>
    );
  }

  const live = drag ? rectOf(drag, size) : undefined;
  const box = live ?? highlight;

  return (
    <View style={styles.wrap}>
      <View
        style={styles.frame}
        onLayout={(event) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(event) => {
          const { locationX, locationY } = event.nativeEvent;
          const next = { fromX: locationX, fromY: locationY, toX: locationX, toY: locationY };
          dragRef.current = next;
          setDrag(next);
        }}
        onResponderMove={(event) => {
          if (!dragRef.current) return;
          const next = { ...dragRef.current, toX: event.nativeEvent.locationX, toY: event.nativeEvent.locationY };
          dragRef.current = next;
          setDrag(next);
        }}
        onResponderRelease={() => {
          // A drag too small to be a box clears the highlight instead of
          // leaving a sliver nobody meant to draw.
          onHighlight(dragRef.current ? rectOf(dragRef.current, size) : undefined);
          dragRef.current = undefined;
          setDrag(undefined);
        }}
      >
        <Image
          source={{ uri: shot.data }}
          style={[styles.image, { aspectRatio: shot.width / shot.height }]}
          resizeMode="contain"
          accessibilityLabel="screenshot preview"
        />
        {box && (
          <View
            pointerEvents="none"
            style={[styles.box, {
              left: box.x * size.width,
              top: box.y * size.height,
              width: box.width * size.width,
              height: box.height * size.height,
            }]}
          />
        )}
      </View>
      <View style={styles.actions}>
        <Text style={styles.hint}>{box ? 'Drag again to move the highlight.' : 'Drag on the image to highlight the part you mean.'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="remove screenshot" onPress={() => { onHighlight(undefined); onAttachedChange(false); }}>
          <Text style={styles.remove}>remove</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  frame: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', backgroundColor: colors.panelRaised },
  image: { width: '100%' },
  box: { position: 'absolute', borderWidth: 2, borderColor: colors.danger, backgroundColor: '#F0656B1a' },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.lg },
  hint: { flex: 1, color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, lineHeight: 15 },
  offer: { color: colors.accent, fontFamily: fonts.medium, fontSize: type.base },
  privacy: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.base, lineHeight: 15, marginTop: space.xs },
  remove: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.base },
});
