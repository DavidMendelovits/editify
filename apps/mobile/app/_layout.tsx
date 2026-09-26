import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
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
import { ShareIntake } from '../src/components/ShareIntake';
import { onAuthStateChange, supabase } from '../src/lib/supabase';
import { syncPurchaseUser } from '../src/lib/purchases';
import { posthog } from '../src/lib/posthog';
import { colors } from '../src/lib/theme';

// Web has no share sheet to receive from; Expo Go has no native module, and the
// hook already treats a missing module as "nothing shared".
const SHARE_OPTIONS = { disabled: Platform.OS === 'web' };

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>();
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
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const unsubscribe = onAuthStateChange((nextSession) => {
      if (active) setSession(nextSession);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Entitlements follow the Editify account, so the store user is re-pointed
  // whenever the session changes rather than once at launch.
  useEffect(() => {
    if (session === undefined) return;
    void syncPurchaseUser(session?.user.id);
    if (session) posthog?.identify(session.user.id);
    else posthog?.reset();
  }, [session]);

  useEffect(() => {
    void posthog?.screen(pathname);
  }, [pathname]);

  useEffect(() => {
    if (session === undefined) return;
    const isSigningIn = (segments[0] as string | undefined) === 'sign-in';
    if (!session && !isSigningIn) router.replace('/sign-in' as Href);
    if (session && isSigningIn) router.replace('/');
  }, [router, segments, session]);

  if (!loaded || session === undefined) return null;
  return (
    <ShareIntentProvider options={SHARE_OPTIONS}>
      <SafeAreaProvider>
        <AppProviders>
          <StatusBar style="light" />
          <ShareIntake signedIn={Boolean(session)} />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'fade' }} />
        </AppProviders>
      </SafeAreaProvider>
    </ShareIntentProvider>
  );
}
