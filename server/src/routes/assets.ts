import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import type { AssetMetadata } from '@editify/shared';
import { z } from 'zod';
import type { AssetStore, StoredAsset } from '../db/asset-store.js';
import type { EditifyDatabase } from '../db/database.js';
import type { ProjectStore } from '../db/project-store.js';
import { assetsRoot, mediaImportDir } from '../config.js';
import { COLOR_PIPELINE_VERSION } from '../media/color.js';
import { createFilmstrip, createProxyAndThumbnail, probeMedia, regenerateThumbnail, type ProbeResult } from '../media/process.js';
import { sendMediaFile } from '../media/send-file.js';
import { isFile } from '../services/asset-availability.js';
import type { DissectService } from '../services/dissect-service.js';
import type { FaceService } from '../services/face-service.js';
import type { InsightService } from '../services/insight-service.js';
import { timeMediaJob } from '../services/media-jobs.js';
import { mediaSlots, withMediaSlot, type SlotLane } from '../services/media-slots.js';
import type { TranscriptService } from '../services/transcript-service.js';
import { WaveformService } from '../services/waveform-service.js';

function publicAsset(asset: StoredAsset): AssetMetadata {
  const { originalPath: _originalPath, proxyPath: _proxyPath, thumbnailPath: _thumbnailPath, ...metadata } = asset;
  return metadata;
}

async function sendFile(reply: FastifyReply, path: string, type: string, range: string | undefined): Promise<FastifyReply> {
  reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  return await sendMediaFile(reply, path, type, range);
}

const importRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  /** Links the imported file to this project so it stays out of other libraries. */
  projectId: z.string().min(1).optional(),
}).strict();
const forceRequestSchema = z.object({ force: z.boolean().optional().default(false) }).strict();
const labelRequestSchema = z.object({ label: z.string().max(120) }).strict();
const linkRequestSchema = z.object({ projectId: z.string().min(1) }).strict();
const rawUploadSchema = z.string().trim().min(1).max(255);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * The only spelling of an asset id that may name a folder: server ids are lowercase UUIDs
 * (and the library's `sound-…`). Exact-case only, since SQLite compares ids byte for byte
 * while a case-insensitive filesystem would not.
 */
const CANONICAL_ASSET_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
/** A re-uploaded original may differ from the record by a remux's frame or two, never by a trim. */
export const RESTORE_DURATION_TOLERANCE = 0.25;
/** Pixel sizes may differ by rounding in a re-wrap, never by a resize. */
const RESTORE_SIZE_TOLERANCE = 0.01;

/**
 * Is a re-uploaded file the original `record` describes? Same kind of media (a picture
 * where there was one, audio where there was audio), the same duration within a frame or
 * two, and the same pixel size either way round (a rotation flag may swap them).
 */
export function sameMedia(record: Pick<StoredAsset, 'mimeType' | 'duration' | 'width' | 'height' | 'hasAudio'>, probe: ProbeResult): boolean {
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(2, Math.max(a, b) * RESTORE_SIZE_TOLERANCE);
  const sameSize = (close(probe.width, record.width) && close(probe.height, record.height))
    || (close(probe.width, record.height) && close(probe.height, record.width));
  if (record.mimeType.startsWith('image/')) return probe.hasVideo && sameSize;
  if (Math.abs(probe.duration - record.duration) > RESTORE_DURATION_TOLERANCE) return false;
  if (record.mimeType.startsWith('audio/')) return probe.hasAudio;
  return probe.hasVideo && probe.hasAudio === record.hasAudio && sameSize;
}

export class UploadTooLargeError extends Error {}

function isMediaType(mimeType: string): boolean {
  return mimeType.startsWith('video/') || mimeType.startsWith('audio/')
    || mimeType.startsWith('image/') || mimeType === 'application/octet-stream';
}

/** Fails the pipeline once more than `limit` bytes pass, instead of filling the disk. */
export function capBytes(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new UploadTooLargeError(`Uploads are limited to ${Math.round(limit / 1024 ** 3)} GB`));
      else done(null, chunk);
    },
  });
}

const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const videoMimeTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '' && !pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot);
}

/** Envelope cells shipped to the client, tops. ~16KB of JSON at the cap. */
const MAX_WAVEFORM_CELLS = 2000;

