import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AssetMetadata } from '@editify/shared';
import { z } from 'zod';
import type { AssetStore, StoredAsset } from '../db/asset-store.js';
import type { EditifyDatabase } from '../db/database.js';
import type { ProjectStore } from '../db/project-store.js';
import { assetsRoot, mediaImportDir } from '../config.js';
import { COLOR_PIPELINE_VERSION } from '../media/color.js';
import { createFilmstrip, createProxyAndThumbnail, probeMedia, regenerateThumbnail, type ProbeResult } from '../media/process.js';
import { sendMediaFile } from '../media/send-file.js';
import type { DissectService } from '../services/dissect-service.js';
import type { FaceService } from '../services/face-service.js';
import type { InsightService } from '../services/insight-service.js';
import { withMediaSlot } from '../services/media-slots.js';
import type { TranscriptService } from '../services/transcript-service.js';
import { WaveformService } from '../services/waveform-service.js';
import { READ_ONLY_MESSAGE, readOnlyReply } from '../read-only.js';

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
 * Background work per asset id: proxy, thumbnail and transcription. Imports do
 * not wait for it — the row is already in the library, marked `processing`.
 * Exposed so tests can await an import deterministically.
 */
export const pendingAssetWork = new Map<string, Promise<void>>();

/**
 * ffmpeg and whisper each saturate the box on their own, so a 40-clip import
 * that spawns 40 of them leaves everything crawling. Imports wait their turn in
 * the shared media pool (`media-slots.ts`) inside their own `pendingAssetWork`
 * promise, so awaiting an import still waits for the queue. One slot covers the
 * encode *and* the transcription: the transcription runs inside the slot this
 * chain already holds rather than taking a second one.
 *
 * Runs after the import responded, and moves the row to `ready` or `error`.
 */
function queueAssetWork(
  app: FastifyInstance,
  assets: AssetStore,
  transcripts: TranscriptService,
  asset: StoredAsset,
  probe: ProbeResult,
  faces?: FaceService,
): void {
  const pending = (async () => {
    await withMediaSlot(`import ${asset.id}`, async () => {
      try {
        const generated = await createProxyAndThumbnail(asset.originalPath, dirname(asset.proxyPath), probe);
        assets.setStatus(asset.id, 'ready', generated);
      } catch (error) {
        assets.setStatus(asset.id, 'error');
        app.log.error({ err: error, assetId: asset.id }, 'Asset proxy generation failed');
        return;
      }
      await transcribeQuietly(app, transcripts, asset);
      // Tracked now so the first caption placement doesn't wait on OpenCV.
      if (faces && probe.hasVideo) {
        try {
          await faces.getOrCreate(asset);
        } catch (error) {
          app.log.warn({ err: error, assetId: asset.id }, 'Face tracking failed; captions will only keep to the safe area');
        }
      }
    });
  })().finally(() => pendingAssetWork.delete(asset.id));
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
  id = randomUUID(),
  userId?: string,
  faces?: FaceService,
): Promise<StoredAsset> {
  const directory = join(assetsRoot, id);
  await mkdir(directory, { recursive: true });
  try {
    const probe = await probeMedia(input.originalPath);
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
    queueAssetWork(app, assets, transcripts, asset, probe, faces);
    return asset;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function transcribeQuietly(
  app: FastifyInstance,
  transcripts: TranscriptService,
  asset: StoredAsset,
): Promise<void> {
  if (!asset.hasAudio) return;
  try {
    await transcripts.transcribe(asset);
  } catch (error) {
    app.log.warn({ err: error, assetId: asset.id }, 'Asset transcription failed; media import will continue');
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
      void transcribeQuietly(app, transcripts, existing);
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
    // Read-only (the cutover freeze) serves the old thumb rather than re-shooting it.
    if (!database.readonly && colorPipelineIsStale(asset)) {
      const pending = recolors.get(asset.id) ?? regenerateThumbnail(asset.originalPath, asset.thumbnailPath, asset)
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
      // Read-only (the cutover freeze) writes no files; the timeline draws without tiles.
      if (database.readonly) return await readOnlyReply(reply).send({ error: READ_ONLY_MESSAGE, readOnly: true });
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
