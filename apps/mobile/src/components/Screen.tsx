import type { PropsWithChildren, ReactNode } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../lib/theme';

export function Screen({ children, scroll = true, header }: PropsWithChildren<{ scroll?: boolean; header?: ReactNode }>) {
  const content = <View style={styles.content}>{header}{children}</View>;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <LinearGradient colors={['#111226', colors.background, colors.background]} locations={[0, 0.35, 1]} style={StyleSheet.absoluteFill} />
      {scroll ? <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">{content}</ScrollView> : content}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  content: { width: '100%', maxWidth: 1280, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 48, gap: 24 },
});
