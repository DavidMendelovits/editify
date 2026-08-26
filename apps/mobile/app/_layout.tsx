import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';
import {
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  Montserrat_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/montserrat';
import { AppProviders } from '../src/providers/AppProviders';
import { onAuthStateChange, supabase } from '../src/lib/supabase';
import { colors } from '../src/lib/theme';

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const [session, setSession] = useState<Session | null>();
  const [loaded] = useFonts({
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
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
