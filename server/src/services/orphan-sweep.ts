import type { EditifyDatabase } from '../db/database.js';
import { listDataOwners, purgeUserData, supabaseUserExists, type UserPurge } from './account-service.js';

export interface SweepResult {
  owners: number;
  orphans: string[];
  purged: Record<string, UserPurge>;
  /** Set when the sweep found orphans but declined to delete them. */
  refused?: string;
}

/**
 * The backstop for a missed user-deleted webhook: every user id that owns data
 * here but no longer exists in Supabase auth. Dry run unless `purge` is set.
 *
 * Every lookup finishes before anything is deleted, and any lookup error aborts
 * the sweep (it throws), so an outage never reads as "gone". If every owner
 * looks gone, that is far likelier to be the wrong project or key than a real
 * mass deletion, so the purge refuses unless `force` is set.
 */
export async function sweepOrphans(
  database: EditifyDatabase,
  options: { purge?: boolean; force?: boolean; exists?: (userId: string) => Promise<boolean> } = {},
): Promise<SweepResult> {
  const exists = options.exists ?? supabaseUserExists;
  const owners = listDataOwners(database);
  const orphans: string[] = [];
  for (const userId of owners) {
    if (!(await exists(userId))) orphans.push(userId);
  }
  const result: SweepResult = { owners: owners.length, orphans, purged: {} };
  if (!options.purge || orphans.length === 0) return result;
  if (orphans.length === owners.length && owners.length > 1 && !options.force) {
    return { ...result, refused: 'Every owner looks deleted; check SUPABASE_URL and the key, or pass --force' };
  }
  for (const userId of orphans) result.purged[userId] = await purgeUserData(database, userId);
  return result;
}
