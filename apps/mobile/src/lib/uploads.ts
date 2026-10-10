import { useMemo, useSyncExternalStore } from 'react';
import { uploadOriginal } from './api';
import { localMedia } from './local-media-native';
import { createUploadQueue, type UploadEntry } from './upload-queue';

/**
 * Where a land-first clip's file is on this phone (its copy, or the picked file of a Photos
 * original), for its timeline frames until the server has made them. This launch only.
 */
export const localSources = new Map<string, string>();

/** The app's one queue of land-first originals (upload-queue.ts), wired to the registry and PUT /assets/:id/original. */
export const uploads = createUploadQueue({
  media: localMedia,
  upload: async (entry, file, onBytes, signal) => {
    // The registry's file name and type; the type it was registered with when the name says nothing.
    const mimeType = file.mimeType ?? entry.mimeType;
    await uploadOriginal(entry.assetId, entry.projectId, { uri: file.uri, name: file.name, ...(mimeType ? { mimeType } : {}) }, onBytes, signal);
  },
});

/** Originals still uploading (or failed), for one project or all of them. */
export function useUploads(projectId?: string): readonly UploadEntry[] {
  const all = useSyncExternalStore(uploads.subscribe, uploads.entries);
  return useMemo(() => (projectId ? all.filter((entry) => entry.projectId === projectId) : all), [all, projectId]);
}

/** One clip's upload, or undefined once its original is on the server (or it never had one). */
export function useUpload(assetId: string | undefined): UploadEntry | undefined {
  const all = useSyncExternalStore(uploads.subscribe, uploads.entries);
  return assetId ? all.find((entry) => entry.assetId === assetId) : undefined;
}
