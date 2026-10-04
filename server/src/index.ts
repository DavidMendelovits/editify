import { buildApp } from './app.js';
import { assetsRoot, buildInfo, port, rendersRoot } from './config.js';
import { binaryAvailable } from './media/process.js';
import { mkdir } from 'node:fs/promises';

await Promise.all([mkdir(assetsRoot, { recursive: true }), mkdir(rendersRoot, { recursive: true })]);
const app = await buildApp({ logger: true });
await app.listen({ port, host: '0.0.0.0' });
const { line, commit } = buildInfo();
app.log.info({ line, commit }, `editify server line ${line} at ${commit}`);

// Probing for ffmpeg spawns two processes and only ever prints a warning, so it
// runs after the bind: fly-proxy checks for a listening socket early, and a
// deploy that has not bound yet is reported as unreachable.
void Promise.all([binaryAvailable('ffmpeg'), binaryAvailable('ffprobe')]).then(([ffmpeg, ffprobe]) => {
  if (!ffmpeg || !ffprobe) {
    console.warn('WARN: Editify needs ffmpeg and ffprobe on PATH. Upload, analysis, seed, and render jobs will fail until installed.');
  }
});
