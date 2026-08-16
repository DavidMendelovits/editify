import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AssetMetadata } from '@editify/shared';
import { z } from 'zod';
import type { AssetStore, StoredAsset } from '../db/asset-store.js';
import type { ProjectStore } from '../db/project-store.js';
import { assetsRoot, mediaImportDir } from '../config.js';
import { createFilmstrip, createProxyAndThumbnail, probeMedia, type ProbeResult } from '../media/process.js';
import { sendMediaFile } from '../media/send-file.js';
import type { InsightService } from '../services/insight-service.js';
import type { TranscriptService } from '../services/transcript-service.js';

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

/**
 * Background work per asset id: proxy, thumbnail and transcription. Imports do
 * not wait for it — the row is already in the library, marked `processing`.
 * Exposed so tests can await an import deterministically.
 */
export const pendingAssetWork = new Map<string, Promise<void>>();

/** Runs after the import responded, and moves the row to `ready` or `error`. */
function queueAssetWork(
  app: FastifyInstance,
  assets: AssetStore,
  transcripts: TranscriptService,
  asset: StoredAsset,
  probe: ProbeResult,
): void {
  const pending = (async () => {
    try {
      const generated = await createProxyAndThumbnail(asset.originalPath, dirname(asset.proxyPath), probe);
      assets.setStatus(asset.id, 'ready', generated);
    } catch (error) {
      assets.setStatus(asset.id, 'error');
      app.log.error({ err: error, assetId: asset.id }, 'Asset proxy generation failed');
      return;
    }
    await transcribeQuietly(app, transcripts, asset);
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
): Promise<StoredAsset> {
  const directory = join(assetsRoot, id);
  await mkdir(directory, { recursive: true });
  try {
    const probe = await probeMedia(input.originalPath);
    if (!probe.hasVideo && !probe.hasAudio) throw new Error('The media file has no video or audio streams');
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
    });
    queueAssetWork(app, assets, transcripts, asset, probe);
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
): void {
  /** Reads `?projectId=` and refuses ids that do not exist, so links cannot dangle. */
  function requireProject(id: unknown, reply: FastifyReply): string | undefined | null {
    if (id === undefined || id === '') return undefined;
    const projectId = String(id);
    if (!projects.get(projectId)) {
      void reply.code(404).send({ error: 'Project not found' });
      return null;
    }
    return projectId;
  }

  app.post<{ Querystring: { projectId?: string } }>('/assets', async (request, reply) => {
    const projectId = requireProject(request.query.projectId, reply);
    if (projectId === null) return reply;
    const part = await request.file({ limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });
    if (!part) return await reply.code(400).send({ error: 'A multipart media file is required' });
    if (!part.mimetype.startsWith('video/') && !part.mimetype.startsWith('audio/') && part.mimetype !== 'application/octet-stream') {
      part.file.resume();
      return await reply.code(415).send({ error: 'Only video and audio files are supported' });
    }
    const id = randomUUID();
    const directory = join(assetsRoot, id);
    await mkdir(directory, { recursive: true });
    const extension = extname(part.filename).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12) || '.media';
    const originalPath = join(directory, `original${extension}`);
    try {
      await pipeline(part.file, (await import('node:fs')).createWriteStream(originalPath));
      const asset = await processAsset(app, assets, transcripts, {
        originalName: part.filename,
        mimeType: part.mimetype,
        originalPath,
      }, id);
      if (projectId) assets.link(projectId, asset.id);
      return await reply.code(201).send(publicAsset(asset));
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  });

  // The media library. With `?projectId=` it is scoped to that project's own
  // imports; without it, every asset on the server, for the "all clips" browser.
  // Newest first either way.
  app.get<{ Querystring: { projectId?: string } }>('/assets', async (request, reply) => {
    const projectId = requireProject(request.query.projectId, reply);
    if (projectId === null) return reply;
    const list = projectId ? assets.listForProject(projectId) : assets.list();
    return list.reverse().map(publicAsset);
  });

  // Pull an asset from another project into this one — the only way media
  // crosses a project boundary, and always because the user asked for it.
  app.post<{ Params: { id: string } }>('/assets/:id/link', async (request, reply) => {
    const projectId = requireProject(linkRequestSchema.parse(request.body).projectId, reply);
    if (projectId === null) return reply;
    if (!projectId) return await reply.code(400).send({ error: 'projectId is required' });
    const asset = assets.get(request.params.id);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    assets.link(projectId, asset.id);
    return publicAsset(asset);
  });

  app.patch<{ Params: { id: string } }>('/assets/:id', async (request, reply) => {
    const { label } = labelRequestSchema.parse(request.body);
    const updated = assets.setLabel(request.params.id, label);
    return updated ? publicAsset(updated) : await reply.code(404).send({ error: 'Asset not found' });
  });

  app.get('/assets/importable', async () => {
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
        alreadyImported: Boolean(assets.getByOriginalName(entry.name)),
      })));
    return importable;
  });

  app.post('/assets/import', async (request, reply) => {
    const { name, projectId: requestedProject } = importRequestSchema.parse(request.body);
    const projectId = requireProject(requestedProject, reply);
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
    const existing = assets.getByOriginalName(name);
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
    });
    if (projectId) assets.link(projectId, asset.id);
    return await reply.code(201).send(publicAsset(asset));
  });

  app.get<{ Params: { id: string } }>('/assets/:id/transcript', async (request, reply) => {
    if (!assets.get(request.params.id)) return await reply.code(404).send({ error: 'Asset not found' });
    return transcripts.get(request.params.id) ?? await reply.code(404).send({ error: 'No transcript' });
  });

  app.post<{ Params: { id: string } }>('/assets/:id/transcribe', async (request, reply) => {
    const asset = assets.get(request.params.id);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    if (!asset.hasAudio) return await reply.code(422).send({ error: 'Asset has no audio' });
    const { force } = forceRequestSchema.parse(request.body ?? {});
    return await transcripts.transcribe(asset, force);
  });

  app.get<{ Params: { id: string } }>('/assets/:id/insights', async (request, reply) => {
    const asset = assets.get(request.params.id);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    const result = await insights.getOrCreate(asset);
    return result ?? await reply.code(404).send({ error: 'No transcript' });
  });

  app.post<{ Params: { id: string } }>('/assets/:id/insights', async (request, reply) => {
    const asset = assets.get(request.params.id);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    const { force } = forceRequestSchema.parse(request.body ?? {});
    const result = await insights.getOrCreate(asset, force);
    return result ?? await reply.code(404).send({ error: 'No transcript' });
  });

  app.get<{ Params: { id: string } }>('/assets/:id', async (request, reply) => {
    const asset = assets.get(request.params.id);
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
    const asset = assets.get(request.params.id);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    if (!existsSync(asset.proxyPath)) return notReady(reply, asset);
    return await sendFile(reply, asset.proxyPath, 'video/mp4', request.headers.range);
  });

  app.get<{ Params: { id: string } }>('/assets/:id/thumb.jpg', async (request, reply) => {
    const asset = assets.get(request.params.id);
    if (!asset) return await reply.code(404).send({ error: 'Asset not found' });
    if (!existsSync(asset.thumbnailPath)) return notReady(reply, asset);
    return await sendFile(reply, asset.thumbnailPath, 'image/jpeg', request.headers.range);
  });

  // Lazily generated and cached beside the proxy: 20 tiles, left to right over [0, duration].
  // Clients map clip.in/clip.out to tile offsets; in-flight generations are shared so a burst
  // of timeline requests spawns one ffmpeg per asset.
  const filmstrips = new Map<string, Promise<string>>();
  app.get<{ Params: { id: string } }>('/assets/:id/filmstrip.jpg', async (request, reply) => {
    const asset = assets.get(request.params.id);
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
    const asset = assets.get(request.params.id);
    return asset ? await sendFile(reply, asset.originalPath, asset.mimeType, request.headers.range) : await reply.code(404).send({ error: 'Asset not found' });
  });
}
