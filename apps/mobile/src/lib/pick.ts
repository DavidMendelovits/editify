import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { AssetMetadata } from '@editify/shared';
import { uploadAsset } from './api';

/** `assets` is empty when the user backed out of the picker — that is not an error. */
export interface PickResult {
  assets: AssetMetadata[];
  /** File names the server refused or that failed mid-upload; the rest still landed. */
  failed: string[];
}

export type PickProgress = (done: number, total: number) => void;

interface PendingFile { uri: string; name: string; mimeType?: string; file?: File }

/** Enough to keep the pipe full without the server queueing multipart writes. */
const UPLOAD_CONCURRENCY = 4;

/**
 * A few uploads at a time: the import request only writes the file to disk and
 * probes it — `queueAssetWork` moved the proxy transcode and the transcription
 * to the background — so the network transfer is the part worth overlapping.
 * Results go in by index because completions arrive out of order and the picked
 * order is the order the clips land on the timeline. One bad file does not sink
 * the batch. Everything lands in `projectId`'s library.
 */
async function uploadAll(projectId: string, files: PendingFile[], onProgress?: PickProgress): Promise<PickResult> {
  const uploaded = new Array<AssetMetadata | undefined>(files.length);
  const failed: string[] = [];
  let next = 0;
  let settled = 0;
  onProgress?.(0, files.length);
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, async () => {
    for (let index = next++; index < files.length; index = next++) {
      const file = files[index] as PendingFile;
      try {
        uploaded[index] = await uploadAsset({ ...file, projectId });
      } catch {
        failed.push(file.name);
      }
      settled += 1;
      onProgress?.(settled, files.length);
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
    return 'iOS would not hand over that video (Photos error 3164). It is probably still in iCloud — open it in Photos to download it — or Editify only has access to a limited selection, which you can change to all photos in Settings.';
  }
  return message;
}

/**
 * The device photo library: Apple Photos on iOS, the gallery (Google Photos and
 * friends) on Android, a file input on web. Videos only — a clip needs a media
 * stream the server can probe, and stills have none.
 */
export async function pickFromPhotos(projectId: string, onProgress?: PickProgress): Promise<PickResult> {
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
    ...(file.file ? { file: file.file } : {}),
  })), onProgress);
}

/** Files app / Finder / Drive — anything the OS document provider exposes. */
export async function pickFromFiles(projectId: string, onProgress?: PickProgress): Promise<PickResult> {
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
    ...(file.file ? { file: file.file } : {}),
  })), onProgress);
}
