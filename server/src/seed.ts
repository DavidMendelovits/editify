import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Operation } from '@editify/shared';
import { assetsRoot } from './config.js';
import { AssetStore, type StoredAsset } from './db/asset-store.js';
import { createDatabase } from './db/database.js';
import { ProjectStore } from './db/project-store.js';
import { createProxyAndThumbnail, probeMedia, runProcess } from './media/process.js';

const database = createDatabase();
const projects = new ProjectStore(database);
const assets = new AssetStore(database);
const project = projects.create({ title: 'Editify demo cut', format: '9:16', fps: 30 });
const sources = [
  { label: 'Color bars', video: 'testsrc2=size=1080x1920:rate=30:duration=3', frequency: 330 },
  { label: 'Studio pattern', video: 'smptebars=size=1080x1920:rate=30:duration=3', frequency: 440 },
  { label: 'Motion grid', video: 'testsrc=size=1080x1920:rate=30:duration=3', frequency: 550 },
];
const operations: Operation[] = [];

for (const [index, source] of sources.entries()) {
  const id = randomUUID();
  const directory = join(assetsRoot, id);
  await mkdir(directory, { recursive: true });
  const originalPath = join(directory, 'original.mp4');
  await runProcess('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', source.video,
    '-f', 'lavfi', '-i', `sine=frequency=${source.frequency}:sample_rate=48000:duration=3`,
    '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', originalPath,
  ]);
  const probe = await probeMedia(originalPath);
  const generated = await createProxyAndThumbnail(originalPath, directory, probe);
  const asset: StoredAsset = {
    id,
    originalName: `${source.label.toLowerCase().replaceAll(' ', '-')}.mp4`,
    mimeType: 'video/mp4',
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
  };
  assets.insert(asset);
  operations.push({
    type: 'add_clip',
    params: {
      trackId: 'video-main',
      clip: {
        id: `demo-clip-${index + 1}`,
        assetId: id,
        start: index * 3,
        in: 0,
        out: 3,
        volume: index === 1 ? 0.75 : 0.9,
        speed: 1,
        transform: { scale: 1, x: 0, y: 0 },
      },
    },
  });
}

operations.push({
  type: 'add_caption',
  params: {
    trackId: 'captions',
    clip: {
      id: 'demo-caption', start: 0.5, in: 0, out: 2.2, text: 'Make the first cut count.',
      style: { font: 'Montserrat', size: 58, color: '#FFFFFF', position: 'bottom', emphasis: 'bold' },
    },
  },
});

const seeded = projects.applyOperations(project.id, operations, project.version);
console.log(`Seeded “${seeded.title}” (${seeded.id}) with ${operations.length} operations.`);
database.close();
