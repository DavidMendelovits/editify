import type { useRouter } from 'expo-router';
import type { ViewStyle } from 'react-native';
import { colors } from './theme';

type Router = ReturnType<typeof useRouter>;

// router.back() silently no-ops when the app was loaded straight onto this
// route (deep link or web reload), so fall back to an explicit destination.
export function goBack(router: Router, fallback: Parameters<Router['replace']>[0]): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

// RN Web hands the style callback `hovered`/`focused` too; RN's types only declare `pressed`.
export function backControlStyle(state: { pressed: boolean }): ViewStyle {
  const { hovered, focused } = state as { hovered?: boolean; focused?: boolean };
  return {
    opacity: state.pressed ? 0.5 : hovered ? 0.7 : 1,
    ...(focused ? { outlineColor: colors.accent, outlineWidth: 2, outlineStyle: 'solid' as const, outlineOffset: 3 } : {}),
  };
}
