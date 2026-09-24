import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
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
import { onAuthStateChange, supabase } from '../src/lib/supabase';
import { syncPurchaseUser } from '../src/lib/purchases';
import { colors } from '../src/lib/theme';

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
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
  }, [session]);

  useEffect(() => {
    if (session === undefined) return;
    const isSigningIn = (segments[0] as string | undefined) === 'sign-in';
    if (!session && !isSigningIn) router.replace('/sign-in' as Href);
    if (session && isSigningIn) router.replace('/');
  }, [router, segments, session]);

  if (!loaded || session === undefined) return null;
  return (
    <SafeAreaProvider>
      <AppProviders>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'fade' }} />
      </AppProviders>
    </SafeAreaProvider>
  );
}
