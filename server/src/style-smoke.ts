/**
 * Runs the learn-my-style pipeline against real video files with the analyzer
 * the environment would pick, without a server or a database on disk. The
 * end-to-end check for a new analyzer or a fresh API key:
 *
 *   GEMINI_API_KEY=... npm run style:smoke -- path/to/clip.mp4 [more.mp4 ...]
 *   npm run style:smoke -- --analyzer webhook clip.mp4
 *   npm run style:smoke -- --no-distill clip.mp4      (skip the chat provider)
 *
 * Prints every stage, each observation, the template, and the brief as JSON.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ProviderRegistry } from './agent/registry.js';
import { AgentService } from './agent/service.js';
import type { StoredAsset } from './db/asset-store.js';
import { createDatabase } from './db/database.js';
import { SettingsStore } from './db/settings-store.js';
import { probeMedia } from './media/process.js';
import { runStylePipeline } from './style/pipeline.js';
import { StyleAnalyzerRegistry } from './style/registry.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const analyzerId = flag('analyzer');
const distill = !args.includes('--no-distill');
const files = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--analyzer');

if (files.length === 0) {
  console.error('Usage: npm run style:smoke -- [--analyzer id] [--no-distill] clip.mp4 [more.mp4 ...]');
  process.exit(1);
}

const database = createDatabase(':memory:');
const settings = new SettingsStore(database);
const analyzers = new StyleAnalyzerRegistry(settings);
const status = await analyzers.status();
console.error('analyzers:', status.options.map((option) => `${option.id}${option.available ? '' : ' (unavailable: ' + option.detail + ')'}`).join(', '));
const analyzer = analyzerId ? analyzers.get(analyzerId) : await analyzers.resolve();
if (!analyzer) { console.error(`Unknown analyzer ${analyzerId}`); process.exit(1); }
const availability = await analyzer.availability();
if (!availability.available) { console.error(`${analyzer.id} is not available: ${availability.detail}`); process.exit(1); }
console.error(`using ${analyzer.id} (${availability.detail})`);

const videos: StoredAsset[] = [];
for (const file of files) {
  const path = resolve(file);
  if (!existsSync(path)) { console.error(`No such file: ${path}`); process.exit(1); }
  const probe = await probeMedia(path);
  videos.push({
    id: randomUUID(), originalName: basename(path), mimeType: mimeFor(path), duration: probe.duration, width: probe.width,
    height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio, originalPath: path, proxyPath: path, thumbnailPath: path,
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date().toISOString(), status: 'ready',
  });
}

const agent = new AgentService(async () => await new ProviderRegistry(settings).resolve());
const started = Date.now();
const result = await runStylePipeline({
  videos,
  analyzer,
  ...(distill ? { distill: async (template, observations) => await agent.distillStyle(
    { id: 'smoke', title: 'Style smoke', format: template.format, fps: 30, duration: 0, version: 0, tracks: [] },
    template, observations, template.watchedCount > 0,
  ) } : {}),
  onProgress: ({ stage, done, total }) => console.error(`${stage} ${done}/${total}`),
});
console.error(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(JSON.stringify({ analyzer: result.analyzer, observations: result.observations, template: result.template, styleDoc: result.styleDoc }, null, 2));
database.close();

function mimeFor(path: string): string {
  const extension = path.toLowerCase().split('.').pop();
  return extension === 'mov' ? 'video/quicktime' : extension === 'webm' ? 'video/webm' : 'video/mp4';
}
