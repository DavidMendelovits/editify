/**
 * Wires the local media registry (local-media.ts) to expo-sqlite, expo-file-system
 * and the editify engine. iOS only: without the engine (Android, a build without the
 * module) there is nothing to resolve against, and imports behave as before.
 */
import { File } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';
import { Platform } from 'react-native';
import { EditifyEngine } from '../../modules/editify-engine';
import {
  applyProxyEvent, createLocalMediaStore, migrate,
  type MediaDeps, type MediaNative, type MediaProbe, type ProxyStatusEvent, type SqlDb,
} from './local-media';

let opening: Promise<MediaDeps | null> | undefined;

/** The registry and its native calls, or null where there is no device engine. Opened once. */
export function localMedia(): Promise<MediaDeps | null> {
  opening ??= open().catch(() => null);
  return opening;
}

async function open(): Promise<MediaDeps | null> {
  const engine = EditifyEngine;
  if (Platform.OS !== 'ios' || !engine) return null;
  const db = await openDatabaseAsync('local-media.db');
  await migrate(db as unknown as SqlDb);
  const store = createLocalMediaStore(db as unknown as SqlDb);

  const native: MediaNative = {
    probe: async (ref) => await engine.probeMedia(ref) as MediaProbe,
    download: async (ref, requestId, onProgress) => {
      const subscription = onProgress
        ? engine.addListener('progress', (event) => {
          if ('requestId' in event && event.requestId === requestId) onProgress(event.fraction);
        })
        : undefined;
      try {
        return await engine.downloadMedia(ref, requestId) as MediaProbe;
      } finally {
        subscription?.remove();
      }
    },
    cancelDownload: (requestId) => engine.cancelDownload(requestId),
    photosAccess: () => engine.photosAccess(),
    mediaRoot: () => engine.mediaRoot(),
    durableCopy: async (uri, name) => await engine.durableCopy(uri, name),
    fileExists: (uri) => {
      try { return new File(uri).exists; } catch { return false; }
    },
    removeFile: (uri) => {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
    ensureProxy: async (assetId, ref) => { await engine.ensureProxy(assetId, ref); },
    touchProxy: (assetId) => engine.touchProxy(assetId),
  };

  // The proxy part's status lands in the registry however it was queued.
  engine.addListener('analysisStatus', (event) => {
    if (event.part !== 'proxy') return;
    void applyProxyEvent(store, event as ProxyStatusEvent, async (assetId) => {
      const analysis = await engine.getAnalysis(assetId);
      const data = analysis.parts.proxy?.data as { path?: string } | undefined;
      return data?.path;
    }).catch(() => undefined);
  });

  return { store, native };
}
