import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { EditifyEngine } from '../../modules/editify-engine';
import { API_URL } from '../lib/api';
import {
  isTestFlight, serverLine, shouldShowTestBanner, TEST_BANNER_DISMISSED_KEY, TEST_BUILD_BANNER_TEXT,
} from '../lib/test-build-banner';
import { colors, fonts, radius, space, type } from '../lib/theme';

const HEALTH_TIMEOUT_MS = 5000;
/**
 * `EXPO_PUBLIC_TEST_BANNER=force` (a local build's env, never set in eas.json) shows it on any
 * build, for simulator screenshots.
 */
const FORCE = process.env.EXPO_PUBLIC_TEST_BANNER === 'force';

async function readDismissed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(TEST_BANNER_DISMISSED_KEY)) === '1';
  } catch {
    return false;
  }
}

async function fetchHealth(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/health`, { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function testFlightBuild(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    const release = await Application.getIosApplicationReleaseTypeAsync();
    return isTestFlight({ appStoreSigned: release === Application.ApplicationReleaseType.APP_STORE, receipt: EditifyEngine?.appStoreReceipt?.() });
  } catch {
    return false;
  }
}

/** Whether to show the banner, decided once per mount; hidden until known. */
function useTestBanner(): [boolean, () => void] {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const dismissed = await readDismissed();
      if (dismissed) return;
      if (FORCE) { if (active) setShow(true); return; }
      if (!(await testFlightBuild())) return;
      const line = serverLine(await fetchHealth(), API_URL);
      if (active) setShow(shouldShowTestBanner({ testFlight: true, line, dismissed }));
    })();
    return () => { active = false; };
  }, []);
  const dismiss = (): void => {
    setShow(false);
    void AsyncStorage.setItem(TEST_BANNER_DISMISSED_KEY, '1').catch(() => undefined);
  };
  return [show, dismiss];
}

/** The 1.1 TestFlight notice (C8, C18): a separate test server, and edits here don't carry over. */
export function TestBuildBanner() {
  const [show, dismiss] = useTestBanner();
  if (!show) return null;
  return (
    <View testID="test-build-banner" accessibilityRole="summary" style={styles.banner}>
      <View style={styles.copy}>
        <Text style={styles.label}>TEST BUILD</Text>
        <Text style={styles.text}>{TEST_BUILD_BANNER_TEXT}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="dismiss test build notice" hitSlop={8} onPress={dismiss} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
        <Text style={styles.closeGlyph}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    maxWidth: 900, width: '100%', alignSelf: 'center', flexDirection: 'row', alignItems: 'flex-start', gap: space.xl,
    padding: space.xl, borderRadius: radius.md, borderWidth: 1, borderColor: colors.warn, backgroundColor: colors.warnSoft,
  },
  copy: { flex: 1, gap: space.sm },
  label: { color: colors.warn, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.4 },
  text: { color: colors.text, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 17 },
  close: { minWidth: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' },
  closeGlyph: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.xl },
  pressed: { opacity: 0.75 },
});
