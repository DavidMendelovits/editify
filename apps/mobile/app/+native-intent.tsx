import { getShareExtensionKey } from 'expo-share-intent';

/**
 * The iOS share extension wakes the app with `editify://dataUrl=editifyShareKey`.
 * That is a message for ShareIntake, not a screen, so the router must not try
 * to open it: an empty path keeps a running app where it is (the open editor
 * is exactly where a shared memo should land) and starts a cold launch on the
 * default route. Throwing here crashes the app, so any failure falls back to
 * the path as given.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return path.includes(`dataUrl=${getShareExtensionKey()}`) ? '' : path;
  } catch {
    return path;
  }
}
