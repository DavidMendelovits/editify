import { open, mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { EditifyDatabase } from '../../src/db/database.js';
import { sha256File } from './source-agent.mjs';
import type { CutoverSource, ManifestEntry } from './source.js';
import { PATH_COLUMNS, SHARED, type Row } from './tables.js';

/** What a media file is there for: the asset or render it belongs to, or the shared tree (sounds, emoji, luts...). */
export interface MediaFile { path: string; owner: { kind: 'asset' | 'render' | 'shared'; id: string | null } }

export interface FilePlan {
  files: MediaFile[];
  /** Paths the rows name that are not on the source volume: nothing to copy, reported only. */
  missing: string[];
  /** Absolute paths outside the source root: not media the cutover can move, reported only. */
  external: string[];
}

export type ManifestIndex = Map<string, ManifestEntry>;

export function indexManifest(entries: ManifestEntry[]): ManifestIndex {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

/** Manifest entries grouped by their `assets/<id>` / `renders/<id>` directory. */
export function groupByOwnerDir(entries: ManifestEntry[]): Map<string, ManifestEntry[]> {
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    if ((parts[0] === 'assets' || parts[0] === 'renders') && parts.length >= 3) {
      const key = `${parts[0]}/${parts[1]}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
  }
  return groups;
}

/** The volume-relative path of an absolute 1.0 path, or undefined when it lies outside the root. */
export function relativeToRoot(root: string, path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * Every file one scope's rows need: each asset's and render's whole directory
 * (original, proxy, thumbnail, filmstrip; output, captions, contact sheet) plus
 * any recorded path outside those directories. The shared scope also takes the
 * volume's other trees (sounds, emoji, callouts, luts, models...).
 */
export function planFiles(rows: Map<string, Row[]>, user: string, index: ManifestIndex, groups: Map<string, ManifestEntry[]>, sourceRoot: string): FilePlan {
  const files = new Map<string, MediaFile>();
  const missing = new Set<string>();
  const external = new Set<string>();
  const add = (path: string, owner: MediaFile['owner']): void => {
    if (!files.has(path)) files.set(path, { path, owner });
  };
  for (const [table, dir, kind] of [['assets', 'assets', 'asset'], ['renders', 'renders', 'render']] as const) {
    for (const row of rows.get(table) ?? []) {
      const id = String(row.id);
      const owner = { kind, id };
      for (const entry of groups.get(`${dir}/${id}`) ?? []) add(entry.path, owner);
      for (const column of PATH_COLUMNS[table] ?? []) {
        const value = row[column];
        if (typeof value !== 'string' || !value) continue;
        const rel = relativeToRoot(sourceRoot, value);
        if (!rel) external.add(value);
        else if (index.has(rel)) add(rel, owner);
        else missing.add(rel);
      }
    }
  }
  if (user === SHARED) {
    for (const entry of index.values()) {
      const top = entry.path.split('/')[0];
      if (top !== 'assets' && top !== 'renders') add(entry.path, { kind: 'shared', id: null });
    }
  }
  return { files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), missing: [...missing].sort(), external: [...external].sort() };
}

/** Manifest files under assets/ or renders/ that no row names: left behind, and reported. */
export function orphanFiles(index: ManifestIndex, claimed: Set<string>): string[] {
  return [...index.keys()].filter((path) => {
    const top = path.split('/')[0];
    return (top === 'assets' || top === 'renders') && !claimed.has(path);
  }).sort();
}

export interface CopyContext {
  database: EditifyDatabase;
  source: CutoverSource;
  index: ManifestIndex;
  destRoot: string;
  concurrency?: number;
  log?: (line: string) => void;
}

/** True when the file was copied and verified before and is still exactly that on the 1.1 volume. */
export async function isVerified(context: Pick<CopyContext, 'database' | 'destRoot'>, entry: ManifestEntry): Promise<boolean> {
  const row = context.database.prepare('SELECT size, sha256, dest_mtime_ms FROM import_files WHERE path = ?').get(entry.path) as
    { size: number; sha256: string; dest_mtime_ms: number } | undefined;
  if (!row || row.size !== entry.size || row.sha256 !== entry.sha256) return false;
  const info = await stat(join(context.destRoot, entry.path)).catch(() => undefined);
  return Boolean(info?.isFile() && info.size === row.size && Math.trunc(info.mtimeMs) === row.dest_mtime_ms);
}

export interface CopyFailure { file: MediaFile; reason: string }
export interface CopyResult { copied: number; skipped: number; bytes: number; failures: CopyFailure[] }

async function copyOne(context: CopyContext, file: MediaFile, entry: ManifestEntry): Promise<number> {
  const dest = join(context.destRoot, file.path);
  const partial = `${dest}.cutover-tmp`;
  await mkdir(dirname(dest), { recursive: true });
  try {
    await context.source.download(file.path, partial);
    const handle = await open(partial, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    // Read back from disk: the check is the file as 1.1 will serve it.
    const size = (await stat(partial)).size;
    if (size !== entry.size) throw new Error(`size ${size} != source ${entry.size}`);
    const digest = await sha256File(partial);
    if (digest !== entry.sha256) throw new Error(`sha256 ${digest.slice(0, 16)}... != source ${entry.sha256.slice(0, 16)}...`);
    await rename(partial, dest);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const info = await stat(dest);
  context.database.prepare(`
    INSERT INTO import_files (path, size, sha256, dest_mtime_ms, verified_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, sha256 = excluded.sha256, dest_mtime_ms = excluded.dest_mtime_ms, verified_at = excluded.verified_at
  `).run(file.path, entry.size, entry.sha256, Math.trunc(info.mtimeMs), new Date().toISOString());
  return entry.size;
}

/**
 * Copies and verifies (size + sha256 against the 1.0 hash) every file not
 * already verified. A failed file is reported, never left half-written.
 */
export async function copyFiles(context: CopyContext, files: MediaFile[]): Promise<CopyResult> {
  const result: CopyResult = { copied: 0, skipped: 0, bytes: 0, failures: [] };
  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const entry = context.index.get(file.path);
      if (!entry) {
        result.failures.push({ file, reason: 'not on the source volume' });
        continue;
      }
      if (await isVerified(context, entry)) {
        result.skipped += 1;
        continue;
      }
      try {
        result.bytes += await copyOne(context, file, entry);
        result.copied += 1;
      } catch (error) {
        result.failures.push({ file, reason: `copy failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, context.concurrency ?? 4) }, worker));
  return result;
}

