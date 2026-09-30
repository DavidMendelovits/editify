import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile } from 'expo-file-system';
import { discardSharedCopy } from './shared-files';
import * as ImagePicker from 'expo-image-picker';
import type { AssetMetadata } from '@editify/shared';
import { uploadAsset } from './api';
import type { ImportProgress } from './upload-progress';
import type { SharedFile } from './share-intake';

/** `assets` is empty when the user backed out of the picker — that is not an error. */
export interface PickResult {
  assets: AssetMetadata[];
  /** File names the server refused or that failed mid-upload; the rest still landed. */
  failed: string[];
}

export type PickProgress = (progress: ImportProgress) => void;

interface PendingFile { uri: string; name: string; mimeType?: string; file?: File; size?: number }

/** Progress lands on React state, and a native upload reports every chunk. */
const PROGRESS_INTERVAL_MS = 250;

/** The picker's reported size, else the file on disk; 0 means unknown. */
function sizeOf(file: PendingFile): number {
  if (file.size) return file.size;
  if (file.file) return file.file.size;
  try {
    return new ExpoFile(file.uri).size ?? 0;
  } catch {
    return 0;
  }
}

/** Enough to keep the pipe full without the server queueing multipart writes. */
const UPLOAD_CONCURRENCY = 4;

/**
 * A few uploads at a time: the import request only writes the file to disk and
 * probes it — `queueAssetWork` moved the proxy transcode and the transcription
 * to the background — so the network transfer is the part worth overlapping.
 * Results go in by index because completions arrive out of order and the picked
 * order is the order the clips land on the timeline. One bad file does not sink
 * the batch. Everything lands in `projectId`'s library, or unattached without one.
 */
async function uploadAll(projectId: string | undefined, files: PendingFile[], onProgress?: PickProgress): Promise<PickResult> {
  const uploaded = new Array<AssetMetadata | undefined>(files.length);
  const failed: string[] = [];
  let next = 0;
  let settled = 0;
  // Bytes per file, so concurrent uploads add up instead of overwriting each other.
  const sizes = files.map(sizeOf);
  const sent = files.map(() => 0);
  let lastReport = 0;
  const report = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    onProgress?.({
      done: settled,
      total: files.length,
      sentBytes: sent.reduce((sum, bytes) => sum + bytes, 0),
      totalBytes: sizes.every((size) => size > 0) ? sizes.reduce((sum, size) => sum + size, 0) : 0,
    });
  };
  report(true);
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, async () => {
    for (let index = next++; index < files.length; index = next++) {
      const file = files[index] as PendingFile;
      try {
        uploaded[index] = await uploadAsset({ ...file, ...(projectId ? { projectId } : {}) }, (bytes, expected) => {
          sent[index] = bytes;
          // The upload knows the real size even when the picker did not report one.
          if (!sizes[index] && expected > 0) sizes[index] = expected;
          report();
        });
      } catch {
        failed.push(file.name);
      }
      sent[index] = sizes[index] ?? 0;
      settled += 1;
      report(true);
    }
  }));
  return { assets: uploaded.filter((asset) => asset !== undefined), failed };
}

const libraryOptions: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['videos'],
  allowsMultipleSelection: true,
  selectionLimit: 0, // iOS reads 0 as "no limit"; Android ignores it.
};

/**
 * iOS 14+ and Android 13+ hand back the system picker, which needs no permission
 * at all — asking for one only opts the app into *limited* library access, and
 * reading anything outside that selection then fails with PHPhotosErrorDomain
 * 3164. So: try without, and only fall back to a permission prompt on older
 * platforms that refuse to open the gallery.
 */
async function launchLibrary(): Promise<ImagePicker.ImagePickerResult> {
  try {
    return await ImagePicker.launchImageLibraryAsync(libraryOptions);
  } catch (error) {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error(describePickerError(error));
    return await ImagePicker.launchImageLibraryAsync(libraryOptions);
  }
}

function describePickerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('3164')) {
    return 'iOS would not hand over that video (Photos error 3164). It is probably still in iCloud, so open it in Photos to download it. Editify may also have access to only a limited selection, which you can change to all photos in Settings.';
  }
  return message;
}

/**
 * The device photo library: Apple Photos on iOS, the gallery (Google Photos and
 * friends) on Android, a file input on web. Videos only — a clip needs a media
 * stream the server can probe, and stills have none.
 */
export async function pickFromPhotos(projectId: string | undefined, onProgress?: PickProgress): Promise<PickResult> {
  let picked: ImagePicker.ImagePickerResult;
  try {
    picked = await launchLibrary();
  } catch (error) {
    throw new Error(describePickerError(error));
  }
  if (picked.canceled) return { assets: [], failed: [] };
  return await uploadAll(projectId, picked.assets.map((file, index) => ({
    uri: file.uri,
    // iOS only sometimes carries a PHAsset file name; fall back to something unique.
    name: file.fileName ?? `${file.assetId ?? `clip-${index + 1}`}.mov`,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.fileSize ? { size: file.fileSize } : {}),
    ...(file.file ? { file: file.file } : {}),
  })), onProgress);
}

/** Files app / Finder / Drive — anything the OS document provider exposes. */
export async function pickFromFiles(projectId: string | undefined, onProgress?: PickProgress): Promise<PickResult> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ['video/*', 'audio/*'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (picked.canceled) return { assets: [], failed: [] };
  return await uploadAll(projectId, picked.assets.map((file) => ({
    uri: file.uri,
    name: file.name,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.size ? { size: file.size } : {}),
    ...(file.file ? { file: file.file } : {}),
  })), onProgress);
}

/**
 * Files handed over by the OS share sheet (a Voice Memos recording, a Photos
 * video). The share extension copies each one into the app's own storage, and
 * nothing else ever deletes those copies, so once a file is on the server its
 * copy goes; a failed one stays for a retry.
 */
export async function uploadShared(projectId: string | undefined, files: SharedFile[], onProgress?: PickProgress): Promise<PickResult> {
  const result = await uploadAll(projectId, files, onProgress);
  const failed = new Set(result.failed);
  for (const file of files) if (!failed.has(file.name)) discardSharedCopy(file.uri);
  return result;
}

/** Files dropped on the editor (web only) — same upload path as the pickers. */
export async function uploadFiles(projectId: string | undefined, files: File[], onProgress?: PickProgress): Promise<PickResult> {
  return await uploadAll(projectId, files.map((file) => ({
    uri: '', // unused: `uploadAsset` posts the File itself when it has one.
    name: file.name,
    ...(file.type ? { mimeType: file.type } : {}),
    file,
  })), onProgress);
}
