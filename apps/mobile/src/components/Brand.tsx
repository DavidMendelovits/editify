import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { isOwnerEmail } from '@editify/shared';
import { onAuthStateChange } from '../lib/supabase';
import { colors, radius, space, type, fonts } from '../lib/theme';

/** `useNativeDriver` is a no-op on react-native-web, so drive on the JS thread there. */
const NATIVE_DRIVER = Platform.OS !== 'web';

/** Five taps, each within this window of the last one, opens the cut. */
const TAPS_TO_REVEAL = 5;
const TAP_WINDOW_MS = 3000;
const REVEAL_MS = 6000;

const PARTICLES = ['✂', '🎬', '🎞', '⭐', '✦', '🍿', '🎥', '✨'];
const PARTICLE_COUNT = 24;

export function Brand({ compact = false }: { compact?: boolean }) {
  const [isOwner, setIsOwner] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const taps = useRef(0);
  const lastTapAt = useRef(0);

  useEffect(() => onAuthStateChange((session) => setIsOwner(isOwnerEmail(session?.user.email))), []);

  const onTap = useCallback(() => {
    if (!isOwner) return;
    const now = Date.now();
    taps.current = now - lastTapAt.current <= TAP_WINDOW_MS ? taps.current + 1 : 1;
    lastTapAt.current = now;
    if (taps.current >= TAPS_TO_REVEAL) {
      taps.current = 0;
      lastTapAt.current = 0;
      setRevealed(true);
    }
  }, [isOwner]);

  return (
    <View style={styles.row} accessibilityLabel="editify">
      <Pressable testID="brand-wordmark" onPress={onTap} accessibilityRole="header">
        <Text style={[styles.word, compact && styles.compact]}>editify</Text>
      </Pressable>
      {!compact && <Text style={styles.tag}>AI EDITOR</Text>}
      {revealed && <DirectorsCut onDismiss={() => setRevealed(false)} />}
    </View>
  );
}

/**
 * The easter egg: a burst of film glyphs thrown outward from the centre behind
 * a title card that settles in, gone on a tap or after a few seconds.
 */
function DirectorsCut({ onDismiss }: { onDismiss: () => void }) {
  const burst = useRef(new Animated.Value(0)).current;
  const card = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(burst, { toValue: 1, duration: 1300, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(card, { toValue: 1, duration: 520, easing: Easing.out(Easing.back(1.8)), useNativeDriver: NATIVE_DRIVER }),
    ]).start();
    const timer = setTimeout(onDismiss, REVEAL_MS);
    return () => clearTimeout(timer);
  }, [burst, card, onDismiss]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable testID="easter-egg" style={styles.overlay} onPress={onDismiss} accessibilityRole="button" accessibilityLabel="dismiss the director's cut">
        <View style={styles.stage} pointerEvents="none">
          {Array.from({ length: PARTICLE_COUNT }, (_, index) => {
            const angle = (index / PARTICLE_COUNT) * Math.PI * 2;
            const distance = 130 + (index % 5) * 34;
            return (
              <Animated.Text
                key={index}
                style={[styles.particle, {
                  opacity: burst.interpolate({ inputRange: [0, 0.15, 0.75, 1], outputRange: [0, 1, 0.9, 0] }),
                  transform: [
                    { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(angle) * distance] }) },
                    { translateY: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(angle) * distance] }) },
                    { rotate: burst.interpolate({ inputRange: [0, 1], outputRange: ['0deg', index % 2 ? '220deg' : '-220deg'] }) },
                    { scale: burst.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.3, 1.25, 0.7] }) },
                  ],
                }]}
              >
                {PARTICLES[index % PARTICLES.length]}
              </Animated.Text>
            );
          })}
        </View>
        <Animated.View
          style={[styles.card, {
            opacity: card,
            transform: [{ scale: card.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }],
          }]}
          pointerEvents="none"
        >
          <Text style={styles.slate}>SCENE 1 / TAKE 5</Text>
          <Text style={styles.title}>DIRECTOR&apos;S CUT</Text>
          <Text style={styles.nod}>hi david. every frame of this one is yours.</Text>
          <Text style={styles.hint}>tap anywhere to cut back</Text>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', gap: space.lg },
  word: { color: colors.text, fontFamily: fonts.display, fontSize: type.title, letterSpacing: 0 },
  compact: { fontSize: type.xxl },
  tag: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.2 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(10, 10, 12, 0.88)' },
  stage: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  particle: { position: 'absolute', fontSize: 26 },
  card: {
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.section,
    paddingHorizontal: space.section,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.panel,
  },
  slate: { color: colors.accent, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 2 },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: type.display, letterSpacing: 1 },
  nod: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg },
  hint: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.xs, letterSpacing: 1.4 },
});
