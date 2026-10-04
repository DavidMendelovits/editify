import { buildApp } from './app.js';
import { assetsRoot, buildInfo, port, rendersRoot } from './config.js';
import { createDatabase } from './db/database.js';
import { binaryAvailable } from './media/process.js';
import { readOnlyFromEnv } from './read-only.js';
import { installShutdownHandlers } from './shutdown.js';
import { mkdir } from 'node:fs/promises';

await Promise.all([mkdir(assetsRoot, { recursive: true }), mkdir(rendersRoot, { recursive: true })]);
const readOnly = readOnlyFromEnv();
// Opened here rather than inside buildApp so the shutdown handler can still
// checkpoint and close it when a request outlives the grace period.
const database = createDatabase(undefined, { readonly: readOnly });
const app = await buildApp({ logger: true, database, readOnly });
// Fly stops a machine with SIGINT (SIGKILL 5s later); local tools send SIGTERM.
installShutdownHandlers({
  app,
  database,
  graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 3_000),
  log: (line) => app.log.info(line),
});
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
