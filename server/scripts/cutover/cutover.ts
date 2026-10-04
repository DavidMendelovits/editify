/**
 * The cutover CLI (the flow diagram is in importer.ts, the production order in RUNBOOK.md).
 * On Fly, inside editify-v11, from /app/server:
 *
 *   npx tsx scripts/cutover/cutover.ts measure
 *   npx tsx scripts/cutover/cutover.ts snapshot
 *   npx tsx scripts/cutover/cutover.ts copy     --all
 *   npx tsx scripts/cutover/cutover.ts import   --all | --user <email|id> [--user ...] [--force] [--without-journal]
 *   npx tsx scripts/cutover/cutover.ts delta
 *   npx tsx scripts/cutover/cutover.ts dry-run  --all | --user <email|id> [--quick] [--json]
 *   npx tsx scripts/cutover/cutover.ts failures
 *   npx tsx scripts/cutover/cutover.ts backup-1.1       C22: a backup API copy of 1.1's SQLite before the volume snapshot
 *   npx tsx scripts/cutover/cutover.ts status
 *
 * Source: --source http://editify-dm.internal:7373 (or CUTOVER_SOURCE) with CUTOVER_TOKEN,
 *         or --source-dir DIR --source-db FILE for a local rehearsal.
 * Paths:  --source-root /data (where 1.0's stored paths start), --dest-root (EDITIFY_DATA_DIR, /data),
 *         --dest-db (DATABASE_PATH, <dest-root>/editify.db).
 * DATABASE_URL, when set, is only used to look an --user email up in auth.users (else the admin API).
 *
 * Exit codes: 0 ok, 1 dry-run diff, 2 error, 3 import failures recorded, 4 not enough space.
 */
import { join, resolve } from 'node:path';
import { createDatabase } from '../../src/db/database.js';
import { createPgPools } from '../../src/db/postgres.js';
import { Importer, type Scope } from './importer.js';
import { SpaceError } from './media.js';
import { HttpSource, LocalSource, type CutoverSource } from './source.js';
import { displayUser } from './tables.js';
import { resolveUser } from './users.js';

function options(argv: string[]): { command: string; flags: Map<string, string[]> } {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = rest[index + 1];
    const value = next !== undefined && !next.startsWith('--') ? (index += 1, next) : 'true';
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags };
}