/** Peak-reduce an envelope down to the cap; peak, not mean, as the client draws peaks. */
function downsampleEnvelope(envelope: { cellSeconds: number; rmsDb: number[] }): { cellSeconds: number; rmsDb: number[] } {
  const cells = envelope.rmsDb.length;
  if (cells <= MAX_WAVEFORM_CELLS) return envelope;
  const factor = Math.ceil(cells / MAX_WAVEFORM_CELLS);
  const rmsDb: number[] = [];
  for (let index = 0; index < cells; index += factor) {
    let peak = -100;
    for (let cell = index; cell < Math.min(cells, index + factor); cell += 1) peak = Math.max(peak, envelope.rmsDb[cell] ?? -100);
    rmsDb.push(peak);
  }
  return { cellSeconds: envelope.cellSeconds * factor, rmsDb };
}

/**
 * Background work per asset id: proxy, thumbnail, transcription and faces.
 * Imports do not wait for it — the row is already in the library, marked
 * `processing`. Exposed so tests can await an import deterministically.
 */
export const pendingAssetWork = new Map<string, Promise<void>>();

/**
 * ffmpeg and whisper each saturate the box on their own, so a 40-clip import
 * that spawns 40 of them leaves everything crawling. Every import job waits its
 * turn in the shared media pool (`media-slots.ts`) inside the asset's
 * `pendingAssetWork` promise, so awaiting an import still waits for the queue.
 *
 * Each import queues two slot jobs the moment it lands:
 * - `import <id>`, foreground: proxy + thumbnail + colour sidecar, which is what
 *   moves the row to `ready`, then face tracking while it still holds the slot.
 * - `transcribe <id>`, background: Whisper reads the original's audio and never
 *   needs the proxy, so it no longer queues behind the encode. That encode used
 *   to hold the one slot through the whole Whisper run, and an agent turn on a
 *   fresh 5-minute clip waited for both back to back.
 *
 * Memory and concurrency: this changes *who* holds a slot, never *how many*.
 * The pool still runs at most `capacity` (2) jobs, and "a preview encode next
 * to a Whisper run" was already a reachable pair (two imports, or an import
 * plus an on-demand transcription), as was "a render next to Whisper". The
 * worst case on the 4 GB box stays a ~2 GB render plus one other job. The
 * background lane keeps previews fast: background work holds at most
 * `capacity - 1` slots, so a preview or render waits on at most one Whisper; a
 * waiting proxy (or render) gets a freed slot before a waiting import
 * transcription, except that the transcription gets a turn every few grants;
 * and a transcript someone asks for, or a timeline reader misses, is promoted
 * out of the background lane (`TranscriptService`). Background Whisper also
 * runs on fewer CPU threads so the encode next to it keeps the cores.
 *
 * No deadlock: the two jobs are siblings started outside any slot (`detached`), neither waits on the
 * other, and nothing inside a slot waits for a second one. An on-demand
 * transcription during the import joins this run through `TranscriptService`'s
 * in-flight map rather than starting a second Whisper.
 *
 * Runs after the import responded, and moves the row to `ready` or `error`.
 */
export function queueAssetWork(
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>,
  assets: AssetStore,
  transcripts: TranscriptService,
  asset: StoredAsset,
  probe: ProbeResult,
  faces?: FaceService,
): void {
  const pending = mediaSlots.detached(() => {
    const queuedAt = performance.now();
    // Queued first, so when only one slot is free the preview takes it.
    const preview = withMediaSlot(`import ${asset.id}`, async () => {
      try {
        const generated = await timeMediaJob('proxy', { assetId: asset.id }, () =>
          createProxyAndThumbnail(asset.originalPath, dirname(asset.proxyPath), probe), performance.now() - queuedAt);
        assets.setStatus(asset.id, 'ready', generated);
      } catch (error) {
        assets.setStatus(asset.id, 'error');
        log.error({ err: error, assetId: asset.id }, 'Asset proxy generation failed');
        // A video ffmpeg cannot encode is unlikely to decode for Whisper either:
        // drop its transcription if it has not started (an audio-only clip, or
        // one someone already asked for, keeps it).
        if (probe.hasVideo) transcripts.dropQueued(asset.id, 'Skipped: the video could not be decoded');
        return;
      }
      // Tracked now so the first caption placement doesn't wait on OpenCV.
      if (faces && probe.hasVideo) {
        try {
          await timeMediaJob('faces', { assetId: asset.id }, () => faces.getOrCreate(asset));
        } catch (error) {
          log.warn({ err: error, assetId: asset.id }, 'Face tracking failed; captions will only keep to the safe area');
        }
      }
    });
    const transcript = transcribeQuietly(log, transcripts, asset, 'background');
    return Promise.all([preview, transcript]);
  }).then(() => undefined).finally(() => pendingAssetWork.delete(asset.id));
  pendingAssetWork.set(asset.id, pending);
}

