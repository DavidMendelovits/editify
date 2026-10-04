import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assetsRoot, supabaseUrl } from '../config.js';
import type { EditifyDatabase } from '../db/database.js';
import type { StyleService } from './style-service.js';

export interface AccountDeletion { projects: number; assets: number; reports: number; styles: number }

/** What a purge removed from the volume: one directory per asset, one file per render. */
export interface FilesPurged { assetDirs: number; renderOutputs: number }

export interface UserPurge { rows: AccountDeletion; files: FilesPurged }

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
 * Everything one user owns. `user_id IS NULL` rows (pre-auth data, the built-in
 * sound library) belong to nobody, so `= ?` is the whole rule. Cascades do the
 * rest: a project takes its operation log, asset links, renders and chat with
 * it; an asset takes its transcript, insights, dissection and waveform.
 * `video_observations` carries no foreign key, so its rows are cleared by hand,
 * as are the user's `key:userId` preferences. `styles` cancels a style
 * analysis still running for them, so it cannot save a profile afterwards.
 */
export async function deleteUserData(database: EditifyDatabase, userId: string, styles?: Pick<StyleService, 'forget'>): Promise<AccountDeletion> {
  return (await purgeUserData(database, userId, styles)).rows;
}

/**
 * The purge behind `deleteUserData`, with what it took off the volume as well.
 * It needs no HTTP session, so the user-deleted webhook and the orphan sweep
 * run the exact same deletion as DELETE /account.
 */
export async function purgeUserData(database: EditifyDatabase, userId: string, styles?: Pick<StyleService, 'forget'>): Promise<UserPurge> {
  styles?.forget(userId);
  const assetIds = (database.prepare('SELECT id FROM assets WHERE user_id = ?').all(userId) as Array<{ id: string }>)
    .map((row) => row.id);
  // Read before the delete: dropping the projects cascades these rows away.
  const outputs = (database.prepare(`
    SELECT renders.output_path AS output_path FROM renders
    JOIN projects ON projects.id = renders.project_id
    WHERE projects.user_id = ? AND renders.output_path IS NOT NULL
  `).all(userId) as Array<{ output_path: string }>).map((row) => row.output_path);

  const rows = database.transaction((): AccountDeletion => {
    // One placeholder per asset would blow SQLite's variable limit for a heavy
    // user, and this is the one endpoint Apple requires to work, so chunk it.
    for (let start = 0; start < assetIds.length; start += OBSERVATION_DELETE_CHUNK) {
      const chunk = assetIds.slice(start, start + OBSERVATION_DELETE_CHUNK);
      database.prepare(`DELETE FROM video_observations WHERE asset_id IN (${chunk.map(() => '?').join(', ')})`)
        .run(...chunk);
    }
    // Per-user preferences are `key:userId` rows (SettingsStore.setFor).
    database.prepare('DELETE FROM settings WHERE substr(key, -length(?)) = ?').run(`:${userId}`, `:${userId}`);
    return {
      projects: database.prepare('DELETE FROM projects WHERE user_id = ?').run(userId).changes,
      assets: database.prepare('DELETE FROM assets WHERE user_id = ?').run(userId).changes,
      reports: database.prepare('DELETE FROM reports WHERE user_id = ?').run(userId).changes,
      styles: database.prepare('DELETE FROM style_profiles WHERE user_id = ?').run(userId).changes,
    };
  })();

  // Media is one directory per asset; a render output is a single file.
  const removed = await Promise.all([
    ...assetIds.map(async (id) => await removeIfPresent(join(assetsRoot, id))),
    ...outputs.map(async (path) => await removeIfPresent(path)),
  ]);
  const files: FilesPurged = {
    assetDirs: removed.slice(0, assetIds.length).filter(Boolean).length,
    renderOutputs: removed.slice(assetIds.length).filter(Boolean).length,
  };
  return { rows, files };
}

/** True when something was there to remove; a missing path is not an error. */
async function removeIfPresent(path: string): Promise<boolean> {
  const present = await stat(path).then(() => true, () => false);
  await rm(path, { recursive: true, force: true });
  return present;
}

/**
 * Every user id that owns something on this server: the four owned tables
 * plus `key:userId` preferences. Supabase user ids are UUIDs, which is what
 * tells a per-user setting suffix apart from any other colon in a key.
 */
export function listDataOwners(database: EditifyDatabase): string[] {
  const owners = new Set((database.prepare(`
    SELECT user_id FROM projects WHERE user_id IS NOT NULL
    UNION SELECT user_id FROM assets WHERE user_id IS NOT NULL
    UNION SELECT user_id FROM reports WHERE user_id IS NOT NULL
    UNION SELECT user_id FROM style_profiles WHERE user_id IS NOT NULL
  `).all() as Array<{ user_id: string }>).map((row) => row.user_id));
  for (const { key } of database.prepare("SELECT key FROM settings WHERE key LIKE '%:%'").all() as Array<{ key: string }>) {
    const suffix = key.slice(key.lastIndexOf(':') + 1);
    if (UUID.test(suffix)) owners.add(suffix);
  }
  return [...owners].sort();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether Supabase still has this login, from the admin API. Only a 404 counts
 * as gone; anything else that is not a 200 throws, because callers delete data
 * on "gone" and an outage must never read as that.
 */
export async function supabaseUserExists(userId: string): Promise<boolean> {
  const key = serviceRoleKey();
  if (!key) throw new AccountDeletionUnavailable(missingKeyMessage());
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`Supabase admin lookup failed (${response.status})`);
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
