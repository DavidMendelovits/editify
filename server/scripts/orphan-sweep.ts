/**
 * Lists users who own data on this server but no longer exist in Supabase auth,
 * the leftovers of a user-deleted webhook that never arrived. Dry run by default.
 *
 *   npx tsx scripts/orphan-sweep.ts            # list orphans, change nothing
 *   npx tsx scripts/orphan-sweep.ts --purge    # purge them (same code as DELETE /account)
 *   npx tsx scripts/orphan-sweep.ts --purge --force   # even if every owner looks deleted
 *
 * On Fly, from /app/server on each app (editify-dm, editify-v11):
 *   fly ssh console -a <app> -C "sh -c 'cd /app/server && npx tsx scripts/orphan-sweep.ts'"
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (already set on both apps)
 * and reads the live database at DATABASE_PATH / EDITIFY_DATA_DIR.
 *
 * With READ_ONLY=1 (the 1.1 cutover freeze) the dry run opens the database
 * read-only and --purge refuses to run at all.
 */
import { databasePath } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { readOnlyFromEnv } from '../src/read-only.js';
import { serviceRoleKey, missingKeyMessage } from '../src/services/account-service.js';
import { sweepOrphans } from '../src/services/orphan-sweep.js';

const purge = process.argv.includes('--purge');
const force = process.argv.includes('--force');
const readonly = readOnlyFromEnv();

if (purge && readonly) {
  console.error('READ_ONLY=1: this server is frozen, so --purge will not run. Run the dry run here, or purge after the freeze lifts.');
  process.exit(4);
}

if (!serviceRoleKey()) {
  console.error(missingKeyMessage());
  process.exit(2);
}

const database = createDatabase(databasePath, { readonly });
// The live server shares this file; wait out its write transactions rather than fail with SQLITE_BUSY.
database.pragma('busy_timeout = 15000');
try {
  const result = await sweepOrphans(database, { purge, force });
  console.log(JSON.stringify({ mode: purge ? 'purge' : 'dry-run', ...result }, null, 2));
  if (result.refused) process.exitCode = 3;
} finally {
  database.close();
}
