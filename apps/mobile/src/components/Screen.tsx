import type { PropsWithChildren, ReactNode } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView, StyleSheet, View } from 'react-native';
import { colors } from '../lib/theme';

interface Props {
  scroll?: boolean;
  header?: ReactNode;
  /** Editor chrome: drop the reading-width cap and tighten the padding. */
  bleed?: boolean;
}

export function Screen({ children, scroll = true, header, bleed = false }: PropsWithChildren<Props>) {
  const content = <View style={[styles.content, bleed && styles.bleed]}>{header}{children}</View>;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">{content}</ScrollView> : content}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  content: { width: '100%', maxWidth: 1280, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 48, gap: 24 },
  bleed: { flex: 1, maxWidth: 1920, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 14, gap: 12 },
});
