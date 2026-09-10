import type { PropsWithChildren, ReactNode } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView, StyleSheet, View } from 'react-native';
import { colors, space } from '../lib/theme';

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
  content: { width: '100%', maxWidth: 1280, alignSelf: 'center', paddingHorizontal: space.xxl, paddingTop: space.lg, paddingBottom: space.section, gap: space.xxl },
  bleed: { flex: 1, maxWidth: 1920, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.lg, gap: space.lg },
});
