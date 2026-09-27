import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Clip, Project } from '@editify/shared';
import type { AssetStore, StoredAsset } from '../src/db/asset-store.js';

/**
 * The windowed render must look and sound like the single graph it replaced.
 * Both render the same small project; every cut is then compared at its first
 * and last frame (SSIM) and every join by its audio, so a clip that lands a
 * frame early, a trim that slips a sample, or a transition that loses its
 * blend shows up at the cut that broke.
 */

/** Every ffmpeg the renderers start, so the test can see the render really was split into windows. */
const launches = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = ((command: string, args: string[], options: object) => {
    if (command === 'ffmpeg') launches.push(args);
    return actual.spawn(command, args, options);
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every((binary) => spawnSync(binary, ['-version']).status === 0);
const FPS = 30;
const RATE = 48000;
/** SSIM between a frame and itself is 1; adjacent frames of testsrc2 score ~0.94, so 0.98 catches an off-by-one. */
const MIN_SSIM = 0.98;
/**
 * Joins are judged on the decoded AAC. Identical PCM encodes identically, so
 * the only slack needed is for float round-off nudging the encoder, which
 * measures around 1e-2 of the signal (-40 dB). A one-sample slip on the white
 * noise track scores ~1.4 and a lost or doubled fade far more, so 0.1 (-20 dB)
 * sits an order of magnitude from both.
 */
const MAX_AUDIO_DIFF = 0.1;

const scratch = mkdtempSync(join(tmpdir(), 'editify-render-graph-'));
// config.ts reads this at import time: the renderers are imported after it is set.
process.env.EDITIFY_DATA_DIR = scratch;

function ffmpeg(args: string[]): string {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function probeDuration(path: string): number {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  return Number(result.stdout.trim());
}

/** SSIM of one frame from each file. Seeking a quarter frame early lands on exactly that frame. */
function ssimAt(left: string, right: string, frame: number, rightFrame = frame): number {
  const at = (index: number): string => String(Math.max(0, (index - 0.25) / FPS));
  const stats = ffmpeg([
    '-ss', at(frame), '-i', left, '-ss', at(rightFrame), '-i', right,
    '-filter_complex', '[0:v]setpts=0[a];[1:v]setpts=0[b];[a][b]ssim=stats_file=-',
    '-frames:v', '1', '-f', 'null', '-',
  ]);
  const score = /All:([0-9.]+)/.exec(stats)?.[1];
  if (!score) throw new Error(`no SSIM for frame ${frame}/${rightFrame}: ${stats}`);
  return Number(score);
}

function decodeAudio(path: string): Float32Array {
  const pcm = `${path}.f32`;
  ffmpeg(['-i', path, '-map', '0:a', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', pcm]);
  const bytes = readFileSync(pcm);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** RMS of the difference over the louder side's RMS, in a 100 ms window centred on `seconds`. */
function audioDifference(left: Float32Array, right: Float32Array, seconds: number): number {
  const from = Math.max(0, Math.round((seconds - 0.05) * RATE));
  const to = Math.min(left.length, right.length, Math.round((seconds + 0.05) * RATE));
  let difference = 0;
  let leftPower = 0;
  let rightPower = 0;
  for (let index = from; index < to; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    difference += (a - b) ** 2;
    leftPower += a ** 2;
    rightPower += b ** 2;
  }
  // The floor keeps a join that is silent in both from dividing by zero.
  return Math.sqrt(difference / Math.max(leftPower, rightPower, 1e-6));
}

function asset(id: string, path: string, fields: Partial<StoredAsset>): StoredAsset {
  return {
    id, originalName: id, mimeType: 'video/mp4', duration: 8, width: 360, height: 640, fps: FPS, hasAudio: true,
    originalPath: path, proxyPath: path, thumbnailPath: path, createdAt: new Date(0).toISOString(), status: 'ready',
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '',
    ...fields,
  };
}

/** Out-of-order cuts from one source, both speed directions, both transitions, a static crop and a punch-in. */
const cuts: Clip[] = [
  { id: 'v0', assetId: 'main', start: 0, in: 5, out: 6 },
  { id: 'v1', assetId: 'main', start: 1, in: 1, out: 2, speed: 1.5 },
  { id: 'v2', assetId: 'main', start: 1.667, in: 3, out: 3.9, transition: { type: 'crossfade', duration: 0.3 } },
  // Starts on a frame fraction past one half, where rounding and truncation disagree.
  { id: 'v3', assetId: 'main', start: 2.5833, in: 6.5, out: 7.25, speed: 0.75, transition: { type: 'dip', duration: 0.4 } },
  // In point under the seek lead, so this one opens its source unseeked.
  { id: 'v4', assetId: 'main', start: 3.5833, in: 0.05, out: 0.95, transformEnd: { scale: 1.6, x: 0.2, y: -0.1 } },
  { id: 'v5', assetId: 'main', start: 4.48, in: 4.1, out: 5.05, transform: { scale: 1.3, x: -0.3, y: 0.2 } },
];
const clipEnd = (clip: Clip): number => clip.start + (clip.out - clip.in) / (clip.speed ?? 1);
const duration = Math.max(...cuts.map(clipEnd));

const project: Project = {
  id: 'graph', title: 'graph', format: '9:16', fps: FPS, duration, version: 1,
  tracks: [
    { id: 'video', kind: 'video', clips: cuts },
    {
      id: 'overlay', kind: 'overlay', clips: [
        { id: 'png', assetId: 'sticker', start: 0.5, in: 0, out: 2, overlay: { x: 0.3, y: 0.3, width: 0.2, rotation: 15 } },
        { id: 'emoji', text: '🔥', start: 2, in: 0, out: 1.5, overlay: { x: 0.7, y: 0.6, width: 0.25, rotation: 0 } },
        // B-roll across the v3/v4 cut, so the cut is judged with it on top.
        { id: 'broll', assetId: 'broll', start: 3.2, in: 0, out: 1, overlay: { x: 0.5, y: 0.5, width: 0.6, rotation: 0 } },
      ],
    },
    {
      id: 'captions', kind: 'caption', clips: [
        { id: 'cap0', text: 'Hello there', start: 0.2, in: 0, out: 1.5 },
        { id: 'cap1', text: 'Second line', start: 2.8, in: 0, out: 1.8 },
      ],
    },
    { id: 'audio', kind: 'audio', clips: [{ id: 'voice', assetId: 'voice', start: 1.2, in: 0, out: 2, duck: true }] },
  ],
};

/** The frame each cut starts on and the last frame it shows. */
function cutFrames(clip: Clip): [number, number] {
  return [Math.ceil(clip.start * FPS - 1e-6), Math.ceil(clipEnd(clip) * FPS - 1e-6) - 1];
}

describe.skipIf(!hasFfmpeg)('windowed render matches the single-graph render', () => {
  let legacyPath = '';
  let currentPath = '';
  let windowCount = 0;
  let assets: AssetStore;
  let media = '';

  beforeAll(async () => {
    media = join(scratch, 'media');
    mkdirSync(media, { recursive: true });
    const main = join(media, 'main.mp4');
    // White noise, so a one-sample slip at a join is as loud as the signal.
    ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=s=360x640:r=${FPS}:d=8`,
      '-f', 'lavfi', '-i', `anoisesrc=color=white:seed=7:amplitude=0.2:sample_rate=${RATE}:d=8`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', main,
    ]);
    const broll = join(media, 'broll.mp4');
    ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=360x640:r=${FPS}:d=4,hue=h=120`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', broll]);
    const sticker = join(media, 'sticker.png');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red@0.7:s=96x96,format=rgba', '-frames:v', '1', sticker]);
    const voice = join(media, 'voice.m4a');
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=${RATE}:d=3`, '-c:a', 'aac', '-b:a', '128k', voice]);

    const byId = new Map([
      asset('main', main, {}),
      asset('broll', broll, { duration: 4, hasAudio: false }),
      asset('sticker', sticker, { mimeType: 'image/png', duration: 0, width: 96, height: 96, hasAudio: false }),
      asset('voice', voice, { mimeType: 'audio/mp4', duration: 3, width: 0, height: 0 }),
    ].map((entry) => [entry.id, entry]));
    assets = { get: (id: string) => byId.get(id) } as unknown as AssetStore;
    const { renderProjectLegacy } = await import('./fixtures/legacy-render.js');
    const { renderProject } = await import('../src/media/render.js');
    legacyPath = await renderProjectLegacy(project, '720p', 'legacy', assets);
    launches.length = 0;
    currentPath = await renderProject(project, '720p', 'current', assets);
    windowCount = launches.filter((args) => args.includes('yuv4mpegpipe') && args.at(-1) === 'pipe:1').length;
  }, 60_000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('splits at every opaque cut and keeps the crossfade pair together', () => {
    // v0 | v1+v2 (v2 fades in over v1's borrowed tail) | v3 | v4 | v5
    expect(windowCount).toBe(5);
  });

  it('runs the same length, to within a frame', () => {
    expect(Math.abs(probeDuration(legacyPath) - probeDuration(currentPath))).toBeLessThanOrEqual(1 / FPS);
  });

  it.each(cuts.map((clip) => [clip.id, clip] as const))('shows the same first and last frame for %s', (_id, clip) => {
    const [first, last] = cutFrames(clip);
    expect(ssimAt(legacyPath, currentPath, first)).toBeGreaterThanOrEqual(MIN_SSIM);
    expect(ssimAt(legacyPath, currentPath, last)).toBeGreaterThanOrEqual(MIN_SSIM);
  });

  it('would notice a cut landing one frame off', () => {
    const [first] = cutFrames(cuts[1] as Clip);
    // The legacy frame against the next one in the new render: the check has to fail this.
    expect(ssimAt(legacyPath, currentPath, first, first + 1)).toBeLessThan(MIN_SSIM);
  });

  it('sounds the same around every join', () => {
    const legacy = decodeAudio(legacyPath);
    const current = decodeAudio(currentPath);
    const joins = [...cuts.map((clip) => clip.start), ...cuts.map(clipEnd), 1.2, 3.2];
    // Keyed by join time, so a failure names the join that moved.
    const differences = Object.fromEntries(joins.map((at) => [at.toFixed(3), audioDifference(legacy, current, at)]));
    for (const [at, difference] of Object.entries(differences)) {
      expect(difference, `audio at ${at}s`).toBeLessThanOrEqual(MAX_AUDIO_DIFF);
    }
  });

  it('keeps an HDR master and an SDR tone map the same through the windows', async () => {
    // PQ-tagged 10-bit HEVC, like an iPhone HDR clip: the HDR export takes the
    // 10-bit path end to end, the SDR one tone maps.
    const pq = join(media, 'pq.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=s=360x640:r=${FPS}:d=4`,
      '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv,format=yuv420p10le',
      '-c:v', 'libx265', '-x265-params', 'log-level=error',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv', pq,
    ]);
    const hdrAsset = asset('pq', pq, { duration: 4, hasAudio: false });
    const hdrAssets = { get: () => hdrAsset } as unknown as AssetStore;
    const hdrCuts: Clip[] = [
      { id: 'h0', assetId: 'pq', start: 0, in: 2, out: 3 },
      { id: 'h1', assetId: 'pq', start: 1, in: 0.5, out: 1.5, transition: { type: 'crossfade', duration: 0.3 } },
      { id: 'h2', assetId: 'pq', start: 2, in: 3, out: 3.8 },
    ];
    const hdrProject: Project = {
      ...project, id: 'hdr', duration: 2.8,
      tracks: [{ id: 'video', kind: 'video', clips: hdrCuts }, project.tracks[2] as Project['tracks'][number]],
    };
    const { renderProjectLegacy } = await import('./fixtures/legacy-render.js');
    const { renderProject } = await import('../src/media/render.js');
    for (const hdr of ['hdr', 'sdr'] as const) {
      const legacy = await renderProjectLegacy(hdrProject, '720p', `legacy-${hdr}`, hdrAssets, hdr);
      const current = await renderProject(hdrProject, '720p', `current-${hdr}`, hdrAssets, hdr);
      for (const clip of hdrCuts) {
        for (const frame of cutFrames(clip)) {
          expect(ssimAt(legacy, current, frame), `${hdr} ${clip.id} frame ${frame}`).toBeGreaterThanOrEqual(MIN_SSIM);
        }
      }
    }
  }, 30_000);
});
