/**
 * The local media registry and the media ladder (decision 3A + OV2/3, 10B + OV9).
 * A render plan names sources by `assetRef` only; this decides where each one comes
 * from on this phone. Pure logic: the SQLite database and the native engine are
 * passed in (`local-media-native.ts` wires the real ones), so every branch runs in vitest.
 *
 *   import ─▶ stageImport ─┬─ Photos pick, full library access ─▶ referenced by PHAsset id (D5)
 *                          ├─ Files / share / capture / sticker / limited-access Photos
 *                          │     ─▶ copied into Application Support/Editify/media BEFORE upload
 *                          └─ nothing on disk ─▶ server-only
 *          upload ok ─▶ commit(assetId): row + fingerprint of the uploaded file (+ proxy queued)
 *
 *   assetRef ─▶ resolveMedia ─┬─ app file on disk ─────────────────────────▶ 'file'
 *                             ├─ PHAsset local, fingerprint matches ────────▶ 'local'
 *                             ├─ PHAsset local, fingerprint differs ────────▶ 'changed'
 *                             ├─ PHAsset in iCloud ─▶ 'icloud' ─▶ downloadMedia (progress, cancel)
 *                             └─ no row / server-only / deleted / limited / denied ─▶ 'server'
 *                                (preview: the server proxy; export: the server render path)
 *
 * The app file is checked first: it is the exact file that was uploaded, so nothing
 * can have changed under it. Paths are stored relative to the native media root
 * (`mediaRoot()`), because the app container's absolute path changes on every update.
 */
import type { AssetRef } from '@editify/shared';

// ─── Types shared with the native engine (structural, so tests need no native module) ───

export type MediaColor = 'hlg' | 'pq' | 'sdr';
export type PhotosAccess = 'all' | 'limited' | 'denied' | 'undetermined';

/** What the engine measures (`MediaFingerprint.swift`). `audio` is an envelope hash ("e1:…"). */
export interface MediaFingerprint {
  duration: number;
  bytes: number;
  audio: string | null;
  color: MediaColor | null;
}

export type MediaProbe =
  | { status: 'ok'; fingerprint: MediaFingerprint }
  | { status: 'icloud' }
  | { status: 'unreachable'; error: string }
  | { status: 'missing'; access: PhotosAccess }
  | { status: 'failed'; error: string };

/** The native calls the registry needs; `local-media-native.ts` maps them to EditifyEngine and expo-file-system. */
export interface MediaNative {
  /** A PHAsset id or file:// URI, never downloading from iCloud. */
  probe(ref: string): Promise<MediaProbe>;
  /** `probe` that downloads an iCloud original first; rejects once `cancelDownload(requestId)` lands. */
  download(ref: string, requestId: string, onProgress?: (fraction: number) => void): Promise<MediaProbe>;
  cancelDownload(requestId: string): void;
  photosAccess(): PhotosAccess;
  /** file:// URL of the media root, with a trailing slash. */
  mediaRoot(): string;
  /** Copies a file:// URI into the durable media folder; `path` is relative to `mediaRoot()`. */
  durableCopy(uri: string, name: string): Promise<{ path: string; uri: string }>;
  fileExists(uri: string): boolean;
  removeFile(uri: string): void;
  ensureProxy(assetId: string, ref: string): Promise<void>;
  touchProxy(assetId: string): boolean;
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
  /** Relative to the media root. */
  proxyUri: string | null;
  proxyStatus: ProxyStatus | null;
  /** The audio envelope hash of the uploaded file. */
  fingerprint: string | null;
  duration: number | null;
  bytes: number | null;
  color: MediaColor | null;
  serverOnly: boolean;
  updatedAt: number;
}

/** What an import knows about a source; the proxy columns are left as they are. */
export interface LocalMediaRecord {
  assetId: string;
  phLocalId?: string | null;
  fileUri?: string | null;
  fingerprint?: MediaFingerprint | null;
}

interface RawRow {
  asset_id: string;
  ph_local_id: string | null;
  file_uri: string | null;
  proxy_uri: string | null;
  proxy_status: string | null;
  fingerprint: string | null;
  duration: number | null;
  bytes: number | null;
  color: string | null;
  server_only: number;
  updated_at: number;
}

export interface LocalMediaStore {
  lookup(assetId: string): Promise<LocalMediaRow | null>;
  /** Insert or replace what an import knows (the proxy columns survive). */
  record(entry: LocalMediaRecord): Promise<void>;
  /** No local source: preview from the server proxy, export on the server. */
  markServerOnly(assetId: string): Promise<void>;
  /** Trust-on-first-use for a row stored without one. */
  setFingerprint(assetId: string, fingerprint: MediaFingerprint): Promise<void>;
  /** Only touches an existing row. */
  setProxy(assetId: string, status: ProxyStatus | null, proxyUri: string | null): Promise<void>;
}