/**
 * Probe synchronously — it is fast and gives the duration the timeline needs —
 * then hand the slow encode off to the background.
 */
async function processAsset(
  app: FastifyInstance,
  assets: AssetStore,
  transcripts: TranscriptService,
  input: { originalName: string; mimeType: string; originalPath: string },
  id: string = randomUUID(),
  userId?: string,
  faces?: FaceService,
): Promise<StoredAsset> {
  const directory = join(assetsRoot, id);
  await mkdir(directory, { recursive: true });
  try {
    const probe = await timeMediaJob('probe', { assetId: id }, () => probeMedia(input.originalPath));
    if (!probe.hasVideo && !probe.hasAudio) throw new Error('The media file has no video or audio streams');
    if (input.mimeType.startsWith('image/')) {
      // Stickers: no proxy or transcode — the original IS the display asset.
      // GIF durations come from ffprobe; stills get 0 and live on overlay
      // clips whose in/out are timeline-local anyway.
      return assets.insert({
        id,
        originalName: input.originalName,
        mimeType: input.mimeType,
        duration: Number.isFinite(probe.duration) ? probe.duration : 0,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        hasAudio: false,
        status: 'ready',
        originalPath: input.originalPath,
        proxyPath: input.originalPath,
        thumbnailPath: input.originalPath,
        originalUrl: `/assets/${id}/original`,
        proxyUrl: `/assets/${id}/original`,
        thumbnailUrl: `/assets/${id}/thumb.jpg`,
        filmstripUrl: `/assets/${id}/filmstrip.jpg`,
        createdAt: new Date().toISOString(),
      }, userId);
    }
    const asset = assets.insert({
      id,
      originalName: input.originalName,
      mimeType: input.mimeType,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      status: 'processing',
      originalPath: input.originalPath,
      proxyPath: join(directory, 'proxy.mp4'),
      thumbnailPath: join(directory, 'thumb.jpg'),
      originalUrl: `/assets/${id}/original`,
      proxyUrl: `/assets/${id}/proxy.mp4`,
      thumbnailUrl: `/assets/${id}/thumb.jpg`,
      filmstripUrl: `/assets/${id}/filmstrip.jpg`,
      createdAt: new Date().toISOString(),
    }, userId);
    queueAssetWork(app.log, assets, transcripts, asset, probe, faces);
    return asset;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function transcribeQuietly(
  log: Pick<FastifyBaseLogger, 'warn'>,
  transcripts: TranscriptService,
  asset: StoredAsset,
  lane: SlotLane,
): Promise<void> {
  if (!asset.hasAudio) return;
  try {
    await transcripts.transcribe(asset, false, { lane });
  } catch (error) {
    log.warn({ err: error, assetId: asset.id }, 'Asset transcription failed; media import will continue');
  }
}

export function registerAssetRoutes(
  app: FastifyInstance,
  assets: AssetStore,
  projects: ProjectStore,
  transcripts: TranscriptService,
  insights: InsightService,
  dissections: DissectService,
  database: EditifyDatabase,
  faces?: FaceService,
): void {
  // ponytail: built here rather than in `buildApp` so wiring stays one line —
  // hoist it up if anything outside these routes ever needs an envelope.
  const waveforms = new WaveformService(database, transcripts);
  // Raw media bodies (POST /assets/raw) reach the handler as the request stream,
  // unbuffered and outside the app-wide bodyLimit; saveUpload caps them itself.
  const passStream = (_request: unknown, payload: NodeJS.ReadableStream, done: (error: Error | null, body?: unknown) => void): void => {
    done(null, payload);
  };
  app.addContentTypeParser('application/octet-stream', passStream);
  app.addContentTypeParser(/^(video|audio|image)\//, passStream);

  /** Reads `?projectId=` and refuses ids that do not exist, so links cannot dangle. */
  function requireProject(id: unknown, reply: FastifyReply, userId?: string): string | undefined | null {
    if (id === undefined || id === '') return undefined;
    const projectId = String(id);
    if (!projects.get(projectId, userId)) {
      void reply.code(404).send({ error: 'Project not found' });
      return null;
    }
    return projectId;
  }

  /** Streams one upload to disk, then probes and registers it. Shared by the multipart and raw routes. */
  async function saveUpload(
    reply: FastifyReply,
    body: NodeJS.ReadableStream,
    file: { name: string; mimeType: string },
    projectId: string | undefined,
    userId: string | undefined,
  ): Promise<FastifyReply> {
    const id = randomUUID();
    const directory = join(assetsRoot, id);
    await mkdir(directory, { recursive: true });
    const extension = extname(file.name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12) || '.media';
    const originalPath = join(directory, `original${extension}`);
    try {
      await pipeline(body, capBytes(MAX_UPLOAD_BYTES), (await import('node:fs')).createWriteStream(originalPath));
      const asset = await processAsset(app, assets, transcripts, {
        originalName: file.name,
        mimeType: file.mimeType,
        originalPath,
      }, id, userId, faces);
      if (projectId) assets.link(projectId, asset.id);
      return await reply.code(201).send(publicAsset(asset));
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (error instanceof UploadTooLargeError) return await reply.code(413).send({ error: error.message });
      throw error;
    }
  }

  app.post<{ Querystring: { projectId?: string } }>('/assets', async (request, reply) => {
    const projectId = requireProject(request.query.projectId, reply, request.userId);
    if (projectId === null) return reply;
    const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) return await reply.code(400).send({ error: 'A multipart media file is required' });
    if (!isMediaType(part.mimetype)) {
      part.file.resume();
      return await reply.code(415).send({ error: 'Only video, audio, and image files are supported' });
    }
    return await saveUpload(reply, part.file, { name: part.filename, mimeType: part.mimetype }, projectId, request.userId);
  });

  /**
   * The same upload with the file as the raw request body and its name in the
   * query. iOS builds a multipart body in memory, so a 2 GB clip sent as
   * FormData gets the app killed; a raw body streams from disk on the phone.
   */
  app.post<{ Querystring: { projectId?: string; name?: string } }>('/assets/raw', async (request, reply) => {
    const projectId = requireProject(request.query.projectId, reply, request.userId);
    if (projectId === null) return reply;
    const name = rawUploadSchema.safeParse(request.query.name);
    const mimeType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    // Only the media parser above hands over a stream; any other type arrives parsed.
    const body = typeof (request.body as NodeJS.ReadableStream | undefined)?.pipe === 'function'
      ? request.body as NodeJS.ReadableStream
      : undefined;
    if (!name.success || !body || !isMediaType(mimeType)) {
      body?.resume();
      return await reply.code(!name.success ? 400 : 415).send({
        error: !name.success ? 'A file name is required' : 'Only video, audio, and image files are supported',
      });
    }
    // The phone sends the file's size up front; refuse an oversized one before
    // it spends minutes uploading. capBytes still guards a body that lies.
    if (Number(request.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) {
      body.resume();
      return await reply.code(413).send({ error: `Uploads are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 3)} GB` });
    }
    return await saveUpload(reply, body, { name: name.data, mimeType }, projectId, request.userId);
  });

  /**
   * Puts an original back on the server under its existing asset id (plan OV1, "upload
   * clips X"): the phone uploads only the clips a server render is missing, from its app
   * copy or the Photos original, and the project's references keep working.
   *
   *   an id that isn't canonical ...... 400 (lowercase, no dots or slashes: it names a folder)
   *   no row, or another account's .... 404, as if absent
   *   own row, original on disk ....... 200, nothing written (a retry)
   *   own row, original gone .......... written to a new file beside it, checked against the
   *                                     record (kind, duration, size; 409 { code: 'mismatch' }
   *                                     when it is another file), then renamed into place
   *
   * Always linked to `projectId`, which is required. The body is the raw file, as for /assets/raw.
   * Only the incoming file this request wrote is ever removed, never a folder.
   */
  app.put<{ Params: { id: string }; Querystring: { projectId?: string; name?: string } }>('/assets/:id/original', async (request, reply) => {
    const body = typeof (request.body as NodeJS.ReadableStream | undefined)?.pipe === 'function'
      ? request.body as NodeJS.ReadableStream
      : undefined;
    const refuse = async (status: number, payload: unknown): Promise<FastifyReply> => {
      body?.resume();
      return await reply.code(status).send(payload);
    };
    const { id } = request.params;
    // Case-insensitive filesystems (a Mac host) would map "ABC" onto another row's "abc"
    // folder: only the canonical spelling ever reaches the disk.
    if (!CANONICAL_ASSET_ID.test(id)) return await refuse(400, { error: 'Asset ids are lowercase letters, digits and dashes' });
    const projectId = requireProject(request.query.projectId, reply, request.userId);
    if (projectId === null) { body?.resume(); return reply; }
    if (!projectId) return await refuse(400, { error: 'projectId is required' });
    const existing = assets.owned(id, request.userId);
    if (!existing) return await refuse(404, { error: 'Asset not found' });
    if (await isFile(existing.originalPath)) {
      assets.link(projectId, id);
      return await refuse(200, publicAsset(existing));
    }
    const name = rawUploadSchema.safeParse(request.query.name);
    const mimeType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    if (!name.success || !body || !isMediaType(mimeType)) {
      return await refuse(!name.success ? 400 : 415, {
        error: !name.success ? 'A file name is required' : 'Only video, audio, and image files are supported',
      });
    }
    if (Number(request.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) {
      return await refuse(413, { error: `Uploads are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 3)} GB` });
    }

    const directory = join(assetsRoot, id);
    // The asset's own folder (it may already hold its proxy and thumbnail).
    await mkdir(directory, { recursive: true });
    const extension = extname(name.data).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12) || extname(existing.originalPath) || '.media';
    const incoming = join(directory, `incoming-${randomUUID()}${extension}`);
    try {
      await pipeline(body, capBytes(MAX_UPLOAD_BYTES), (await import('node:fs')).createWriteStream(incoming, { flags: 'wx' }));
      const probe = await probeMedia(incoming).catch(() => undefined);
      if (!probe || !sameMedia(existing, probe)) {
        await rm(incoming, { force: true });
        return await reply.code(409).send({ error: "That file isn't the clip this project uses", code: 'mismatch' });
      }
      const originalPath = join(directory, `original${extension}`);
      // Atomic: two restores of the same clip each rename a whole file; the last one stays.
      await rename(incoming, originalPath);
      assets.setOriginalPath(id, originalPath);
      assets.link(projectId, id);
      return await reply.code(200).send(publicAsset(assets.get(id) ?? existing));
    } catch (error) {
      await rm(incoming, { force: true });
      if (error instanceof UploadTooLargeError) return await reply.code(413).send({ error: error.message });
      throw error;
    }
  });

  // The media library. With `?projectId=` it is scoped to that project's own
  // imports; without it, every asset the caller can see, for the "all clips" browser.
  // Newest first either way.
  app.get<{ Querystring: { projectId?: string } }>('/assets', async (request, reply) => {
    const projectId = requireProject(request.query.projectId, reply, request.userId);
    if (projectId === null) return reply;
    const list = projectId ? assets.listForProject(projectId, request.userId) : assets.list(request.userId);
    return list.reverse().map(publicAsset);
  });

  // Pull an asset from another project into this one — the only way media
  // crosses a project boundary, and always because the user asked for it.
  app.post<{ Params: { id: string } }>('/assets/:id/link', async (request, reply) => {
    const projectId = requireProject(linkRequestSchema.parse(request.body).projectId, reply, request.userId);
    if (projectId === null) return reply;
    if (!projectId) return await reply.code(400).send({ error: 'projectId is required' });
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    assets.link(projectId, asset.id);
    return publicAsset(asset);
  });

  app.patch<{ Params: { id: string } }>('/assets/:id', async (request, reply) => {
    const { label } = labelRequestSchema.parse(request.body);
    if (!assets.owned(request.params.id, request.userId)) return await reply.code(404).send({ error: 'Asset not found' });
    const updated = assets.setLabel(request.params.id, label);
    return updated ? publicAsset(updated) : await reply.code(404).send({ error: 'Asset not found' });
  });

  // MEDIA_IMPORT_DIR is one folder on the server, not anybody's library, so
  // only unscoped callers (shared token, local dev) may browse or import it.
  app.get('/assets/importable', async (request, reply) => {
    if (request.userId) return await reply.code(403).send({ error: 'Server imports are not available to signed-in users' });
    let entries;
    try {
      entries = await readdir(mediaImportDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const importable = await Promise.all(entries
      .filter((entry) => entry.isFile() && videoExtensions.has(extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => ({
        name: entry.name,
        size: (await stat(join(mediaImportDir, entry.name))).size,
        alreadyImported: Boolean(assets.getByOriginalName(entry.name, request.userId)),
      })));
    return importable;
  });

  app.post('/assets/import', async (request, reply) => {
    if (request.userId) return await reply.code(403).send({ error: 'Server imports are not available to signed-in users' });
    const { name, projectId: requestedProject } = importRequestSchema.parse(request.body);
    const projectId = requireProject(requestedProject, reply, request.userId);
    if (projectId === null) return reply;
    const importRoot = resolve(mediaImportDir);
    const requestedPath = resolve(importRoot, name);
    if (!isInside(importRoot, requestedPath)) {
      return await reply.code(400).send({ error: 'Import path must stay inside MEDIA_IMPORT_DIR' });
    }
    const extension = extname(requestedPath).toLowerCase();
    if (!videoExtensions.has(extension)) {
      return await reply.code(400).send({ error: 'Only video files can be imported' });
    }
    const existing = assets.getByOriginalName(name, request.userId);
    if (existing) {
      if (projectId) assets.link(projectId, existing.id);
      // Already on disk — a missing transcript can catch up in the background.
      void transcribeQuietly(app.log, transcripts, existing, 'background');
      return publicAsset(existing);
    }

    let sourcePath: string;
    try {
      const [canonicalRoot, canonicalSource] = await Promise.all([realpath(importRoot), realpath(requestedPath)]);
      if (!isInside(canonicalRoot, canonicalSource) || !(await stat(canonicalSource)).isFile()) {
        return await reply.code(400).send({ error: 'Import path must identify a file inside MEDIA_IMPORT_DIR' });
      }
      sourcePath = canonicalSource;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return await reply.code(404).send({ error: 'Importable media file not found' });
      }
      throw error;
    }
    const asset = await processAsset(app, assets, transcripts, {
      originalName: name,
      mimeType: videoMimeTypes[extension] ?? 'video/mp4',
      originalPath: sourcePath,
    }, undefined, request.userId, faces);
    if (projectId) assets.link(projectId, asset.id);
    return await reply.code(201).send(publicAsset(asset));
  });

  app.get<{ Params: { id: string } }>('/assets/:id/transcript', async (request, reply) => {
    if (!assets.get(request.params.id, request.userId)) return await reply.code(404).send({ error: 'Asset not found' });
    return transcripts.get(request.params.id) ?? await reply.code(404).send({ error: 'No transcript' });
  });

  app.post<{ Params: { id: string } }>('/assets/:id/transcribe', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    if (!asset.hasAudio) return await reply.code(422).send({ error: 'Asset has no audio' });
    const { force } = forceRequestSchema.parse(request.body ?? {});
    return await transcripts.transcribe(asset, force);
  });

  app.get<{ Params: { id: string } }>('/assets/:id/insights', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    const result = await insights.getOrCreate(asset, false);
    return result ?? await reply.code(404).send({ error: 'No transcript' });
  });

  app.post<{ Params: { id: string } }>('/assets/:id/insights', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    const { force } = forceRequestSchema.parse(request.body ?? {});
    const result = await insights.getOrCreate(asset, force);
    return result ?? await reply.code(404).send({ error: 'No transcript' });
  });

  // Measured dissection of the source video: cut cadence, energy, tempo,
  // burned-in graphic spans. Computed on first request, cached in SQLite.
  app.get<{ Params: { id: string } }>('/assets/:id/dissect', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    return await dissections.getOrCreate(asset);
  });

  app.post<{ Params: { id: string } }>('/assets/:id/dissect', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    const { force } = forceRequestSchema.parse(request.body ?? {});
    return await dissections.getOrCreate(asset, force);
  });

  // RMS cells over the whole source, for the bars drawn inside timeline
  // clips. Silent assets answer with an empty envelope, not an error — the
  // client draws nothing and never has to special-case a failure. Stored at
  // full 50ms resolution, peak-reduced on the way out: the client draws at
  // most ~120 bars per clip, so a long source shipping 100KB of cells was
  // pure wire cost.
  app.get<{ Params: { id: string } }>('/assets/:id/waveform', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    return downsampleEnvelope(await waveforms.getOrCreate(asset));
  });

  app.get<{ Params: { id: string } }>('/assets/:id', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    return asset ? publicAsset(asset) : await reply.code(404).send({ error: 'Asset not found' });
  });

  /** Generated media is written in the background, so "not yet" is a 409, not a crash. */
  function notReady(reply: FastifyReply, asset: StoredAsset): FastifyReply {
    return reply.code(409).send({
      error: asset.status === 'error'
        ? 'Asset processing failed'
        : 'Asset is still processing',
      status: asset.status,
    });
  }

  app.get<{ Params: { id: string } }>('/assets/:id/proxy.mp4', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    if (!existsSync(asset.proxyPath)) return notReady(reply, asset);
    return await sendFile(reply, asset.proxyPath, 'video/mp4', request.headers.range);
  });

  /**
   * Thumbnails cut before the colour pipeline landed carry a cast the preview
   * does not, so the first browse after an upgrade re-shoots them. In-flight
   * regenerations are shared, and a failure serves the old file rather than
   * turning a stale thumb into a broken one.
   */
  const recolors = new Map<string, Promise<void>>();
  function colorPipelineIsStale(asset: StoredAsset): boolean {
    // Image assets serve the original as their thumb: nothing to regenerate.
    if (asset.thumbnailPath === asset.originalPath) return false;
    if (!existsSync(asset.originalPath)) return false;
    try {
      const sidecar = JSON.parse(readFileSync(join(dirname(asset.thumbnailPath), 'color.json'), 'utf8')) as { version?: number };
      return (sidecar.version ?? 0) < COLOR_PIPELINE_VERSION;
    } catch {
      return true;
    }
  }

  app.get<{ Params: { id: string } }>('/assets/:id/thumb.jpg', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    if (!existsSync(asset.thumbnailPath)) return notReady(reply, asset);
    if (colorPipelineIsStale(asset)) {
      const pending = recolors.get(asset.id) ?? timeMediaJob('thumbnail', { assetId: asset.id }, () =>
        regenerateThumbnail(asset.originalPath, asset.thumbnailPath, asset))
        .then(async () => { await rm(join(dirname(asset.thumbnailPath), 'filmstrip.jpg'), { force: true }); })
        .catch((error: unknown) => { app.log.warn({ err: error, assetId: asset.id }, 'thumbnail recolor failed'); })
        .finally(() => recolors.delete(asset.id));
      recolors.set(asset.id, pending);
      await pending;
    }
    // Image assets serve their original as the thumb — honour its real type.
    const type = asset.thumbnailPath === asset.originalPath ? asset.mimeType : 'image/jpeg';
    return await sendFile(reply, asset.thumbnailPath, type, request.headers.range);
  });

  // Lazily generated and cached beside the proxy: 20 tiles, left to right over [0, duration].
  // Clients map clip.in/clip.out to tile offsets; in-flight generations are shared so a burst
  // of timeline requests spawns one ffmpeg per asset.
  const filmstrips = new Map<string, Promise<string>>();
  app.get<{ Params: { id: string } }>('/assets/:id/filmstrip.jpg', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    if (!existsSync(asset.proxyPath)) return notReady(reply, asset);
    const path = join(dirname(asset.proxyPath), 'filmstrip.jpg');
    if (!existsSync(path)) {
      const pending = filmstrips.get(asset.id)
        ?? createFilmstrip(asset.proxyPath, path, asset).finally(() => filmstrips.delete(asset.id));
      filmstrips.set(asset.id, pending);
      await pending;
    }
    return await sendFile(reply, path, 'image/jpeg', request.headers.range);
  });

  app.get<{ Params: { id: string } }>('/assets/:id/original', async (request, reply) => {
    const asset = assets.get(request.params.id, request.userId);
    return asset ? await sendFile(reply, asset.originalPath, asset.mimeType, request.headers.range) : await reply.code(404).send({ error: 'Asset not found' });
  });
}
