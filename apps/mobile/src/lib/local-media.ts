/**
 * The local media registry and the media ladder (decision 3A + OV2/3, 10B + OV9).
 * A render plan names sources by `assetRef` only; this decides where each one comes
 * from on this phone. Pure logic: the SQLite database and the native engine are
 * passed in (`local-media-native.ts` wires the real ones), so every branch runs in vitest.
 *
 *   first Photos video import ─▶ askForPhotosAccessOnce (our reason, then the iOS prompt, once)
 *
 *   import ─▶ stageImport ─┬─ Photos pick, full access, original == picked file ─▶ PHAsset id only (D5)
 *                          ├─ anything else with a file (Files, share, capture, sticker,
 *                          │   limited/denied Photos, a clip edited in Photos) ─▶ copy into
 *                          │   Application Support/Editify/media BEFORE upload (PHAsset id kept)
 *                          └─ no file, or no room for a copy ─▶ server-only (with the reason)
 *          upload ok ─▶ commit(assetId): row + fingerprint of the uploaded file (+ proxy queued)
 *
 *   assetRef ─▶ resolveMedia ─┬─ app copy on disk ─────────────────────────▶ 'file'
 *                             ├─ PHAsset local, fingerprint matches ────────▶ 'local'
 *                             ├─ PHAsset local, fingerprint differs ────────▶ 'changed'
 *                             ├─ PHAsset in iCloud ─▶ 'icloud' ─▶ downloadMedia (progress, cancel)
 *                             └─ no row / server-only / evicted / deleted / limited / denied ─▶ 'server'
 *                                (preview: the server proxy; export: the server render path)
 *
 * Copies are a cache of media the server already has (rows exist only after an upload
 * landed): when an import commits, least recently used ones are evicted under a byte
 * budget, min(20 GB, 25% of free space plus the cache) unless set, skipping leased assets
 * (`leaseMedia`, held by an export or a preview); they are also released when their
 * project is deleted. A copy made for an upload that never committed (the app was killed
 * mid-upload) has no row; the launch sweep deletes such files after 24 hours.
 *
 * Analyzers and proxies only ever get a ref resolveMedia returned (`analyzeMedia`), never
 * a raw PHAsset id: a 'changed' original must not be analyzed in place of the uploaded clip.
 *
 * The app copy is checked first: it is the exact file that was uploaded, so nothing
 * can have changed under it. Paths are stored relative to the native media root
 * (`mediaRoot()`), because the app container's absolute path changes on every update.
 */
import type { PlanAssetRef } from '@editify/shared';

// ─── Types shared with the native engine (structural, so tests need no native module) ───

export type MediaColor = 'hlg' | 'pq' | 'log' | 'sdr';
export type PhotosAccess = 'all' | 'limited' | 'denied' | 'undetermined';

/**
 * Stored pixel size and the clockwise rotation (0, 90, 180, 270) that shows the picture
 * upright (`MediaGeometry` in MediaFingerprint.swift): the track's preferred transform for
 * video, EXIF orientation for stills. The server's asset records keep the coded size with
 * no rotation, so the render plan takes these instead.
 */
export interface MediaGeometry { width: number; height: number; rotation: number }

/** What the engine measures (`MediaFingerprint.swift`). `audio` is an envelope hash ("e1:…"). */
export interface MediaFingerprint {
  duration: number;
  bytes: number;
  audio: string | null;
  color: MediaColor | null;
  /** The video track's geometry; null without video, absent from older engines. */
  geometry?: MediaGeometry | null;
}

export type MediaProbe =
  | { status: 'ok'; fingerprint: MediaFingerprint }
  | { status: 'icloud' }
  | { status: 'unreachable'; error: string }
  | { status: 'missing'; access: PhotosAccess }
  | { status: 'failed'; error: string };

/** The native calls the registry needs; `local-media-native.ts` maps them to EditifyEngine and expo-file-system. */
export interface MediaNative {
  /** A PHAsset id or file:// URI, never downloading from iCloud (and never touching PhotoKit without access). */
  probe(ref: string): Promise<MediaProbe>;
  /** `probe` that downloads an iCloud original first; rejects once `cancelDownload(requestId)` lands. */
  download(ref: string, requestId: string, onProgress?: (fraction: number) => void): Promise<MediaProbe>;
  cancelDownload(requestId: string): void;
  photosAccess(): PhotosAccess;
  /** The iOS prompt when it was never shown; answers the access afterwards. */
  requestPhotosAccess(): Promise<PhotosAccess>;
  /** file:// URL of the media root, with a trailing slash. */
  mediaRoot(): string;
  /** Copies a file:// URI into the durable media folder; `path` is relative to `mediaRoot()`. */
  durableCopy(uri: string, name: string): Promise<{ path: string; uri: string; bytes: number }>;
  /** Bytes iOS would make available for an import (volumeAvailableCapacityForImportantUsage). */
  availableBytes(): number;
  /** Every file under media/, for the orphan sweep. `modified` is ms since 1970. */
  mediaFiles(): Array<{ path: string; bytes: number; modified: number }>;
  /** Deletes a file under the media root by its relative path. */
  removeMedia(path: string): void;
  fileExists(uri: string): boolean;
  /** Size of a file:// URI, 0 when unknown. */
  fileSize(uri: string): number;
  removeFile(uri: string): void;
  /**
   * Writes a PHAsset's original (`.original`, never downloading) to a new temporary file and
   * answers its file:// URI, for an upload the server is missing (OV1). The caller removes it.
   */
  exportOriginal(ref: string): Promise<{ uri: string; bytes: number }>;
  /** MediaGeometry of a PHAsset id or file:// URI (never downloading); null when unreadable or not a picture. */
  geometry(ref: string): Promise<MediaGeometry | null>;
  ensureProxy(assetId: string, ref: string): Promise<void>;
  touchProxy(assetId: string): boolean;
  removeProxy(assetId: string): void;
  /** Queues analyzer parts for a resolved ref (the scheduler's `analyze`). */
  analyze(assetId: string, ref: string, parts: string[] | null, options: Record<string, unknown> | null): Promise<void>;
}

