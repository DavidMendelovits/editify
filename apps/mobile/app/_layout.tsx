import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Stack, usePathname, useRouter, useSegments, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ShareIntentProvider } from 'expo-share-intent';
import type { Session } from '@supabase/supabase-js';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
  useFonts,
} from '@expo-google-fonts/space-grotesk';
import { Unbounded_700Bold } from '@expo-google-fonts/unbounded';
import { SpaceMono_700Bold } from '@expo-google-fonts/space-mono';
import { AppProviders } from '../src/providers/AppProviders';
import { scopeCacheTo } from '../src/lib/query-client';
import { ShareIntake } from '../src/components/ShareIntake';
import { UpdateGate } from '../src/components/UpdateGate';
import { behindGate } from '../src/lib/client-config';
import { useClientGate } from '../src/lib/use-client-gate';
import { onAuthStateChange, supabase } from '../src/lib/supabase';
import { syncPurchaseUser } from '../src/lib/purchases';
import { posthog } from '../src/lib/posthog';
import { startDeviceRuntime } from '../src/lib/device-runtime';
import { SpeechPrompt } from '../src/components/SpeechPrompt';
import { colors } from '../src/lib/theme';

// Web has no share sheet to receive from; Expo Go has no native module, and the
// hook already treats a missing module as "nothing shared". ShareIntake clears
// a share once it has taken it, so the library must not clear it on
// backgrounding: a share waiting for sign-in would vanish while the user
// switched away to find their password.
const SHARE_OPTIONS = { disabled: Platform.OS === 'web', resetOnBackground: false };

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>();
  const gate = useClientGate();
  const [loaded] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    Unbounded_700Bold,
    SpaceMono_700Bold,
  });

  useEffect(() => {
    let active = true;
    // The cache and the tier are dropped before a different user's session
    // renders. Entitlements follow the Editify account, so the store user is
    // re-pointed on every session change rather than once at launch.
    const adopt = (next: Session | null): void => {
      if (!active) return;
      scopeCacheTo(next?.user.id);
      void syncPurchaseUser(next?.user.id);
      setSession(next);
    };
    void supabase.auth.getSession().then(({ data }) => adopt(data.session));
    const unsubscribe = onAuthStateChange(adopt);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (session === undefined) return;
    if (session) posthog?.identify(session.user.id);
    else posthog?.reset();
  }, [session]);

  useEffect(() => {
    void posthog?.screen(pathname);
  }, [pathname]);

  // The engine's capabilities (line, OS, tier, transcriber, background export) tag every
  // PostHog event (C12), and the words flow listens for analysis and permission changes (C15).
  useEffect(() => { startDeviceRuntime(); }, []);

  useEffect(() => {
    if (session === undefined) return;
    const isSigningIn = (segments[0] as string | undefined) === 'sign-in';
    if (!session && !isSigningIn) router.replace('/sign-in' as Href);
    if (session && isSigningIn) router.replace('/');
  }, [router, segments, session]);

  if (!loaded || session === undefined) return null;
  // The sunset screen exports the user's videos, which needs their session, so
  // a signed-out phone reaches sign-in first and meets the gate right after.
  const blocking = gate.kind === 'update' || (gate.kind === 'sunset' && session) ? gate : undefined;
  return (
    <ShareIntentProvider options={SHARE_OPTIONS}>
      <SafeAreaProvider>
        <AppProviders>
          <StatusBar style="light" />
          <ShareIntake signedIn={Boolean(session)} />
          {/* Hidden from VoiceOver while the gate blocks, so swiping cannot reach the app behind it. */}
          <View style={styles.app} {...behindGate(Boolean(blocking))}>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'fade' }} />
          </View>
          {session && !blocking && <SpeechPrompt />}
          {/* Over the navigator rather than instead of it: expo-router needs the Stack mounted to route. */}
          {blocking && <View style={StyleSheet.absoluteFill} accessibilityViewIsModal><UpdateGate gate={blocking} /></View>}
        </AppProviders>
      </SafeAreaProvider>
    </ShareIntentProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.background },
});
