import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assetsRoot, supabaseUrl } from '../config.js';
import type { EditifyDatabase } from '../db/database.js';

export interface AccountDeletion { projects: number; assets: number; reports: number }

/** Well under SQLite's bound-parameter ceiling on every build we might run on. */
const OBSERVATION_DELETE_CHUNK = 500;

/** Thrown when the server has no service-role key, so the login cannot be removed. */
export class AccountDeletionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountDeletionUnavailable';
  }
}

/**
 * Everything one user owns. `user_id IS NULL` is the shared scope (pre-auth
 * rows, the built-in sound library) and belongs to nobody, so `= ?` is the
 * whole rule. Cascades do the rest: a project takes its operation log, asset
 * links, renders and chat with it; an asset takes its transcript, insights,
 * dissection and waveform. `video_observations` carries no foreign key, so its
 * rows are cleared by hand.
 */
export async function deleteUserData(database: EditifyDatabase, userId: string): Promise<AccountDeletion> {
  const assetIds = (database.prepare('SELECT id FROM assets WHERE user_id = ?').all(userId) as Array<{ id: string }>)
    .map((row) => row.id);
  // Read before the delete: dropping the projects cascades these rows away.
  const outputs = (database.prepare(`
    SELECT renders.output_path AS output_path FROM renders
    JOIN projects ON projects.id = renders.project_id
    WHERE projects.user_id = ? AND renders.output_path IS NOT NULL
  `).all(userId) as Array<{ output_path: string }>).map((row) => row.output_path);

  const counts = database.transaction((): AccountDeletion => {
    // One placeholder per asset would blow SQLite's variable limit for a heavy
    // user, and this is the one endpoint Apple requires to work, so chunk it.
    for (let start = 0; start < assetIds.length; start += OBSERVATION_DELETE_CHUNK) {
      const chunk = assetIds.slice(start, start + OBSERVATION_DELETE_CHUNK);
      database.prepare(`DELETE FROM video_observations WHERE asset_id IN (${chunk.map(() => '?').join(', ')})`)
        .run(...chunk);
    }
    return {
      projects: database.prepare('DELETE FROM projects WHERE user_id = ?').run(userId).changes,
      assets: database.prepare('DELETE FROM assets WHERE user_id = ?').run(userId).changes,
      reports: database.prepare('DELETE FROM reports WHERE user_id = ?').run(userId).changes,
    };
  })();

  // Media is one directory per asset; a render output is a single file.
  await Promise.all([
    ...assetIds.map(async (id) => { await rm(join(assetsRoot, id), { recursive: true, force: true }); }),
    ...outputs.map(async (path) => { await rm(path, { force: true }); }),
  ]);
  return counts;
}

/**
 * Removes the Supabase login itself. This is `auth.admin.deleteUser` over the
 * wire: the server already talks to Supabase as plain HTTP (auth.ts fetches its
 * JWKS), and keeping it that way means no SDK in the server's dependencies.
 */
export async function deleteSupabaseUser(userId: string): Promise<void> {
  const key = serviceRoleKey();
  if (!key) throw new AccountDeletionUnavailable(missingKeyMessage());
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  // 404 means the login is already gone, which is the state this call wants.
  if (!response.ok && response.status !== 404) {
    throw new Error(`Supabase refused the account delete (${response.status}): ${await response.text()}`);
  }
}

/** Present only when both halves of the admin credential are configured. */
export function serviceRoleKey(): string | undefined {
  return supabaseUrl ? process.env.SUPABASE_SERVICE_ROLE_KEY || undefined : undefined;
}

export function missingKeyMessage(): string {
  return 'Account deletion is not configured on this server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.';
}