// ─── SQLite ───

export type SqlValue = string | number | null;

/** The slice of expo-sqlite's SQLiteDatabase the registry uses. */
export interface SqlDb {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: SqlValue[]): Promise<unknown>;
  getFirstAsync<T>(source: string, ...params: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: SqlValue[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

/**
 * Schema versions, applied in order and tracked in `PRAGMA user_version`. Append only:
 * an applied step never runs again, so editing one does nothing on phones that have it.
 * `file_uri` and `proxy_uri` hold paths relative to the media root ("media/…", "proxies/…").
 */
export const LOCAL_MEDIA_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS local_media (
    asset_id TEXT PRIMARY KEY NOT NULL,
    ph_local_id TEXT,
    file_uri TEXT,
    proxy_uri TEXT,
    proxy_status TEXT,
    fingerprint TEXT,
    duration REAL,
    bytes INTEGER,
    color TEXT,
    server_only INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  // The copy cache (H1): size and last use of each copy, why a row is server-only, and
  // one-off flags (the Photos access question).
  `ALTER TABLE local_media ADD COLUMN file_bytes INTEGER;
   ALTER TABLE local_media ADD COLUMN last_used INTEGER;
   ALTER TABLE local_media ADD COLUMN server_reason TEXT;
   CREATE TABLE IF NOT EXISTS local_media_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT)`,
  // MediaGeometry ("width,height,rotation") for the render plan (T7): rotated phone clips and photos.
  'ALTER TABLE local_media ADD COLUMN geometry TEXT',
];

/** Brings the database to the newest schema; safe to call on every launch. Returns the version. */
export async function migrate(db: SqlDb, migrations: readonly string[] = LOCAL_MEDIA_MIGRATIONS): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < migrations.length) {
    const step = migrations[version] as string;
    const next = version + 1;
    await db.withTransactionAsync(async () => {
      await db.execAsync(step);
      await db.execAsync(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }
  return version;
}

export type ProxyStatus = 'pending' | 'ready' | 'failed' | 'unavailable' | 'evicted' | 'missing';

export interface LocalMediaRow {
  assetId: string;
  phLocalId: string | null;
  /** Relative to the media root. */
  fileUri: string | null;
  /** Size of the copy at `fileUri`. */
  fileBytes: number | null;
  /** Relative to the media root. */
  proxyUri: string | null;
  proxyStatus: ProxyStatus | null;
  /** The audio envelope hash of the uploaded file. */
  fingerprint: string | null;
  duration: number | null;
  bytes: number | null;
  color: MediaColor | null;
  geometry: MediaGeometry | null;
  serverOnly: boolean;
  serverReason: ServerReason | null;
  /** Last time resolve handed this source out (ms); drives copy eviction. */
  lastUsed: number | null;
  updatedAt: number;
}

/** What an import knows about a source; the proxy columns are left as they are. */
export interface LocalMediaRecord {
  assetId: string;
  phLocalId?: string | null;
  fileUri?: string | null;
  fileBytes?: number | null;
  fingerprint?: MediaFingerprint | null;
}

interface RawRow {
  asset_id: string;
  ph_local_id: string | null;
  file_uri: string | null;
  file_bytes: number | null;
  proxy_uri: string | null;
  proxy_status: string | null;
  fingerprint: string | null;
  duration: number | null;
  bytes: number | null;
  color: string | null;
  geometry: string | null;
  server_only: number;
  server_reason: string | null;
  last_used: number | null;
  updated_at: number;
}

export interface LocalMediaStore {
  lookup(assetId: string): Promise<LocalMediaRow | null>;
  /** Insert or replace what an import knows (the proxy columns survive). */
  record(entry: LocalMediaRecord): Promise<void>;
  /** No local source: preview from the server proxy, export on the server. */
  markServerOnly(assetId: string, reason?: ServerReason): Promise<void>;
  /** Trust-on-first-use for a row stored without one. */
  setFingerprint(assetId: string, fingerprint: MediaFingerprint): Promise<void>;
  /** Only touches an existing row. */
  setGeometry(assetId: string, geometry: MediaGeometry): Promise<void>;
  /** Only touches an existing row. */
  setProxy(assetId: string, status: ProxyStatus | null, proxyUri: string | null): Promise<void>;
  /** Resolve handed this source out now. */
  touch(assetId: string): Promise<void>;
  /** Rows that hold a copy, least recently used first. */
  copies(): Promise<LocalMediaRow[]>;
  /** The copy is gone: a row with no PHAsset id to fall back on becomes server-only. */
  dropCopy(assetId: string, reason: ServerReason): Promise<void>;
  forget(assetId: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;
}

export function createLocalMediaStore(db: SqlDb, now: () => number = Date.now): LocalMediaStore {
  return {
    async lookup(assetId) {
      const raw = await db.getFirstAsync<RawRow>('SELECT * FROM local_media WHERE asset_id = ?', assetId);
      return raw ? fromRaw(raw) : null;
    },
    async record(entry) {
      const fingerprint = entry.fingerprint ?? null;
      const at = now();
      await db.runAsync(
        `INSERT INTO local_media (asset_id, ph_local_id, file_uri, file_bytes, fingerprint, duration, bytes, color, geometry, server_only, server_reason, last_used, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           ph_local_id = excluded.ph_local_id, file_uri = excluded.file_uri, file_bytes = excluded.file_bytes,
           fingerprint = excluded.fingerprint, duration = excluded.duration, bytes = excluded.bytes, color = excluded.color,
           geometry = excluded.geometry, server_only = 0, server_reason = NULL, last_used = excluded.last_used, updated_at = excluded.updated_at`,
        entry.assetId, entry.phLocalId ?? null, entry.fileUri ?? null, entry.fileBytes ?? null,
        fingerprint?.audio ?? null, fingerprint?.duration ?? null, fingerprint?.bytes ?? null, fingerprint?.color ?? null,
        geometryText(fingerprint?.geometry), at, at,
      );
    },
    async markServerOnly(assetId, reason = 'server-only') {
      await db.runAsync(
        `INSERT INTO local_media (asset_id, server_only, server_reason, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET server_only = 1, server_reason = excluded.server_reason, updated_at = excluded.updated_at`,
        assetId, reason, now(),
      );
    },
    async setFingerprint(assetId, fingerprint) {
      await db.runAsync(
        'UPDATE local_media SET fingerprint = ?, duration = ?, bytes = ?, color = ?, updated_at = ? WHERE asset_id = ?',
        fingerprint.audio, fingerprint.duration, fingerprint.bytes, fingerprint.color, now(), assetId,
      );
    },
    async setGeometry(assetId, geometry) {
      await db.runAsync('UPDATE local_media SET geometry = ? WHERE asset_id = ?', geometryText(geometry), assetId);
    },
    async setProxy(assetId, status, proxyUri) {
      await db.runAsync(
        'UPDATE local_media SET proxy_status = ?, proxy_uri = ?, updated_at = ? WHERE asset_id = ?',
        status, proxyUri, now(), assetId,
      );
    },
    async touch(assetId) {
      await db.runAsync('UPDATE local_media SET last_used = ? WHERE asset_id = ?', now(), assetId);
    },
    async copies() {
      const raws = await db.getAllAsync<RawRow>(
        'SELECT * FROM local_media WHERE file_uri IS NOT NULL ORDER BY COALESCE(last_used, updated_at) ASC, asset_id ASC',
      );
      return raws.map(fromRaw);
    },
    async dropCopy(assetId, reason) {
      await db.runAsync(
        `UPDATE local_media SET file_uri = NULL, file_bytes = NULL,
           server_only = CASE WHEN ph_local_id IS NULL THEN 1 ELSE server_only END,
           server_reason = CASE WHEN ph_local_id IS NULL THEN ? ELSE server_reason END,
           updated_at = ? WHERE asset_id = ?`,
        reason, now(), assetId,
      );
    },
    async forget(assetId) {
      await db.runAsync('DELETE FROM local_media WHERE asset_id = ?', assetId);
    },
    async getMeta(key) {
      const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM local_media_meta WHERE key = ?', key);
      return row?.value ?? null;
    },
    async setMeta(key, value) {
      if (value === null) {
        await db.runAsync('DELETE FROM local_media_meta WHERE key = ?', key);
        return;
      }
      await db.runAsync(
        'INSERT INTO local_media_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key, value,
      );
    },
  };
}

function fromRaw(raw: RawRow): LocalMediaRow {
  return {
    assetId: raw.asset_id,
    phLocalId: raw.ph_local_id,
    fileUri: raw.file_uri,
    fileBytes: raw.file_bytes,
    proxyUri: raw.proxy_uri,
    proxyStatus: raw.proxy_status as ProxyStatus | null,
    fingerprint: raw.fingerprint,
    duration: raw.duration,
    bytes: raw.bytes,
    color: raw.color as MediaColor | null,
    geometry: parseGeometry(raw.geometry),
    serverOnly: raw.server_only === 1,
    serverReason: raw.server_reason as ServerReason | null,
    lastUsed: raw.last_used,
    updatedAt: raw.updated_at,
  };
}

function geometryText(geometry: MediaGeometry | null | undefined): string | null {
  return geometry ? `${geometry.width},${geometry.height},${geometry.rotation}` : null;
}

function parseGeometry(text: string | null): MediaGeometry | null {
  if (!text) return null;
  const [width, height, rotation] = text.split(',').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(rotation)) return null;
  return { width: width!, height: height!, rotation: rotation! };
}

/** A valid geometry from the engine, or null (a missing key, an older engine, garbage). */
export function asGeometry(value: unknown): MediaGeometry | null {
  if (!value || typeof value !== 'object') return null;
  const { width, height, rotation } = value as Record<string, unknown>;
  if (typeof width !== 'number' || typeof height !== 'number' || typeof rotation !== 'number') return null;
  if (!(width > 0) || !(height > 0) || ![0, 90, 180, 270].includes(rotation)) return null;
  return { width, height, rotation };
}

/**
 * The geometry of a locally resolved source: the registry's, else a fresh probe's, else the
 * engine reads it now and the registry keeps it. null when the engine can't tell.
 */
export async function mediaGeometry(media: Extract<ResolvedMedia, { state: 'local' | 'file' }>, deps: MediaDeps): Promise<MediaGeometry | null> {
  const row = await deps.store.lookup(media.assetId);
  if (row?.geometry) return row.geometry;
  const probed = media.state === 'local' ? asGeometry(media.fingerprint.geometry) : null;
  const geometry = probed ?? asGeometry(await deps.native.geometry(media.ref).catch(() => null));
  if (geometry && row) await deps.store.setGeometry(media.assetId, geometry);
  return geometry;
}

// ─── Fingerprints (OV2) ───

/** A remux or a re-encode can move the duration by a frame or two; a trim moves it by far more. */
export const FINGERPRINT_DURATION_TOLERANCE = 0.1;
/** Same audio decodes to the same hash (a re-encode flips ~1%); a front trim scrambles about half. */
export const FINGERPRINT_MAX_BIT_DIFFERENCE = 0.1;

/**
 * Share of differing bits between two envelope hashes over their common prefix (the
 * duration check catches a length difference), or null when they can't be compared.
 */
export function envelopeDistance(a: string, b: string): number | null {
  const [tagA, hexA = ''] = a.split(':');
  const [tagB, hexB = ''] = b.split(':');
  if (!tagA || tagA !== tagB) return null;
  const length = Math.min(hexA.length, hexB.length);
  if (length === 0) return 0;
  let differing = 0;
  for (let index = 0; index < length; index += 1) {
    let bits = (Number.parseInt(hexA[index] as string, 16) || 0) ^ (Number.parseInt(hexB[index] as string, 16) || 0);
    while (bits) { differing += bits & 1; bits >>= 1; }
  }
  return differing / (length * 4);
}

type ExpectedFingerprint = Pick<LocalMediaRow, 'fingerprint' | 'duration' | 'bytes'>;

function expectedOf(fingerprint: MediaFingerprint): ExpectedFingerprint {
  return { fingerprint: fingerprint.audio, duration: fingerprint.duration, bytes: fingerprint.bytes };
}

/**
 * Is `actual` (the source as it is now) still the file the project was cut against?
 * Duration within a frame or two, and then either the same byte size or audio whose
 * envelope agrees. Bytes alone can't decide a mismatch: the picker may hand over a
 * re-wrapped copy of the very same original.
 */
export function fingerprintsMatch(expected: ExpectedFingerprint, actual: MediaFingerprint): boolean {
  if (expected.duration !== null && Math.abs(expected.duration - actual.duration) > FINGERPRINT_DURATION_TOLERANCE) return false;
  if (expected.bytes && actual.bytes && expected.bytes === actual.bytes) return true;
  if (expected.fingerprint === null || actual.audio === null) return expected.fingerprint === actual.audio;
  const distance = envelopeDistance(expected.fingerprint, actual.audio);
  // A hash from another algorithm version can't be compared: the duration is all there is.
  return distance === null || distance <= FINGERPRINT_MAX_BIT_DIFFERENCE;
}

// ─── The ladder ───

export type ServerReason =
  | 'no-row'        // imported before the registry existed (an old project) or on another device
  | 'server-only'   // nothing was kept on this phone at import
  | 'no-space'      // the phone was too full to keep a copy at import
  | 'evicted'       // the copy was evicted to stay within the copy budget
  | 'deleted'       // the PHAsset is gone, with full library access
  | 'limited'       // outside a Limited Library selection
  | 'denied'        // no Photos access at all
  | 'file-missing'  // the app copy was removed (only when there is no PHAsset to fall back on)
  | 'unreadable';   // the source is there but couldn't be opened

interface ResolvedBase { assetId: string; kind: PlanAssetRef['kind'] }

export type ResolvedMedia =
  /** The PHAsset original, still the uploaded clip. `ref` is the PHAsset id. */
  | (ResolvedBase & { state: 'local'; ref: string; fingerprint: MediaFingerprint; proxyUri?: string })
  /** The app's own copy (Files, share, capture, sticker, limited-access Photos). `ref` is its file:// URI. */
  | (ResolvedBase & { state: 'file'; ref: string; proxyUri?: string })
  /** The PHAsset differs from what was uploaded: the user picks "use it anyway / re-link / server copy". */
  | (ResolvedBase & { state: 'changed'; ref: string; expected: ExpectedFingerprint; actual: MediaFingerprint })
  /** Offloaded to iCloud: `downloadMedia` fetches it. `unreachable` is the last download's error (offline). */
  | (ResolvedBase & { state: 'icloud'; ref: string; unreachable?: string })
  /** No usable local source: preview from the server proxy, export through the server. */
  | (ResolvedBase & { state: 'server'; reason: ServerReason });

export interface MediaDeps { store: LocalMediaStore; native: MediaNative; now?: () => number }

export interface ResolveOptions {
  /** 'preview' (default) attaches the 1080p proxy when it is on disk and queues it when not. */
  purpose?: 'preview' | 'export';
}

/** file:// URI for a path stored relative to the media root. */
export function absoluteUri(native: Pick<MediaNative, 'mediaRoot'>, relative: string): string {
  const root = native.mediaRoot();
  return `${root.endsWith('/') ? root : `${root}/`}${relative}`;
}

export async function resolveMedia(ref: PlanAssetRef, deps: MediaDeps, options: ResolveOptions = {}): Promise<ResolvedMedia> {
  const base: ResolvedBase = { assetId: ref.id, kind: ref.kind };
  const row = await deps.store.lookup(ref.id);
  if (!row) return { ...base, state: 'server', reason: 'no-row' };
  if (row.serverOnly) return { ...base, state: 'server', reason: row.serverReason ?? 'server-only' };

  let reason: ServerReason = row.serverReason ?? 'server-only';
  if (row.fileUri) {
    const uri = absoluteUri(deps.native, row.fileUri);
    if (deps.native.fileExists(uri)) {
      await deps.store.touch(ref.id);
      return await withProxy({ ...base, state: 'file', ref: uri }, row, deps, options);
    }
    reason = 'file-missing';
  }
  if (row.phLocalId) {
    const outcome = await fromProbe(base, row, row.phLocalId, await deps.native.probe(row.phLocalId), deps);
    if (outcome.state !== 'local') return outcome;
    await deps.store.touch(ref.id);
    return await withProxy(outcome, row, deps, options);
  }
  return { ...base, state: 'server', reason };
}

/**
 * The only way analyzers get a source (M1): resolved first, and queued only for an app
 * copy or a Photos original that still matches the upload. Anything else (changed,
 * iCloud, server) is returned untouched for the caller to deal with.
 */
export async function analyzeMedia(
  ref: PlanAssetRef,
  deps: MediaDeps,
  parts: string[] | null = null,
  options: Record<string, unknown> | null = null,
): Promise<ResolvedMedia> {
  const media = await resolveMedia(ref, deps, { purpose: 'export' });
  if (media.state === 'local' || media.state === 'file') await deps.native.analyze(ref.id, media.ref, parts, options);
  return media;
}

let downloadCount = 0;

/**
 * Fetches an iCloud original, then checks it like `resolveMedia` would. Aborting `signal`
 * cancels the Photos request and answers the same 'icloud' state (nothing changed);
 * a failed download (offline) answers 'icloud' with `unreachable` set, for "Waiting for iCloud".
 */
export async function downloadMedia(
  media: Extract<ResolvedMedia, { state: 'icloud' }>,
  deps: MediaDeps,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<ResolvedMedia> {
  const row = await deps.store.lookup(media.assetId);
  if (!row) return { assetId: media.assetId, kind: media.kind, state: 'server', reason: 'no-row' };
  const { assetId, kind } = media;
  if (options.signal?.aborted) return { assetId, kind, state: 'icloud', ref: media.ref };
  downloadCount += 1;
  const requestId = `download-${assetId}-${downloadCount}`;
  const abort = (): void => deps.native.cancelDownload(requestId);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const probe = await deps.native.download(media.ref, requestId, options.onProgress);
    return await fromProbe({ assetId, kind }, row, media.ref, probe, deps);
  } catch (error) {
    if (options.signal?.aborted) return { assetId, kind, state: 'icloud', ref: media.ref };
    return { assetId, kind, state: 'icloud', ref: media.ref, unreachable: error instanceof Error ? error.message : String(error) };
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

async function fromProbe(base: ResolvedBase, row: LocalMediaRow, ref: string, probe: MediaProbe, deps: MediaDeps): Promise<ResolvedMedia> {
  switch (probe.status) {
    case 'ok': {
      if (row.fingerprint === null && row.duration === null) {
        // Stored without one (the import couldn't read it): this first look becomes the reference.
        await deps.store.setFingerprint(row.assetId, probe.fingerprint);
        return { ...base, state: 'local', ref, fingerprint: probe.fingerprint };
      }
      if (fingerprintsMatch(row, probe.fingerprint)) return { ...base, state: 'local', ref, fingerprint: probe.fingerprint };
      return { ...base, state: 'changed', ref, expected: { fingerprint: row.fingerprint, duration: row.duration, bytes: row.bytes }, actual: probe.fingerprint };
    }
    case 'icloud':
      return { ...base, state: 'icloud', ref };
    case 'unreachable':
      return { ...base, state: 'icloud', ref, unreachable: probe.error };
    case 'missing':
      return { ...base, state: 'server', reason: probe.access === 'all' ? 'deleted' : probe.access === 'limited' ? 'limited' : 'denied' };
    case 'failed':
      return { ...base, state: 'server', reason: 'unreadable' };
  }
}

/** The preview proxy when it is on disk; otherwise (re)queued: every local video gets one (10B). */
async function withProxy<T extends Extract<ResolvedMedia, { state: 'local' | 'file' }>>(media: T, row: LocalMediaRow, deps: MediaDeps, options: ResolveOptions): Promise<T> {
  if (options.purpose === 'export' || media.kind !== 'video') return media;
  if (row.proxyStatus === 'ready' && row.proxyUri) {
    const uri = absoluteUri(deps.native, row.proxyUri);
    if (deps.native.fileExists(uri)) {
      deps.native.touchProxy(media.assetId);
      return { ...media, proxyUri: uri };
    }
    await deps.store.setProxy(media.assetId, 'missing', null);
  }
  // Fire and forget, and idempotent (the scheduler skips a part already queued or running):
  // the preview plays the original until the proxy's ready event lands. A 'pending' left by
  // a killed process is re-queued here too.
  deps.native.ensureProxy(media.assetId, media.ref).catch(() => undefined);
  return media;
}

// ─── Photos access (asked once) ───

export const PHOTOS_ASKED_KEY = 'photos_access_asked';

/**
 * Before the first Photos video import: with access never asked for, show our reason
 * (`explain` resolves true to go on), then the iOS prompt. Asked at most once: the flag
 * is stored before asking, so "Not now", a decline or a kill mid-prompt all stay asked.
 * Independent of the picker, which needs no permission and keeps working either way.
 */
export async function askForPhotosAccessOnce(deps: MediaDeps, explain: () => Promise<boolean>): Promise<PhotosAccess> {
  const access = deps.native.photosAccess();
  if (access !== 'undetermined') return access;
  if (await deps.store.getMeta(PHOTOS_ASKED_KEY)) return access;
  await deps.store.setMeta(PHOTOS_ASKED_KEY, String((deps.now ?? Date.now)()));
  if (!(await explain())) return access;
  return await deps.native.requestPhotosAccess();
}

// ─── The copy cache (H1) ───

const GB = 1024 ** 3;
export const COPY_BUDGET_CAP = 20 * GB;
export const COPY_BUDGET_SHARE = 0.25;
/** Left free after a copy, so an import never takes the phone's last gigabyte. */
export const COPY_FREE_RESERVE = GB;
/** A media/ file with no row this old is a copy whose upload never committed. */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
export const COPY_BUDGET_KEY = 'copy_budget_bytes';

/**
 * What this process knows beyond the database: copies made for uploads still in flight
 * (they take space and must never be evicted or swept) and leases on assets an export or
 * a preview is using. Per process and in memory: a relaunch starts with neither, which is
 * right, since no upload or render survives it.
 */
interface Runtime {
  inFlight: Map<number, { path: string; bytes: number }>;
  leases: Map<string, number>;
  next: number;
}

const runtimes = new WeakMap<LocalMediaStore, Runtime>();

function runtime(deps: MediaDeps): Runtime {
  let state = runtimes.get(deps.store);
  if (!state) {
    state = { inFlight: new Map(), leases: new Map(), next: 0 };
    runtimes.set(deps.store, state);
  }
  return state;
}

function inFlightBytes(state: Runtime): number {
  let total = 0;
  for (const copy of state.inFlight.values()) total += copy.bytes;
  return total;
}

export interface MediaLease {
  /** Idempotent. */
  release(): void;
}

/**
 * Pins assets while an export or a preview uses their local sources: eviction and
 * `forgetMedia` skip them until every lease on them is released. Reference counted,
 * per process (see Runtime).
 */
export function leaseMedia(deps: MediaDeps, assetIds: Iterable<string>): MediaLease {
  const state = runtime(deps);
  const ids = [...new Set(assetIds)];
  for (const id of ids) state.leases.set(id, (state.leases.get(id) ?? 0) + 1);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      for (const id of ids) {
        const count = (state.leases.get(id) ?? 0) - 1;
        if (count > 0) state.leases.set(id, count);
        else state.leases.delete(id);
      }
    },
  };
}

export function isLeased(deps: MediaDeps, assetId: string): boolean {
  return (runtime(deps).leases.get(assetId) ?? 0) > 0;
}

/** Bytes held by copies: committed rows plus uploads in flight. */
async function cacheBytes(deps: MediaDeps): Promise<{ committed: number; inFlight: number; copies: LocalMediaRow[] }> {
  const copies = await deps.store.copies();
  return { committed: copies.reduce((sum, row) => sum + (row.fileBytes ?? 0), 0), inFlight: inFlightBytes(runtime(deps)), copies };
}

/**
 * The copy budget: what was set, or min(20 GB, 25% of what the cache could have),
 * free space plus what the cache already holds (so a full cache doesn't shrink its own budget).
 */
export async function copyBudget(deps: MediaDeps): Promise<number> {
  const configured = Number(await deps.store.getMeta(COPY_BUDGET_KEY));
  if (Number.isFinite(configured) && configured > 0) return configured;
  const { committed, inFlight } = await cacheBytes(deps);
  return Math.min(COPY_BUDGET_CAP, (Math.max(0, deps.native.availableBytes()) + committed + inFlight) * COPY_BUDGET_SHARE);
}

/** A fixed copy budget in bytes, or null for the default. */
export async function setCopyBudget(deps: MediaDeps, bytes: number | null): Promise<void> {
  const valid = bytes !== null && Number.isFinite(bytes) && bytes > 0;
  await deps.store.setMeta(COPY_BUDGET_KEY, valid ? String(Math.round(bytes)) : null);
}

/**
 * Evicts least recently used copies until committed plus in-flight copies fit the
 * budget, and, with `minFree`, until that much space is free. In-flight copies count
 * but are never evicted; neither is `protect` (the copy just committed) nor a leased
 * asset. Runs when an import commits (and at launch only when space is short), never
 * while staging: a failed upload evicts nothing. Returns the evicted asset ids.
 */
export async function enforceCopyBudget(deps: MediaDeps, options: { protect?: string; minFree?: number } = {}): Promise<string[]> {
  const budget = await copyBudget(deps);
  const { committed, inFlight, copies } = await cacheBytes(deps);
  let total = committed + inFlight;
  let target = budget;
  if (options.minFree !== undefined) {
    const shortfall = options.minFree - deps.native.availableBytes();
    if (shortfall > 0) target = Math.min(target, total - shortfall);
  }
  const evicted: string[] = [];
  for (const row of copies) {
    if (total <= target) break;
    if (row.assetId === options.protect || !row.fileUri || isLeased(deps, row.assetId)) continue;
    deps.native.removeMedia(row.fileUri);
    await deps.store.dropCopy(row.assetId, 'evicted');
    total -= row.fileBytes ?? 0;
    evicted.push(row.assetId);
  }
  return evicted;
}

/** Deletes media/ files no row (and no upload in flight) points at once they are a day old. */
export async function sweepOrphanCopies(deps: MediaDeps): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const referenced = new Set<string | null>((await deps.store.copies()).map((row) => row.fileUri));
  for (const copy of runtime(deps).inFlight.values()) referenced.add(copy.path);
  const removed: string[] = [];
  for (const file of deps.native.mediaFiles()) {
    if (referenced.has(file.path) || now - file.modified < ORPHAN_AGE_MS) continue;
    deps.native.removeMedia(file.path);
    removed.push(file.path);
  }
  return removed;
}

/**
 * Launch housekeeping, awaited before the registry is handed out: the orphan sweep, and
 * eviction only when the phone is below the free-space reserve (a launch never shrinks a
 * healthy cache just because free space moved).
 */
export async function maintainMedia(deps: MediaDeps): Promise<void> {
  await sweepOrphanCopies(deps);
  if (deps.native.availableBytes() < COPY_FREE_RESERVE) await enforceCopyBudget(deps, { minFree: COPY_FREE_RESERVE });
}

/** Drops everything the phone keeps for these assets (copy, proxy, row), except leased ones. Returns the ids dropped. */
export async function forgetMedia(deps: MediaDeps, assetIds: Iterable<string>): Promise<string[]> {
  const forgotten: string[] = [];
  for (const assetId of assetIds) {
    if (isLeased(deps, assetId)) continue;
    const row = await deps.store.lookup(assetId);
    if (!row) continue;
    if (row.fileUri) deps.native.removeMedia(row.fileUri);
    deps.native.removeProxy(assetId);
    await deps.store.forget(assetId);
    forgotten.push(assetId);
  }
  return forgotten;
}

/**
 * After a project is deleted: forgets its assets that no remaining project uses (shared
 * media stays). `stillUsed` is every asset id linked to a project that still exists.
 */
export async function releaseProjectMedia(deps: MediaDeps, projectAssetIds: Iterable<string>, stillUsed: ReadonlySet<string>): Promise<string[]> {
  return await forgetMedia(deps, [...projectAssetIds].filter((id) => !stillUsed.has(id)));
}

// ─── Import hooks ───

export type ImportOrigin = 'photos' | 'files' | 'share' | 'capture';

export interface ImportCandidate {
  /** The picked/shared/recorded file; empty or a blob: URL when there is none on disk. */
  uri: string;
  name: string;
  kind: PlanAssetRef['kind'];
  origin: ImportOrigin;
  /** ImagePicker's `assetId` (a PHAsset localIdentifier), when it gave one. */
  phLocalId?: string | null;
  /** The picker's size, when it reported one. */
  size?: number;
}

export interface StagedImport {
  /** What to upload: the copy when one was made, so a later edit to the picked file can't diverge. */
  uploadUri: string;
  /** The device keeps its own copy (a share-extension copy is then redundant). */
  durable: boolean;
  /** After a successful upload: writes the row (and queues the preview proxy for video). */
  commit(assetId: string): Promise<void>;
  /** After a failed upload: removes the copy made for it. */
  abort(): void;
}

/**
 * Prepares one import before its upload.
 * - A Photos video with full library access whose original (`.original`) matches the
 *   picked file is referenced by PHAsset id, never copied (D5).
 * - Anything else with a file is copied into the media folder first: Files, share,
 *   capture, stickers, Photos without full access, and a clip already edited in Photos
 *   (the picker uploads the rendered edit, the original differs). A PHAsset id is kept
 *   next to the copy.
 * - No file, or not enough room for a copy, leaves the asset server-only (with the reason).
 * The row is written in `commit`, after the upload; a copy whose upload never commits
 * (the app was killed) is left to `sweepOrphanCopies`. The copy's modification time is
 * set at copy time, so the sweep's 24-hour clock starts then.
 */
export async function stageImport(candidate: ImportCandidate, deps: MediaDeps): Promise<StagedImport> {
  const { native, store } = deps;
  const onDisk = candidate.uri.startsWith('file://');
  const phLocalId = candidate.phLocalId ?? null;
  const serverOnly = (reason: ServerReason): StagedImport => ({
    uploadUri: candidate.uri,
    durable: false,
    commit: async (assetId) => { await store.markServerOnly(assetId, reason); },
    abort: () => undefined,
  });

  let uploaded: MediaFingerprint | null | undefined;
  if (candidate.kind === 'video' && candidate.origin === 'photos' && phLocalId && native.photosAccess() === 'all') {
    uploaded = onDisk ? await fingerprintOf(native, candidate.uri) : null;
    const original = await native.probe(phLocalId).catch(() => null);
    if (uploaded && original?.status === 'ok' && fingerprintsMatch(expectedOf(uploaded), original.fingerprint)) {
      const fingerprint = uploaded;
      return {
        uploadUri: candidate.uri,
        durable: false,
        commit: async (assetId) => {
          await store.record({ assetId, phLocalId, fingerprint });
          native.ensureProxy(assetId, phLocalId).catch(() => undefined);
        },
        abort: () => undefined,
      };
    }
    // Edited in Photos, in iCloud, or unreadable: keep a copy of what is uploaded.
  }
  if (!onDisk) return serverOnly('server-only');

  const size = candidate.size || native.fileSize(candidate.uri);
  if (native.availableBytes() < size + COPY_FREE_RESERVE || size > await copyBudget(deps)) return serverOnly('no-space');

  let copy: { path: string; uri: string; bytes: number };
  try {
    copy = await native.durableCopy(candidate.uri, candidate.name);
  } catch {
    return serverOnly('no-space'); // the copy failed (disk full): the upload still goes ahead from the picked file
  }
  // In flight until commit or abort: counted against the budget, never evicted or swept.
  const state = runtime(deps);
  const token = (state.next += 1);
  state.inFlight.set(token, { path: copy.path, bytes: copy.bytes || size });
  return {
    uploadUri: copy.uri,
    durable: true,
    commit: async (assetId) => {
      try {
        const fingerprint = candidate.kind === 'image' ? null : uploaded ?? await fingerprintOf(native, copy.uri);
        await store.record({ assetId, phLocalId, fileUri: copy.path, fileBytes: copy.bytes || size, fingerprint });
      } finally {
        state.inFlight.delete(token);
      }
      // Evicting happens here only: the upload landed, so whatever goes is on the server.
      await enforceCopyBudget(deps, { protect: assetId });
      if (candidate.kind === 'video') native.ensureProxy(assetId, copy.uri).catch(() => undefined);
    },
    abort: () => {
      state.inFlight.delete(token);
      try { native.removeFile(copy.uri); } catch { /* already gone */ }
    },
  };
}

/** The uploaded file's fingerprint, or null (the row then takes the first one resolve sees). */
async function fingerprintOf(native: MediaNative, uri: string): Promise<MediaFingerprint | null> {
  try {
    const probe = await native.probe(uri);
    return probe.status === 'ok' ? probe.fingerprint : null;
  } catch {
    return null;
  }
}

/** Timeline kind from a MIME type, falling back to the extension. */
export function mediaKindOf(mimeType: string | undefined | null, name: string): PlanAssetRef['kind'] {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.startsWith('video/')) return 'video';
  if (/\.(png|jpe?g|gif|webp|heic|heif)$/i.test(name)) return 'image';
  if (/\.(m4a|mp3|wav|aac|caf|aiff?|flac|ogg)$/i.test(name)) return 'audio';
  return 'video';
}

// ─── Proxy events ───

/** The `analysisStatus` events the registry cares about (part 'proxy'). */
export type ProxyStatusEvent =
  | { assetId: string; part: string; status: string; removed?: undefined }
  | { assetId: string; part: string; removed: true };

/**
 * Mirrors the native proxy part into the registry: ready (with its path, read from the
 * analysis snapshot because events carry no data), pending/failed/unavailable, and
 * removed (evicted over the byte budget, or dropped by a cancel) as 'evicted'.
 */
export async function applyProxyEvent(
  store: LocalMediaStore,
  event: ProxyStatusEvent,
  readProxyPath: (assetId: string) => Promise<string | undefined>,
): Promise<void> {
  if (event.part !== 'proxy') return;
  if (event.removed) return await store.setProxy(event.assetId, 'evicted', null);
  if (event.status === 'ready') {
    const path = await readProxyPath(event.assetId);
    return await store.setProxy(event.assetId, path ? 'ready' : 'missing', path ?? null);
  }
  if (event.status === 'pending' || event.status === 'failed' || event.status === 'unavailable') {
    await store.setProxy(event.assetId, event.status, null);
  }
}
