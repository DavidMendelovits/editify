/**
 * Wires the local media registry (local-media.ts) to expo-sqlite, expo-file-system
 * and the editify engine. iOS only: without the engine (Android, a build without the
 * module) there is nothing to resolve against, and imports behave as before.
 */
import { File } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';
import { Platform } from 'react-native';
import { EditifyEngine } from '../../modules/editify-engine';
import { api } from './api';
import {
  applyProxyEvent, asGeometry, createLocalMediaStore, maintainMedia, migrate, releaseProjectMedia,
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
    requestPhotosAccess: async () => await engine.requestPhotosAccess(),
    mediaRoot: () => engine.mediaRoot(),
    durableCopy: async (uri, name) => await engine.durableCopy(uri, name),
    availableBytes: () => engine.availableBytes(),
    mediaFiles: () => engine.mediaFiles(),
    removeMedia: (path) => engine.removeMedia(path),
    fileExists: (uri) => {
      try { return new File(uri).exists; } catch { return false; }
    },
    fileSize: (uri) => {
      try { return new File(uri).size ?? 0; } catch { return 0; }
    },
    geometry: async (ref) => asGeometry(await engine.mediaGeometry(ref)),
    removeFile: (uri) => {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
    ensureProxy: async (assetId, ref) => { await engine.ensureProxy(assetId, ref); },
    touchProxy: (assetId) => engine.touchProxy(assetId),
    removeProxy: (assetId) => engine.removeProxy(assetId),
    analyze: async (assetId, ref, parts, options) => {
      await engine.analyze(assetId, ref, parts as Parameters<typeof engine.analyze>[2], options);
    },
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

  const deps: MediaDeps = { store, native };
  // Launch housekeeping before anyone gets the registry, so it can't overlap the first import.
  await maintainMedia(deps).catch(() => undefined);
  return deps;
}

/**
 * Releases what the phone kept for a deleted project's media, unless another project
 * still uses it. `projectAssetIds` must be read before the delete; failures are ignored
 * (the copy budget and the orphan sweep still bound the space).
 */
export async function releaseDeletedProjectMedia(projectAssetIds: string[]): Promise<void> {
  const deps = await localMedia();
  if (!deps || projectAssetIds.length === 0) return;
  try {
    const projects = await api.listProjects();
    const lists = await Promise.all(projects.map(async (project) => await api.listAssets(project.id)));
    const stillUsed = new Set(lists.flat().map((asset) => asset.id));
    await releaseProjectMedia(deps, projectAssetIds, stillUsed);
  } catch { /* offline: leave it to the budget */ }
}
