import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Brand } from '../src/components/Brand';
import { GradientButton } from '../src/components/GradientButton';
import { Screen } from '../src/components/Screen';
import { supabase } from '../src/lib/supabase';
import { colors, fonts } from '../src/lib/theme';

type AuthAction = 'sign-in' | 'sign-up' | 'google';

const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const isWeb = Platform.OS === 'web';
// Expo Go has no RNGoogleSignin native module — on native the button only appears in a
// dev-client or release build. See apps/mobile/README.md for the build commands.
const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
// Web redirects through Supabase, which holds the client ID itself, so it needs no env var.
const googleEnabled = isWeb || (!inExpoGo && Boolean(GOOGLE_WEB_CLIENT_ID));

async function loadGoogleSignIn() {
  if (!GOOGLE_WEB_CLIENT_ID || Platform.OS === 'web') throw new Error('Google sign-in is not configured.');
  const google = await import('@react-native-google-signin/google-signin');
  google.GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
  });
  return google;
}

export default function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<AuthAction>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function run(action: AuthAction, work: () => Promise<void>): Promise<void> {
    setBusy(action);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(undefined);
    }
  }

  function validateCredentials(): void {
    if (!email.trim() || !password) throw new Error('Enter your email and password.');
  }

  function signIn(): void {
    void run('sign-in', async () => {
      validateCredentials();
      const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (authError) throw authError;
    });
  }

  function signUp(): void {
    void run('sign-up', async () => {
      validateCredentials();
      const { data, error: authError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        // Confirmation emails otherwise link to the Supabase Site URL default (localhost:3000).
        ...(isWeb ? { options: { emailRedirectTo: window.location.origin } } : {}),
      });
      if (authError) throw authError;
      if (!data.session) setNotice('Account created. Check your email to confirm it, then sign in.');
    });
  }

  function signInWithGoogle(): void {
    void run('google', async () => {
      if (isWeb) {
        // Navigates away to Google and comes back to the app; `detectSessionInUrl`
        // in supabase.ts turns the callback into a session.
        const { error: redirectError } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: window.location.origin },
        });
        if (redirectError) throw redirectError;
        return;
      }
      const google = await loadGoogleSignIn();
      if (Platform.OS === 'android') {
        await google.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      }
      const response = await google.GoogleSignin.signIn();
      if (!google.isSuccessResponse(response)) return;
      if (!response.data.idToken) throw new Error('Google did not return an identity token.');
      const { error: authError } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: response.data.idToken,
      });
      if (authError) throw authError;
    });
  }

  const socialEnabled = googleEnabled;

  return (
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={styles.brand}><Brand /></View>
        <View style={styles.shell}>
          <View style={styles.intro}>
            <Text style={styles.kicker}>YOUR CUTTING ROOM</Text>
            <Text style={styles.title}>Make the first cut.</Text>
            <Text style={styles.subtitle}>Sign in to keep your footage, timelines, and editing style together.</Text>
          </View>

          <View style={styles.card}>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>EMAIL</Text>
              <TextInput
                accessibilityLabel="email"
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor="#666474"
                style={styles.input}
                textContentType="emailAddress"
                value={email}
              />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>PASSWORD</Text>
              <TextInput
                accessibilityLabel="password"
                autoCapitalize="none"
                autoComplete="password"
                onChangeText={setPassword}
                onSubmitEditing={signIn}
                placeholder="At least 6 characters"
                placeholderTextColor="#666474"
                secureTextEntry
                style={styles.input}
                textContentType="password"
                value={password}
              />
            </View>

            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            {notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}

            <GradientButton disabled={Boolean(busy)} onPress={signIn} style={styles.primaryButton}>
              {busy === 'sign-in' ? 'signing in…' : 'sign in'}
            </GradientButton>
            <Pressable
              accessibilityRole="button"
              disabled={Boolean(busy)}
              onPress={signUp}
              style={({ pressed }) => [styles.createButton, pressed && styles.pressed, busy && styles.disabled]}
            >
              <Text style={styles.createText}>{busy === 'sign-up' ? 'creating account…' : 'create account'}</Text>
            </Pressable>

            {socialEnabled && (
              <>
                <View style={styles.divider}><View style={styles.line} /><Text style={styles.or}>OR</Text><View style={styles.line} /></View>
                <View style={styles.socialStack}>
                  {googleEnabled && (
                    <Pressable
                      accessibilityRole="button"
                      disabled={Boolean(busy)}
                      onPress={signInWithGoogle}
                      style={({ pressed }) => [styles.googleButton, pressed && styles.pressed, busy && styles.disabled]}
                    >
                      {busy === 'google' ? <ActivityIndicator color="#16151D" /> : <Text style={styles.googleMark}>G</Text>}
                      <Text style={styles.googleText}>Sign in with Google</Text>
                    </Pressable>
                  )}
                </View>
              </>
            )}
          </View>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1, backgroundColor: colors.background },
  brand: { minHeight: 58, justifyContent: 'center' },
  shell: { flex: 1, width: '100%', maxWidth: 460, alignSelf: 'center', justifyContent: 'center', gap: 28, paddingVertical: 34 },
  intro: { alignItems: 'center', gap: 10 },
  kicker: { color: colors.purple, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2.2 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 38, lineHeight: 44, letterSpacing: -1.7, textAlign: 'center' },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, textAlign: 'center', maxWidth: 390 },
  card: { gap: 14, borderRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 22 },
  fieldGroup: { gap: 7 },
  label: { color: colors.muted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.5 },
  input: { height: 50, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.text, fontFamily: fonts.medium, fontSize: 14, paddingHorizontal: 15 },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: 12, lineHeight: 18 },
  notice: { color: colors.success, fontFamily: fonts.medium, fontSize: 12, lineHeight: 18 },
  primaryButton: { marginTop: 4 },
  createButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  createText: { color: colors.text, fontFamily: fonts.bold, fontSize: 14 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 3 },
  line: { flex: 1, height: 1, backgroundColor: colors.border },
  or: { color: colors.muted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.4 },
  socialStack: { gap: 10 },
  googleButton: { minHeight: 48, borderRadius: 13, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 16 },
  googleMark: { color: '#4285F4', fontFamily: fonts.bold, fontSize: 17 },
  googleText: { color: '#16151D', fontFamily: fonts.semibold, fontSize: 14 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  disabled: { opacity: 0.5 },
});
