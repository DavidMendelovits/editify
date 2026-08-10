import { buildApp } from './app.js';
import { assetsRoot, port, rendersRoot } from './config.js';
import { binaryAvailable } from './media/process.js';
import { mkdir } from 'node:fs/promises';

await Promise.all([mkdir(assetsRoot, { recursive: true }), mkdir(rendersRoot, { recursive: true })]);
const [ffmpeg, ffprobe] = await Promise.all([binaryAvailable('ffmpeg'), binaryAvailable('ffprobe')]);
if (!ffmpeg || !ffprobe) {
  console.warn('⚠️  Editify needs ffmpeg and ffprobe on PATH. Upload, analysis, seed, and render jobs will fail until installed.');
}
const app = await buildApp({ logger: true });
await app.listen({ port, host: '0.0.0.0' });
