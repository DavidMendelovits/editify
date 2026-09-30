/**
 * Where an import stands. Bytes are the honest measure for video: one 4K clip
 * can take minutes on its own, so a file count alone sits at "0 of 1" the whole
 * time. `totalBytes` is 0 when no size is known up front, and the label falls
 * back to counting files.
 */
export interface ImportProgress {
  done: number;
  total: number;
  sentBytes: number;
  totalBytes: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** "412 MB", "1.8 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

/** 0 to 1, or undefined when there is nothing to measure against. */
export function importFraction(progress: ImportProgress): number | undefined {
  if (progress.totalBytes > 0) return Math.min(1, progress.sentBytes / progress.totalBytes);
  return progress.total > 0 ? progress.done / progress.total : undefined;
}

/** "412 MB of 1.8 GB · 23%", with "· 1 of 3 clips" appended for a batch. */
export function describeImport(progress: ImportProgress): string {
  const clips = progress.total > 1 ? `${progress.done} of ${progress.total} clips` : '';
  if (progress.totalBytes <= 0) return clips || 'uploading';
  const percent = Math.floor((importFraction(progress) ?? 0) * 100);
  const bytes = `${formatBytes(Math.min(progress.sentBytes, progress.totalBytes))} of ${formatBytes(progress.totalBytes)} · ${percent}%`;
  return clips ? `${bytes} · ${clips}` : bytes;
}
