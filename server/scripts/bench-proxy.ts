/**
 * Proxy encode benchmark: where do the seconds go turning a 4K HLG phone clip
 * into the 540p preview proxy? Each variant changes one thing; SSIM against
 * today's proxy (first 60s) keeps a fast variant from quietly looking worse.
 *
 *   npx tsx scripts/bench-proxy.ts <source.mov> [outDir]
 *
 *   current        normalize (HLG->SDR tonemap) at 4K, then scale, libx264   <- createProxyAndThumbnail today
 *   scale-first    scale to 540 first, tonemap the small frames, libx264
 *   +hwdec         scale-first with VideoToolbox decode (macOS only)
 *   +hwenc         +hwdec with h264_videotoolbox encode (macOS only)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeFilter, outputColorArgs, outputColorFilter, probeColor, zscaleAvailable } from '../src/media/color.js';

const source = resolve(process.argv[2] ?? '');
const out = resolve(process.argv[3] ?? 'data/bench-proxy');
mkdirSync(out, { recursive: true });

const color = await probeColor(source);
const normalize = normalizeFilter(color, 'sdr', { zscale: await zscaleAvailable() });
const scale = 'scale=540:540:force_original_aspect_ratio=decrease:force_divisible_by=2';
const tag = outputColorFilter('sdr', false);
const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27'];
const vt = ['-c:v', 'h264_videotoolbox', '-b:v', '1200k'];
const tail = (encoder: string[], file: string) => [
  ...encoder, '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', ...outputColorArgs('sdr', false),
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', join(out, file),
];

const variants: Array<{ name: string; file: string; args: string[] }> = [
  { name: 'current', file: 'current.mp4', args: ['-y', '-i', source, '-vf', `${normalize},${scale},${tag}`, ...tail(x264, 'current.mp4')] },
  { name: 'scale-first', file: 'scale-first.mp4', args: ['-y', '-i', source, '-vf', `${scale},${normalize},${tag}`, ...tail(x264, 'scale-first.mp4')] },
  { name: '+hwdec', file: 'hwdec.mp4', args: ['-y', '-hwaccel', 'videotoolbox', '-i', source, '-vf', `${scale},${normalize},${tag}`, ...tail(x264, 'hwdec.mp4')] },
  { name: '+hwenc', file: 'hwenc.mp4', args: ['-y', '-hwaccel', 'videotoolbox', '-i', source, '-vf', `${scale},${normalize},${tag}`, ...tail(vt, 'hwenc.mp4')] },
];

function ssim(file: string): string {
  const run = spawnSync('ffmpeg', ['-v', 'info', '-t', '60', '-i', join(out, file), '-t', '60', '-i', join(out, 'current.mp4'), '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
  return /All:([\d.]+)/.exec(run.stderr)?.[1] ?? '?';
}

console.log(`source ${source}\nnormalize: ${normalize}\n`);
console.log('| variant | seconds | x realtime | size MB | SSIM vs current (60s) |\n|---|---|---|---|---|');
const duration = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source], { encoding: 'utf8' }).stdout);
for (const variant of variants) {
  const start = performance.now();
  const run = spawnSync('ffmpeg', ['-v', 'error', ...variant.args], { encoding: 'utf8' });
  const seconds = (performance.now() - start) / 1000;
  if (run.status !== 0) { console.log(`| ${variant.name} | failed | | | ${run.stderr.slice(-160).replace(/\n/g, ' ')} |`); continue; }
  const mb = statSync(join(out, variant.file)).size / 1e6;
  console.log(`| ${variant.name} | ${seconds.toFixed(1)} | ${(duration / seconds).toFixed(1)}x | ${mb.toFixed(1)} | ${variant.name === 'current' ? '1 (reference)' : ssim(variant.file)} |`);
}
