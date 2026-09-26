import { File } from 'expo-file-system';

/** Delete the app's own copy of a shared file; a leftover copy is harmless, so failures are ignored. */
export function discardSharedCopy(uri: string): void {
  try {
    const copy = new File(uri);
    if (copy.exists) copy.delete();
  } catch { /* already gone, or not ours to delete */ }
}
