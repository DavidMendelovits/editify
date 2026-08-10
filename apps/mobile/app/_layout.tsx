import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  Montserrat_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/montserrat';
import { AppProviders } from '../src/providers/AppProviders';
import { colors } from '../src/lib/theme';

export default function RootLayout() {
  const [loaded] = useFonts({
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
  });
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <AppProviders>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'fade' }} />
      </AppProviders>
    </SafeAreaProvider>
  );
}
