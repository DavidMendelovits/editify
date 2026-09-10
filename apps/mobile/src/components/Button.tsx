import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius, space, type, fonts } from '../lib/theme';

interface Props extends PropsWithChildren {
  onPress?: () => void;
  disabled?: boolean;
  secondary?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

/** Primary: accent fill (the one place the accent is a surface). Secondary: bordered, no fill. */
export function Button({ children, onPress, disabled, secondary, style, accessibilityLabel }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.pressable, secondary ? styles.secondary : styles.primary, style, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={styles.text}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: { minHeight: 36, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.xxl, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.accentStrong, borderColor: colors.accentStrong },
  secondary: { backgroundColor: 'transparent', borderColor: colors.border },
  text: { color: colors.text, fontFamily: fonts.semibold, fontSize: type.lg, textAlign: 'center' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
});
