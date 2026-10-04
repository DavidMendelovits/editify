import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createClient, type Session } from '@supabase/supabase-js';
import { setAccessToken } from './api';
import { noteAuthEvent } from './token-clock';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'https://xvstucurpuwpliowadnh.supabase.co';
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY ?? 'sb_publishable_ueit6kPTSj1tJsUohEzSZQ_IEMwTBZx';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // Web signs in by redirecting to Google and back, so the callback's `?code=`
    // has to be picked up off the URL. Native uses an id token and never redirects.
    detectSessionInUrl: Platform.OS === 'web',
  },
});

type AuthStateListener = (session: Session | null) => void;

const listeners = new Set<AuthStateListener>();
let currentSession: Session | null | undefined;

function publishSession(session: Session | null): void {
  currentSession = session;
  setAccessToken(session?.access_token);
  listeners.forEach((listener) => listener(session));
}

void supabase.auth.getSession().then(({ data }) => publishSession(data.session));

// One auth observer owns API token changes; screens subscribe to its snapshots.
supabase.auth.onAuthStateChange((event, session) => {
  noteAuthEvent(event, session?.access_token);
  publishSession(session);
});

/**
 * A new session, whatever the old one's expiry, so media URLs minted after it carry a new token
 * (it reaches setAccessToken through onAuthStateChange). For media the native preview gave up on:
 * a retry must never reuse the URL that just failed. Offline, it fails, and the retry goes on
 * with the URLs held.
 */
export async function freshSession(): Promise<void> {
  const { error } = await supabase.auth.refreshSession();
  if (error) throw error;
}

export function onAuthStateChange(listener: AuthStateListener): () => void {
  listeners.add(listener);
  if (currentSession !== undefined) listener(currentSession);
  return () => listeners.delete(listener);
}