const one = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.at(-1);

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = options(argv);
  if (command === 'help' || flags.has('help')) {
    console.log('usage: cutover.ts measure|snapshot|copy|import|delta|dry-run|failures|backup-1.1|status [--all | --user <email|id>] (see the file header)');
    return 0;
  }
  const destRoot = resolve(one(flags, 'dest-root') ?? process.env.EDITIFY_DATA_DIR ?? '/data');
  const destDb = resolve(one(flags, 'dest-db') ?? process.env.DATABASE_PATH ?? join(destRoot, 'editify.db'));
  const workDir = join(destRoot, 'cutover');
  let source: CutoverSource;
  const sourceDir = one(flags, 'source-dir');
  if (sourceDir) {
    source = new LocalSource(resolve(sourceDir), resolve(one(flags, 'source-db') ?? join(sourceDir, 'editify.db')), workDir);
  } else {
    const url = one(flags, 'source') ?? process.env.CUTOVER_SOURCE ?? 'http://editify-dm.internal:7373';
    source = new HttpSource(url, process.env.CUTOVER_TOKEN ?? '');
  }
  const databaseUrl = process.env.DATABASE_URL;
  const pools = databaseUrl ? createPgPools(databaseUrl) : undefined;
  // Writable: READ_ONLY freezes 1.0, never the 1.1 side the importer writes.
  const dest = createDatabase(destDb, { readonly: false });
  const importer = new Importer({
    source,
    dest,
    destRoot,
    sourceRoot: one(flags, 'source-root') ?? '/data',
    workDir,
    concurrency: Number(one(flags, 'concurrency') ?? 4),
    log: (line) => console.log(line),
  });
  try {
    const scope = async (): Promise<Scope> => {
      if (flags.has('all')) return { kind: 'all' };
      const users = flags.get('user') ?? [];
      if (!users.length) throw new Error('Pass --all (the cutover) or --user <email|id> (a beta_copy import)');
      return { kind: 'users', users: await Promise.all(users.map(async (user) => await resolveUser(user, pools?.sync))) };
    };
    switch (command) {
      case 'measure': {
        const report = await importer.measure();
        console.log(`editify-dm ${report.source.root}, du per directory:`);
        for (const entry of report.source.entries) console.log(`  ${human(entry.bytes).padStart(10)}  ${String(entry.files).padStart(8)} files  ${entry.name}`);
        console.log(`  ${human(report.source.total.bytes).padStart(10)}  ${String(report.source.total.files).padStart(8)} files  total`);
        console.log(`editify-v11 free: ${human(report.destFree)}. Size editify_v11_data at 1.5x: ${human(report.recommendedVolumeBytes)} (C11).`);
        return 0;
      }
      case 'snapshot': {
        const info = await importer.snapshot();
        console.log(JSON.stringify({ path: info.path, size: info.size, sha256: info.sha256, journalId: info.journalId }));
        return 0;
      }
      case 'copy': {
        const result = await importer.copy(await scope());
        console.log(`copied ${result.copied} file(s), ${human(result.bytes)}; ${result.failed} failed`);
        return result.failed ? 3 : 0;
      }
      case 'import': {
        const report = await importer.import(await scope(), { force: flags.has('force'), withoutJournal: flags.has('without-journal') });
        for (const user of report.users) {
          console.log(`${user.status.padEnd(8)} ${displayUser(user.user)}  rows=${user.rows} files=${user.files} (${human(user.bytes)})${user.reasons.length ? `  ${user.reasons.slice(0, 3).join('; ')}` : ''}`);
        }
        console.log(`snapshot ${report.snapshot}, watermark J=${report.watermark}; copied ${report.copied} file(s) (${human(report.copiedBytes)})`);
        if (report.missing.length) console.log(`${report.missing.length} path(s) the rows name are not on 1.0's volume (nothing to copy): ${report.missing.slice(0, 5).join(', ')}`);
        if (report.external.length) console.log(`${report.external.length} path(s) lie outside 1.0's volume root: ${report.external.slice(0, 5).join(', ')}`);
        if (report.orphans.length) console.log(`${report.orphans.length} file(s) under assets/ or renders/ belong to no row and were left behind`);
        return report.users.some((user) => user.status === 'failed') ? 3 : 0;
      }
      case 'delta': {
        const report = await importer.delta();
        console.log(JSON.stringify(report));
        return report.failures ? 3 : 0;
      }
      case 'dry-run': {
        const report = await importer.dryRun(await scope(), { rehash: !flags.has('quick') });
        if (flags.has('json')) console.log(JSON.stringify(report, null, 2));
        for (const user of report.users) {
          const same = user.sourceHash === user.destHash;
          console.log(`${same ? 'same' : 'DIFF'} ${displayUser(user.user)}  rows=${user.rows} files=${user.files} (${human(user.bytes)})  1.0=${user.sourceHash.slice(0, 12)} 1.1=${user.destHash.slice(0, 12)}`);
          for (const table of user.tables) {
            console.log(`     ${table.table}: 1.0 ${table.sourceRows} rows, 1.1 ${table.destRows}; missing ${table.missing.length}, extra ${table.extra.length}, changed ${table.changed.length} ${[...table.missing, ...table.changed, ...table.extra].slice(0, 3).join(' ')}`);
          }
          for (const file of user.fileDiffs.slice(0, 10)) console.log(`     file ${file.problem}: ${file.path}`);
        }
        console.log(`dry run against ${report.snapshot} (J=${report.watermark}): ${report.users.length} scope(s), ${report.diffs} diff(s)`);
        return report.diffs ? 1 : 0;
      }
      case 'failures': {
        const failures = importer.failures();
        for (const failure of failures) console.log(`${displayUser(failure.userId)}  asset=${failure.assetId ?? '-'}  ${failure.path ?? ''}  ${failure.reason} (x${failure.attempts})`);
        console.log(`${failures.length} failure(s)`);
        return failures.length ? 3 : 0;
      }
      case 'backup-1.1': {
        console.log(JSON.stringify(await importer.backupDest()));
        return 0;
      }
      case 'status': {
        console.log(JSON.stringify(importer.state()));
        return 0;
      }
      default:
        console.error(`Unknown command ${command}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof SpaceError) {
      console.error(error.message);
      return 4;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    dest.close();
    await pools?.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
