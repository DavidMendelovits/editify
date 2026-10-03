import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
export const serverRoot = resolve(sourceDirectory, '..');
export const dataRoot = process.env.EDITIFY_DATA_DIR
  ? resolve(process.env.EDITIFY_DATA_DIR)
  : join(serverRoot, 'data');
export const assetsRoot = join(dataRoot, 'assets');
export const rendersRoot = join(dataRoot, 'renders');
export const mediaImportDir = process.env.MEDIA_IMPORT_DIR
  ? resolve(process.env.MEDIA_IMPORT_DIR)
  : resolve(serverRoot, '..', 'test-clips');
export const databasePath = process.env.DATABASE_PATH ?? join(dataRoot, 'editify.db');
export const port = Number(process.env.PORT ?? 3001);
export const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
export const supabaseUrl = process.env.SUPABASE_URL;
/**
 * Postgres for project sync and the cross-machine agent-turn lock (decision
 * 4A). Unset: the /sync routes answer 503 and the lock is per process. In
 * production, Supabase's session-mode pooler (port 5432), since the turn lock
 * is a session-level advisory lock. TLS (DATABASE_CA_CERT / _PATH) and pool
 * sizing (DATABASE_POOL_MAX, DATABASE_LOCK_POOL_MAX) are in db/postgres.ts.
 */
export const databaseUrl = process.env.DATABASE_URL || undefined;

/**
 * RENDER_PLAN=1 (or true/on) renders exports from the shared RenderPlan
 * (src/media/plan, plan P6) instead of legacy render.ts. Off by default;
 * read per render, so flipping it needs no restart of the queue. Legacy
 * stays as the rollback path until the flag defaults on.
 */
export function renderPlanEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test(process.env.RENDER_PLAN ?? '');
}
