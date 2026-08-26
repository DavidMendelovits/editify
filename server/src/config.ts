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
