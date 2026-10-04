import { createContext, useRef, type PropsWithChildren, type ReactNode, type RefObject } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space } from '../lib/theme';

interface Props {
  scroll?: boolean;
  header?: ReactNode;
  /** Editor chrome: drop the reading-width cap and tighten the padding. */
  bleed?: boolean;
}

/**
 * The screen's own ScrollView, or null when the screen does not scroll (the
 * wide editor). UIKit only lifts the focused caret above the keyboard, so a
 * field that needs its surroundings in view too (the chat composer) asks here.
 */
export const ScreenScroll = createContext<RefObject<ScrollView | null> | null>(null);

/**
 * Every screen's shell, and the one place the software keyboard is handled.
 *
 * Scrolling screens get `automaticallyAdjustKeyboardInsets`, which is the whole
 * fix on iOS: UIKit insets the scroll view by the keyboard's height and scrolls
 * the focused field above it, so no wrapper has to guess an offset. Android
 * needs nothing here because Expo resizes the window instead
 * (`softwareKeyboardLayoutMode` defaults to "resize"), and adding a second
 * adjustment on top of that would double-count the keyboard.
 *
 * The one screen that does not scroll is the wide editor, where the dock is
 * pinned to the bottom with nowhere to scroll to. That case gets a
 * KeyboardAvoidingView, which shortens the whole workspace: the panel sizes in
 * PanelLayout are re-clamped against the smaller bounds, so the composer rides
 * up and the timeline keeps its minimum instead of being covered.
 */
export function Screen({ children, scroll = true, header, bleed = false }: PropsWithChildren<Props>) {
  const insets = useSafeAreaInsets();
  const scroller = useRef<ScrollView>(null);
  // SafeAreaView below claims the top and the sides. The bottom is left to the
  // content padding so a scrolling screen keeps scrolling under the home
  // indicator rather than ending in a dead band above it.
  const floor = { paddingBottom: (bleed ? space.lg : space.section) + insets.bottom };
  const content = <View style={[styles.content, bleed && styles.bleed, floor]}>{header}{children}</View>;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          ref={scroller}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          <ScreenScroll.Provider value={scroller}>{content}</ScreenScroll.Provider>
        </ScrollView>
      ) : (
        <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {content}
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  content: { width: '100%', maxWidth: 1280, alignSelf: 'center', paddingHorizontal: space.xxl, paddingTop: space.lg, gap: space.xxl },
  bleed: { flex: 1, maxWidth: 1920, paddingHorizontal: space.lg, paddingTop: space.md, gap: space.lg },
});