/** Bytes still to copy: files in the plan that are not verified on 1.1 yet. */
export async function remainingBytes(context: Pick<CopyContext, 'database' | 'destRoot' | 'index'>, files: MediaFile[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    const entry = context.index.get(file.path);
    if (entry && !(await isVerified(context, entry))) total += entry.size;
  }
  return total;
}

export async function freeBytesOf(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

export class SpaceError extends Error {
  constructor(public readonly free: number, public readonly needed: number) {
    super(`Not enough space on the 1.1 volume: ${free} bytes free, the copy needs ${needed} more (1.2x headroom, plan C11). Extend editify_v11_data first.`);
    this.name = 'SpaceError';
  }
}

/** C11: abort before copying anything when free space is under 1.2x what is left to copy. */
export function assertSpace(free: number, remaining: number, factor = 1.2): void {
  if (free < remaining * factor) throw new SpaceError(free, Math.ceil(remaining * factor));
}

/** Whether a user's own files (not dependencies) are all verified on 1.1 right now. */
export async function unverifiedFiles(context: Pick<CopyContext, 'database' | 'destRoot' | 'index'>, files: MediaFile[]): Promise<MediaFile[]> {
  const bad: MediaFile[] = [];
  for (const file of files) {
    const entry = context.index.get(file.path);
    if (!entry || !(await isVerified(context, entry))) bad.push(file);
  }
  return bad;
}

