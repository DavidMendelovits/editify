import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Operation } from '@editify/shared';
import { assetsRoot, mediaImportDir } from './config.js';
import { AssetStore, type StoredAsset } from './db/asset-store.js';
import { createDatabase } from './db/database.js';
import { ProjectStore } from './db/project-store.js';
import { TranscriptStore } from './db/transcript-store.js';
import { createProxyAndThumbnail, probeMedia } from './media/process.js';
import { TranscriptService } from './services/transcript-service.js';

// Seeds from REAL footage in MEDIA_IMPORT_DIR — no generated placeholder media, ever.
const SEED_CLIPS = ['deli-baby.mov', 'laugh1.mov', 'manofmydreams.mov', 'spittake.mov'];

const database = createDatabase();
const projects = new ProjectStore(database);
const assets = new AssetStore(database);
const transcripts = new TranscriptService(new TranscriptStore(database));

const mimeTypes: Record<string, string> = { '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v' };
const operations: Operation[] = [];
let start = 0;

for (const [index, name] of SEED_CLIPS.entries()) {
  const originalPath = join(mediaImportDir, name);
  const existing = assets.list().find((asset) => asset.originalName === name);
  let asset: StoredAsset;
  if (existing) {
    asset = existing;
  } else {
    const id = randomUUID();
    const directory = join(assetsRoot, id);
    await mkdir(directory, { recursive: true });
    const probe = await probeMedia(originalPath);
    const generated = await createProxyAndThumbnail(originalPath, directory, probe);
    asset = assets.insert({
      id,
      originalName: name,
      mimeType: mimeTypes[extname(name).toLowerCase()] ?? 'video/mp4',
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      originalPath,
      proxyPath: generated.proxyPath,
      thumbnailPath: generated.thumbnailPath,
      originalUrl: `/assets/${id}/original`,
      proxyUrl: `/assets/${id}/proxy.mp4`,
      thumbnailUrl: `/assets/${id}/thumb.jpg`,
      createdAt: new Date().toISOString(),
    });
  }
  if (asset.hasAudio) {
    try {
      await transcripts.transcribe(asset);
      console.log(`Transcribed ${name}`);
    } catch (error) {
      console.warn(`Transcription failed for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  operations.push({
    type: 'add_clip',
    params: {
      trackId: 'video-main',
      clip: { id: `demo-clip-${index + 1}`, assetId: asset.id, start, in: 0, out: asset.duration, volume: 1, speed: 1 },
    },
  });
  start += asset.duration;
}

const project = projects.create({ title: 'Comedy reel', format: '9:16', fps: 30 });
const seeded = projects.applyOperations(project.id, operations, project.version);
console.log(`Seeded “${seeded.title}” (${seeded.id}) from ${SEED_CLIPS.length} real clips, ${Math.round(seeded.duration)}s total.`);
database.close();
