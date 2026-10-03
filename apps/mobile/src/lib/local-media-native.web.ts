import type { MediaDeps } from './local-media';

/** Web keeps no local media: every source resolves through the server. */
export function localMedia(): Promise<MediaDeps | null> {
  return Promise.resolve(null);
}