export function createLocalMediaStore(db: SqlDb, now: () => number = Date.now): LocalMediaStore {
  return {
    async lookup(assetId) {
      const raw = await db.getFirstAsync<RawRow>('SELECT * FROM local_media WHERE asset_id = ?', assetId);
      return raw ? fromRaw(raw) : null;
    },
    async record(entry) {
      const fingerprint = entry.fingerprint ?? null;
      await db.runAsync(
        `INSERT INTO local_media (asset_id, ph_local_id, file_uri, fingerprint, duration, bytes, color, server_only, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           ph_local_id = excluded.ph_local_id, file_uri = excluded.file_uri, fingerprint = excluded.fingerprint,
           duration = excluded.duration, bytes = excluded.bytes, color = excluded.color,
           server_only = 0, updated_at = excluded.updated_at`,
        entry.assetId, entry.phLocalId ?? null, entry.fileUri ?? null,
        fingerprint?.audio ?? null, fingerprint?.duration ?? null, fingerprint?.bytes ?? null, fingerprint?.color ?? null,
        now(),
      );
    },
    async markServerOnly(assetId) {
      await db.runAsync(
        `INSERT INTO local_media (asset_id, server_only, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(asset_id) DO UPDATE SET server_only = 1, updated_at = excluded.updated_at`,
        assetId, now(),
      );
    },
    async setFingerprint(assetId, fingerprint) {
      await db.runAsync(
        'UPDATE local_media SET fingerprint = ?, duration = ?, bytes = ?, color = ?, updated_at = ? WHERE asset_id = ?',
        fingerprint.audio, fingerprint.duration, fingerprint.bytes, fingerprint.color, now(), assetId,
      );
    },
    async setProxy(assetId, status, proxyUri) {
      await db.runAsync(
        'UPDATE local_media SET proxy_status = ?, proxy_uri = ?, updated_at = ? WHERE asset_id = ?',
        status, proxyUri, now(), assetId,
      );
    },
  };
}

function fromRaw(raw: RawRow): LocalMediaRow {
  return {
    assetId: raw.asset_id,
    phLocalId: raw.ph_local_id,
    fileUri: raw.file_uri,
    proxyUri: raw.proxy_uri,
    proxyStatus: raw.proxy_status as ProxyStatus | null,
    fingerprint: raw.fingerprint,
    duration: raw.duration,
    bytes: raw.bytes,
    color: raw.color as MediaColor | null,
    serverOnly: raw.server_only === 1,
    updatedAt: raw.updated_at,
  };
}

// ─── Fingerprints (OV2) ───

/** A remux or a re-encode can move the duration by a frame or two; a trim moves it by far more. */
export const FINGERPRINT_DURATION_TOLERANCE = 0.1;
/** Same audio decodes to the same hash; a front trim scrambles about half of it. */
export const FINGERPRINT_MAX_BIT_DIFFERENCE = 0.1;

/** Share of differing bits between two envelope hashes, or null when they can't be compared. */
export function envelopeDistance(a: string, b: string): number | null {
  const [tagA, hexA = ''] = a.split(':');
  const [tagB, hexB = ''] = b.split(':');
  if (!tagA || tagA !== tagB) return null;
  const length = Math.max(hexA.length, hexB.length);
  if (length === 0) return 0;
  let differing = 0;
  for (let index = 0; index < length; index += 1) {
    const x = Number.parseInt(hexA[index] ?? '', 16);
    const y = Number.parseInt(hexB[index] ?? '', 16);
    // A nibble only one side has counts as fully different.
    if (Number.isNaN(x) || Number.isNaN(y)) { differing += 4; continue; }
    let bits = x ^ y;
    while (bits) { differing += bits & 1; bits >>= 1; }
  }
  return differing / (length * 4);
}

/**
 * Is `actual` (the source as it is now) still the file the project was cut against?
 * Duration within a frame or two, and then either the same byte size or audio whose
 * envelope agrees. Bytes alone can't decide a mismatch: the picker may hand over a
 * re-wrapped copy of the very same original.
 */
