import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { describeTraceStep, type AgentTraceStep } from '../lib/agent';
import { colors, gradient, fonts } from '../lib/theme';

/**
 * `useNativeDriver` is a no-op on react-native-web and logs a warning, so drive
 * animations on the JS thread there and natively everywhere else.
 */
const NATIVE_DRIVER = Platform.OS !== 'web';

/** Shown only before the first live trace step lands. */
const WARMUP_PHRASE = 'reading the timeline…';

/**
 * In-flight indicator for the agent loop: a sliding gradient sweep, three
 * pulsing dots, and an elapsed-time readout so a long tool loop still feels
 * alive. The phrase is the latest REAL step from the live trace — never a
 * timer-driven guess about what the agent might be doing.
 */
export function AgentActivity({ latestStep }: { latestStep?: AgentTraceStep }) {
  const sweep = useRef(new Animated.Value(0)).current;
  const dotA = useRef(new Animated.Value(0.25)).current;
  const dotB = useRef(new Animated.Value(0.25)).current;
  const dotC = useRef(new Animated.Value(0.25)).current;
  const [barWidth, setBarWidth] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const loop = Animated.loop(Animated.timing(sweep, {
      toValue: 1,
      duration: 1400,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: NATIVE_DRIVER,
    }));
    loop.start();
    return () => loop.stop();
  }, [sweep]);

  useEffect(() => {
    const pulse = (value: Animated.Value, delay: number) => Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(value, { toValue: 1, duration: 300, easing: Easing.out(Easing.ease), useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(value, { toValue: 0.25, duration: 300, easing: Easing.in(Easing.ease), useNativeDriver: NATIVE_DRIVER }),
      Animated.delay(560 - delay),
    ]));
    const animations = [pulse(dotA, 0), pulse(dotB, 140), pulse(dotC, 280)];
    for (const animation of animations) animation.start();
    return () => { for (const animation of animations) animation.stop(); };
  }, [dotA, dotB, dotC]);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const phrase = latestStep ? describeTraceStep(latestStep) : WARMUP_PHRASE;
  const translateX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-barWidth * 0.45, barWidth],
  });

  return (
    <View style={styles.card} accessibilityRole="progressbar" accessibilityLabel="agent is editing">
      <View style={styles.headline}>
        <View style={styles.dots}>
          <Animated.View style={[styles.dot, { opacity: dotA }]} />
          <Animated.View style={[styles.dot, { opacity: dotB }]} />
          <Animated.View style={[styles.dot, { opacity: dotC }]} />
        </View>
        <Text style={styles.title}>agent is editing…</Text>
        <Text style={styles.elapsed}>{elapsed}s</Text>
      </View>
      <View style={styles.track} onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}>
        {barWidth > 0 && (
          <Animated.View style={[styles.sweep, { width: barWidth * 0.45, transform: [{ translateX }] }]}>
            <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
          </Animated.View>
        )}
      </View>
      <Text style={styles.phrase} numberOfLines={2}>{phrase}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderRadius: 14, borderTopLeftRadius: 4, backgroundColor: '#201A31', borderWidth: 1, borderColor: '#332A4D', padding: 12, gap: 9 },
  headline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dots: { flexDirection: 'row', gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.purple },
  title: { flex: 1, color: colors.text, fontFamily: fonts.bold, fontSize: 11 },
  elapsed: { color: colors.muted, fontFamily: fonts.semibold, fontSize: 9 },
  track: { height: 3, borderRadius: 2, backgroundColor: '#2A2440', overflow: 'hidden' },
  sweep: { height: 3, borderRadius: 2, overflow: 'hidden' },
  phrase: { color: colors.muted, fontFamily: fonts.regular, fontSize: 10 },
});
