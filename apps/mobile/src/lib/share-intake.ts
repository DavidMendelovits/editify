/**
 * Hand-off between the OS share sheet and the editor. The root layout receives
 * shared files; the editor owns the upload, the timeline placement and the
 * sync. This module is the one place both can reach: the editor says which
 * project is open, and the layout parks shared files for that project until
 * its editor picks them up (immediately if open, on mount if just created).
 */

export interface SharedFile { uri: string; name: string; mimeType?: string }

let activeProjectId: string | undefined;
/** Per project, and appended to: a second share before the first is picked up is kept, not overwritten. */
const pending = new Map<string, SharedFile[]>();
const listeners = new Set<() => void>();

/**
 * The editor calls this with its id on focus, and with `undefined` on unmount.
 * Not on blur: export and the paywall push over the editor, and a share that
 * arrives then still belongs to the project underneath.
 */
export function setActiveProject(projectId: string | undefined): void {
  activeProjectId = projectId;
}

export function getActiveProject(): string | undefined {
  return activeProjectId;
}

export function queueShare(projectId: string, files: SharedFile[]): void {
  pending.set(projectId, [...(pending.get(projectId) ?? []), ...files]);
  for (const listener of listeners) listener();
}

/** Claims everything parked for `projectId`; each file is taken once. */
export function takeShare(projectId: string): SharedFile[] | undefined {
  const files = pending.get(projectId);
  pending.delete(projectId);
  return files;
}

export function subscribeShares(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const MEDIA_EXTENSION = /\.(m4a|mp3|wav|aac|caf|aiff?|mov|mp4|m4v|3gp|webm)$/i;

/**
 * Video and audio only: a shared photo or PDF has nothing to put on a timeline.
 * A missing or generic MIME type falls back to the file extension; the server
 * probes every upload anyway, so this only decides what is worth sending.
 */
export function isShareableMedia(file: { mimeType?: string | null; fileName?: string | null }): boolean {
  if (file.mimeType?.startsWith('video/') || file.mimeType?.startsWith('audio/')) return true;
  const generic = !file.mimeType || file.mimeType === 'application/octet-stream';
  return generic && MEDIA_EXTENSION.test(file.fileName ?? '');
}
