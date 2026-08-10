import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, gradient } from '../lib/theme';

interface Props extends PropsWithChildren {
  onPress?: () => void;
  disabled?: boolean;
  secondary?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function GradientButton({ children, onPress, disabled, secondary, style, accessibilityLabel }: Props) {
  const content = <Text style={[styles.text, secondary && styles.secondaryText]}>{children}</Text>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.pressable, style, pressed && styles.pressed, disabled && styles.disabled]}>
      {secondary ? <>{content}</> : <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.gradient}>{content}</LinearGradient>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: { minHeight: 46, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: 'transparent', justifyContent: 'center' },
  gradient: { flex: 1, minHeight: 44, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  text: { color: colors.text, fontFamily: 'Montserrat_700Bold', fontSize: 14 },
  secondaryText: { color: colors.text, textAlign: 'center' },
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.45 },
});