export function fingerprintsMatch(expected: Pick<LocalMediaRow, 'fingerprint' | 'duration' | 'bytes'>, actual: MediaFingerprint): boolean {
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
  | 'deleted'       // the PHAsset is gone, with full library access
  | 'limited'       // outside a Limited Library selection
  | 'denied'        // no Photos access at all
  | 'file-missing'  // the app copy was removed (only when there is no PHAsset to fall back on)
  | 'unreadable';   // the source is there but couldn't be opened

interface ResolvedBase { assetId: string; kind: AssetRef['kind'] }

export type ResolvedMedia =
  /** The PHAsset original, still the uploaded clip. `ref` is the PHAsset id. */
  | (ResolvedBase & { state: 'local'; ref: string; fingerprint: MediaFingerprint; proxyUri?: string })
  /** The app's own copy (Files, share, capture, sticker, limited-access Photos). `ref` is its file:// URI. */
  | (ResolvedBase & { state: 'file'; ref: string; proxyUri?: string })
  /** The PHAsset differs from what was uploaded: the user picks "use it anyway / re-link / server copy". */
  | (ResolvedBase & { state: 'changed'; ref: string; expected: Pick<LocalMediaRow, 'fingerprint' | 'duration' | 'bytes'>; actual: MediaFingerprint })
  /** Offloaded to iCloud: `downloadMedia` fetches it. `unreachable` is the last download's error (offline). */
  | (ResolvedBase & { state: 'icloud'; ref: string; unreachable?: string })
  /** No usable local source: preview from the server proxy, export through the server. */
  | (ResolvedBase & { state: 'server'; reason: ServerReason });

export interface MediaDeps { store: LocalMediaStore; native: MediaNative }

export interface ResolveOptions {
  /** 'preview' (default) attaches the 1080p proxy when it is on disk and queues it when not. */
  purpose?: 'preview' | 'export';
}

/** file:// URI for a path stored relative to the media root. */
export function absoluteUri(native: Pick<MediaNative, 'mediaRoot'>, relative: string): string {
  const root = native.mediaRoot();
  return `${root.endsWith('/') ? root : `${root}/`}${relative}`;
}

export async function resolveMedia(ref: AssetRef, deps: MediaDeps, options: ResolveOptions = {}): Promise<ResolvedMedia> {
  const base: ResolvedBase = { assetId: ref.id, kind: ref.kind };
  const row = await deps.store.lookup(ref.id);
  if (!row) return { ...base, state: 'server', reason: 'no-row' };
  if (row.serverOnly) return { ...base, state: 'server', reason: 'server-only' };

  let reason: ServerReason = 'server-only';
  if (row.fileUri) {
    const uri = absoluteUri(deps.native, row.fileUri);
    if (deps.native.fileExists(uri)) return await withProxy({ ...base, state: 'file', ref: uri }, row, deps, options);
    reason = 'file-missing';
  }
  if (row.phLocalId) {
    const outcome = await fromProbe(base, row, row.phLocalId, await deps.native.probe(row.phLocalId), deps);
    return outcome.state === 'local' ? await withProxy(outcome, row, deps, options) : outcome;
  }
  return { ...base, state: 'server', reason };
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

// ─── Import hooks ───

export type ImportOrigin = 'photos' | 'files' | 'share' | 'capture';

export interface ImportCandidate {
  /** The picked/shared/recorded file; empty or a blob: URL when there is none on disk. */
  uri: string;
  name: string;
  kind: AssetRef['kind'];
  origin: ImportOrigin;
  /** ImagePicker's `assetId` (a PHAsset localIdentifier), when it gave one. */
  phLocalId?: string | null;
}

export interface StagedImport {
  /** What to upload: the durable copy when one was made, so a later edit to the picked file can't diverge. */
  uploadUri: string;
  /** The device keeps its own copy (a share-extension copy is then redundant). */
  durable: boolean;
  /** After a successful upload: writes the row (and queues the preview proxy for video). */
  commit(assetId: string): Promise<void>;
  /** After a failed upload: removes the copy made for it. */
  abort(): void;
}

/**
 * Prepares one import before its upload. Photos videos are referenced by PHAsset id
 * when the app has full library access (D5: never copied); everything else that has
 * a file is copied into the durable media folder first. Without access, a Photos id
 * is kept anyway (it starts working if the user grants access later) next to the copy.
 * No file at all (or a failed copy) leaves the asset server-only.
 */
export async function stageImport(candidate: ImportCandidate, deps: MediaDeps): Promise<StagedImport> {
  const { native, store } = deps;
  const onDisk = candidate.uri.startsWith('file://');
  const phLocalId = candidate.phLocalId ?? null;
  const serverOnly: StagedImport = {
    uploadUri: candidate.uri,
    durable: false,
    commit: async (assetId) => { await store.markServerOnly(assetId); },
    abort: () => undefined,
  };

  if (candidate.kind === 'video' && candidate.origin === 'photos' && phLocalId && native.photosAccess() === 'all') {
    return {
      uploadUri: candidate.uri,
      durable: false,
      commit: async (assetId) => {
        await store.record({ assetId, phLocalId, fingerprint: onDisk ? await fingerprintOf(native, candidate.uri) : null });
        native.ensureProxy(assetId, phLocalId).catch(() => undefined);
      },
      abort: () => undefined,
    };
  }
  if (!onDisk) return serverOnly;

  let copy: { path: string; uri: string };
  try {
    copy = await native.durableCopy(candidate.uri, candidate.name);
  } catch {
    return serverOnly; // disk full: the upload still goes ahead, from the picked file
  }
  return {
    uploadUri: copy.uri,
    durable: true,
    commit: async (assetId) => {
      const fingerprint = candidate.kind === 'image' ? null : await fingerprintOf(native, copy.uri);
      await store.record({ assetId, phLocalId, fileUri: copy.path, fingerprint });
      if (candidate.kind === 'video') native.ensureProxy(assetId, copy.uri).catch(() => undefined);
    },
    abort: () => {
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
export function mediaKindOf(mimeType: string | undefined | null, name: string): AssetRef['kind'] {
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
