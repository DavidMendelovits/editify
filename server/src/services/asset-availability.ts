import { stat } from 'node:fs/promises';
import type { AssetAvailability } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';

/**
 * Whether the server holds each original, for the server fallback (plan OV1):
 *
 *   no row ............................ absent    (nothing to restore: import it again)
 *   a row this user can't read ........ forbidden (another account's; the sound library is readable)
 *   a readable row, file on disk ...... present
 *   a readable row, no file ........... missing   (the original was removed)
 *
 * `userId` undefined is the unscoped caller (shared token, local dev), as in AssetStore.
 */
export async function assetAvailability(
  assets: Pick<AssetStore, 'get'>,
  ids: Iterable<string>,
  userId: string | undefined,
): Promise<Map<string, AssetAvailability>> {
  const unique = [...new Set(ids)];
  const statuses = await Promise.all(unique.map(async (id): Promise<AssetAvailability> => {
    const row = assets.get(id);
    if (!row) return 'absent';
    if (userId !== undefined && !assets.get(id, userId)) return 'forbidden';
    return await isFile(row.originalPath) ? 'present' : 'missing';
  }));
  return new Map(unique.map((id, index) => [id, statuses[index] as AssetAvailability]));
}

/** A regular file at `path` (an empty path is none). */
export async function isFile(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The ids with `status`, in the order given. */
export function idsWith(availability: ReadonlyMap<string, AssetAvailability>, status: AssetAvailability): string[] {
  return [...availability].filter(([, value]) => value === status).map(([id]) => id);
}
