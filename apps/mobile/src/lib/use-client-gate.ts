import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Application from 'expo-application';
import { API_URL } from './api';
import { decideGate, fetchClientConfig, rememberClientConfig, type Gate } from './client-config';
import { track } from './event-log';

const OPEN: Gate = { kind: 'none' };

/**
 * Asks the server whether this build may still be used: once at launch and
 * again every time the app comes back to the foreground, so raising the floor
 * reaches a phone that was left open. Anything short of a clear answer leaves
 * the app usable (see `client-config.ts`).
 */
export function useClientGate(): Gate {
  const [gate, setGate] = useState<Gate>(OPEN);

  useEffect(() => {
    // Web is served by the API itself, so it is always the current client.
    if (Platform.OS === 'web') return;
    let active = true;
    const check = async (): Promise<void> => {
      const config = await fetchClientConfig(API_URL, (detail) => track('client_config', detail));
      if (!active) return;
      rememberClientConfig(config);
      setGate(decideGate(config, {
        appVersion: Application.nativeApplicationVersion,
        platform: Platform.OS,
        osVersion: Platform.Version,
      }));
    };
    void check();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return gate;
}
