import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  backupDatabase,
  insideRoot,
  manifest,
  measure,
  sha256File,
  type DuReport,
  type ManifestEntry,
} from './source-agent.mjs';

export type { DuReport, ManifestEntry };

export interface SnapshotInfo { name: string; size: number; sha256: string; journalId: number }

/**
 * Where 1.0's data comes from. On Fly that is the source agent on editify-dm,
 * reached over 6PN (HttpSource). Tests and local rehearsals read a directory
 * directly (LocalSource). Both hash on the 1.0 side, so a copy is checked
 * against the file as it sits on the source volume, not against the bytes
 * that arrived.
 */
export interface CutoverSource {
  readonly label: string;
  du(): Promise<DuReport>;
  /** Every media file with its size and sha256, as hashed on the source. */
  manifest(): Promise<ManifestEntry[]>;
  /** Writes the file's bytes to `destPath` (the caller verifies them). */
  download(rel: string, destPath: string): Promise<void>;
  /** A backup API copy of the 1.0 database, written to `destPath` and checked against the source's hash. */
  snapshot(destPath: string): Promise<SnapshotInfo>;
}

export class LocalSource implements CutoverSource {
  readonly label: string;
  constructor(private readonly root: string, private readonly dbPath: string, private readonly workDir: string) {
    this.label = `local ${root}`;
  }

  async du(): Promise<DuReport> {
    return await measure(this.root);
  }

  async manifest(): Promise<ManifestEntry[]> {
    return await manifest(this.root, { cachePath: join(this.workDir, 'source-hash-cache.json') });
  }

  async download(rel: string, destPath: string): Promise<void> {
    const full = insideRoot(this.root, rel);
    if (!full) throw new Error(`Not a source media path: ${rel}`);
    await pipeline(createReadStream(full), createWriteStream(destPath));
  }

  async snapshot(destPath: string): Promise<SnapshotInfo> {
    const result = await backupDatabase(this.dbPath, destPath);
    return { name: result.name, size: result.size, sha256: result.sha256, journalId: result.journalId };
  }
}

export class HttpSource implements CutoverSource {
  readonly label: string;
  constructor(private readonly baseUrl: string, private readonly token: string) {
    if (!token || token.length < 32) throw new Error('CUTOVER_TOKEN must be set (32+ characters) to talk to the source agent');
    this.label = `agent ${baseUrl}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Source agent ${init.method ?? 'GET'} ${path} answered ${response.status}: ${body.slice(0, 200)}`);
    }
    return response;
  }

  private async toFile(response: Response, destPath: string): Promise<void> {
    if (!response.body) throw new Error('The source agent sent no body');
    await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(destPath));
  }

  async du(): Promise<DuReport> {
    return await (await this.request('/du')).json() as DuReport;
  }

  async manifest(): Promise<ManifestEntry[]> {
    const text = await (await this.request('/manifest')).text();
    return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as ManifestEntry);
  }

  async download(rel: string, destPath: string): Promise<void> {
    await this.toFile(await this.request(`/file?path=${encodeURIComponent(rel)}`), destPath);
  }

  async snapshot(destPath: string): Promise<SnapshotInfo> {
    const info = await (await this.request('/snapshot', { method: 'POST' })).json() as SnapshotInfo;
    await mkdir(dirname(destPath), { recursive: true });
    const partial = `${destPath}.cutover-tmp`;
    await this.toFile(await this.request(`/snapshot/${encodeURIComponent(info.name)}`), partial);
    const [size, digest] = [(await stat(partial)).size, await sha256File(partial)];
    if (size !== info.size || digest !== info.sha256) {
      await rm(partial, { force: true });
      throw new Error(`The database snapshot arrived damaged (size ${size}/${info.size}, sha256 ${digest.slice(0, 12)}/${info.sha256.slice(0, 12)})`);
    }
    await rename(partial, destPath);
    return info;
  }
}
