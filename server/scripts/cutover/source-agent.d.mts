/** Types for source-agent.mjs, which stays plain JS so it can run on a 1.0 machine as uploaded. */
export interface AgentFile { path: string; size: number; mtimeMs: number }
export interface ManifestEntry extends AgentFile { sha256: string }
export interface DuEntry { name: string; bytes: number; files: number }
export interface DuReport { root: string; entries: DuEntry[]; total: { bytes: number; files: number } }
export interface BackupResult { name: string; path: string; size: number; sha256: string; journalId: number }

export const EXCLUDED_TOP_LEVEL: Set<string>;
export function insideRoot(root: string, rel: string | null): string | undefined;
export function walk(root: string): Promise<AgentFile[]>;
export function sha256File(path: string): Promise<string>;
export function measure(root: string): Promise<DuReport>;
export function manifest(root: string, options?: { cachePath?: string; onEntry?: (entry: ManifestEntry) => unknown }): Promise<ManifestEntry[]>;
export function backupDatabase(dbPath: string, outPath: string): Promise<BackupResult>;
export function serve(options: {
  root: string; dbPath: string; host: string; port: number; token: string; workDir: string;
}): Promise<{ port: number; close: () => Promise<void> }>;
export function journalStatus(dbPath: string): Promise<{ journal: boolean; triggers: number; journalId: number; dbBytes: number; walBytes: number }>;
