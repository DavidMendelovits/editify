import { rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assetsRoot, rendersRoot, supabaseUrl } from '../config.js';
import type { EditifyDatabase } from '../db/database.js';
import type { StyleService } from './style-service.js';

export interface AccountDeletion { projects: number; assets: number; reports: number; styles: number }

/** What a purge removed from the volume: one directory per asset, one directory per render. */
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
  // Every render, finished or not: `renders/<id>/` also holds the caption text
  // (captions.ass) and the contact sheet of frames, not just output.mp4.
  const renderRows = database.prepare(`
    SELECT renders.id AS id, renders.output_path AS output_path FROM renders
    JOIN projects ON projects.id = renders.project_id
    WHERE projects.user_id = ?
  `).all(userId) as Array<{ id: string; output_path: string | null }>;

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

  // Media is one directory per asset and one per render. A recorded output
  // outside its render directory (older layouts, tests) goes too.
  const removed = await Promise.all([
    ...assetIds.map(async (id) => await removeIfPresent(childDirectory(assetsRoot, id))),
    ...renderRows.map(async ({ id, output_path: output }) => {
      const directory = childDirectory(rendersRoot, id);
      const [dir, file] = await Promise.all([
        removeIfPresent(directory),
        output && dirname(output) !== directory ? removeIfPresent(output, { recursive: false }) : Promise.resolve(false),
      ]);
      return dir || file;
    }),
  ]);
  const files: FilesPurged = {
    assetDirs: removed.slice(0, assetIds.length).filter(Boolean).length,
    renderOutputs: removed.slice(assetIds.length).filter(Boolean).length,
  };
  return { rows, files };
}

/**
 * `root/<id>`, or undefined when the id is not one plain path segment: a
 * recursive delete must never be able to resolve to the root or above it.
 */
function childDirectory(root: string, id: string): string | undefined {
  return id && id !== '.' && id !== '..' && basename(id) === id && !id.includes('\\') ? join(root, id) : undefined;
}

/**
 * True when something was there to remove; a missing path is not an error.
 * A recorded output path is removed as a file only, never recursively.
 */
async function removeIfPresent(path: string | undefined, options = { recursive: true }): Promise<boolean> {
  if (!path) return false;
  const present = await stat(path).then(() => true, () => false);
  await rm(path, { recursive: options.recursive, force: true });
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
 * Whether Supabase still has this login, from the admin API. Only Auth's own
 * "user not found" counts as gone; anything else that is not a 200 throws,
 * because callers delete data on "gone" and an outage must never read as that.
 * That includes a bare 404 from a wrong SUPABASE_URL, a proxy or a gateway.
 */
export async function supabaseUserExists(userId: string): Promise<boolean> {
  const key = serviceRoleKey();
  if (!key) throw new AccountDeletionUnavailable(missingKeyMessage());
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (response.ok) return true;
  if (response.status === 404 && await isUserNotFound(response)) return false;
  throw new Error(`Supabase admin lookup failed (${response.status})`);
}

/**
 * Auth's GET /admin/users/{id} answers an unknown id with 404 and the error
 * code `user_not_found` (internal/api/admin.go, loadUser). With no API version
 * header the body is the legacy envelope
 *   {"code":404,"error_code":"user_not_found","msg":"User not found"}
 * and the 2024-01-01 envelope is {"code":"user_not_found","message":"..."}.
 * Auth also sets `x-sb-error-code`. Any of the three is accepted.
 */
async function isUserNotFound(response: Response): Promise<boolean> {
  if (response.headers.get('x-sb-error-code') === USER_NOT_FOUND) return true;
  const body = await response.json().catch(() => undefined) as { error_code?: unknown; code?: unknown } | undefined;
  return body?.error_code === USER_NOT_FOUND || body?.code === USER_NOT_FOUND;
}

const USER_NOT_FOUND = 'user_not_found';

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
