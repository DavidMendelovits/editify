import { Directory, File, Paths } from 'expo-file-system';
import { api, rebaseServerUrl } from './api';
import { track } from './event-log';
import { exportKey, planExport, remainingItems, type ExportResult } from './export-plan';

export type { ExportResult } from './export-plan';
export interface ExportProgress { done: number; total: number }

/**
 * What already reached Photos in this app session. Module scope rather than
 * component state, so it outlives the gate unmounting on a foreground refetch;
 * a retry saves only what is not in here, and nothing lands in Photos twice.
 */
const savedThisSession = new Set<string>();

/**
 * The sunset screen's one tap: every finished master and every uploaded
 * original goes into the Photos library, one file at a time so a phone with
 * little free space only ever holds one download. A file that fails is
 * counted and skipped; the rest still save. A second run skips everything an
 * earlier one saved, so "Retry" after a partial failure adds no duplicates.
 *
 * expo-media-library is required lazily: a JS bundle that lands on a binary
 * built before the module was added must still render the screen and explain
 * the failure rather than crash on import.
 */
export async function exportToPhotos(onProgress: (progress: ExportProgress) => void): Promise<ExportResult> {
  let MediaLibrary: typeof import('expo-media-library');
  try {
    MediaLibrary = require('expo-media-library') as typeof import('expo-media-library');
  } catch {
    throw new Error('This build of Editify cannot save to Photos. Open each video from the editor and use Save Video instead.');
  }
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) throw new Error('Editify needs permission to add to your photo library. Turn it on in Settings, then try again.');

  const [renders, assets] = await Promise.all([api.listFinishedRenders(), api.listAssets()]);
  const all = planExport(renders, assets);
  const items = remainingItems(all, savedThisSession);
  const already = all.length - items.length;
  const folder = new Directory(Paths.cache, 'photo-export');
  folder.create({ idempotent: true, intermediates: true });

  let saved = already;
  let failed = 0;
  onProgress({ done: saved, total: all.length });
  for (const item of items) {
    const url = rebaseServerUrl(item.url);
    let file: { uri: string; delete(): void } | undefined;
    try {
      if (!url) throw new Error('no url');
      const downloaded = await File.downloadFileAsync(url, new File(folder, item.fileName), { idempotent: true });
      file = downloaded;
      await MediaLibrary.saveToLibraryAsync(downloaded.uri);
      savedThisSession.add(exportKey(item));
      saved += 1;
    } catch (error) {
      failed += 1;
      track('photo_export_failed', `${item.kind} ${item.fileName}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { file?.delete(); } catch { /* the cache directory is the OS's to clear */ }
    }
    onProgress({ done: saved + failed, total: all.length });
  }
  track('photo_export_done', `${saved - already} saved, ${failed} failed of ${items.length} (${already} saved earlier)`);
  return { saved, failed, total: all.length };
}
