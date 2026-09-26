/**
 * Hand-off between the OS share sheet and the editor. The root layout receives
 * shared files; the editor owns the upload, the timeline placement and the
 * sync. This module is the one place both can reach: the editor says which
 * project is open, and the layout parks shared files for that project until
 * its editor picks them up (immediately if open, on mount if just created).
 */

export interface SharedFile { uri: string; name: string; mimeType?: string }

let activeProjectId: string | undefined;
let pending: { projectId: string; files: SharedFile[] } | undefined;
const listeners = new Set<() => void>();

/** The editor calls this on focus with its id, and on blur with `undefined`. */
export function setActiveProject(projectId: string | undefined): void {
  activeProjectId = projectId;
}

export function getActiveProject(): string | undefined {
  return activeProjectId;
}

export function queueShare(projectId: string, files: SharedFile[]): void {
  pending = { projectId, files };
  for (const listener of listeners) listener();
}

/** Claims the parked files if they are for `projectId`; each share is taken once. */
export function takeShare(projectId: string): SharedFile[] | undefined {
  if (pending?.projectId !== projectId) return undefined;
  const { files } = pending;
  pending = undefined;
  return files;
}

export function subscribeShares(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const MEDIA_EXTENSION = /\.(m4a|mp3|wav|aac|caf|aiff?|mov|mp4|m4v|3gp|webm)$/i;

/** Video and audio only: a shared photo or PDF has nothing to put on a timeline. */
export function isShareableMedia(file: { mimeType?: string | null; fileName?: string | null }): boolean {
  if (file.mimeType?.startsWith('video/') || file.mimeType?.startsWith('audio/')) return true;
  return !file.mimeType && MEDIA_EXTENSION.test(file.fileName ?? '');
}
