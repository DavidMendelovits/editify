import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '../lib/legal';
import { colors, space, type, fonts } from '../lib/theme';

/**
 * Guideline 3.1.2 wants both links on the screen where the subscription is
 * sold, and 5.1.1 wants the privacy policy reachable before an account is
 * created, which is why this sits on the paywall and the sign-in screen.
 */
export function LegalLinks({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.row, style]}>
      <LegalLink label="privacy policy" url={PRIVACY_POLICY_URL} />
      <Text style={styles.dot}>·</Text>
      <LegalLink label="terms of use" url={TERMS_OF_USE_URL} />
    </View>
  );
}

function LegalLink({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={() => { Linking.openURL(url).catch(() => undefined); }}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.lg },
  link: { minHeight: 28, justifyContent: 'center' },
  label: { color: colors.accent, fontFamily: fonts.medium, fontSize: type.lg, textDecorationLine: 'underline' },
  dot: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.lg },
  pressed: { opacity: 0.7 },
});
