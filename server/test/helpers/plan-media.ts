import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BT2020_TO_BT709, multiply3, sdrEncode } from '../../src/media/plan/color.js';

/*
 * The parity harness's synthetic media (apps/mobile/modules/editify-engine/
 * parity/render-golden/main.swift, `Pattern` and the write* functions), made
 * with ffmpeg so the server render can draw the same plans over the same
 * pictures and sounds:
 *
 * - Video: the base colour, a grey grid in the lower area, four linear
 *   patches (white 1.0, grey 0.18, colour (0.6, 0.25, 0.05), highlight 2.0),
 *   and the frame index as an 8-bit code strip, all in linear BT.2020 at the
 *   203-nit scale, encoded per the media's transfer: SDR through BT.709
 *   primaries and the 1.961 power law (what Core Video decodes 709-tagged
 *   video with, so the harness's SDR file holds the same code values), HLG
 *   and PQ through zscale (npl 203). Lossless H.264 / HEVC instead of the
 *   harness's 24 Mb/s H.264 / HEVC Main10, so compression noise is not part
 *   of the parity numbers. A 0.25-amplitude stereo tone when `toneHz` is set.
 * - Audio: 0.25-amplitude tones, one per channel (5.1 in L R C LFE Ls Rs).
 * - PNG: the 100 x 160 logo (top half red, bottom half blue, a white 40 px
 *   square top-left) stored turned back by its EXIF orientation, with an eXIf
 *   chunk; or a solid colour.
 * - GIF: solid frames with the manifest's delays (0, 5, 10, 1 cs), written by
 *   ffmpeg and then given those exact delays in their Graphic Control blocks.
 */

export interface MediaSpec {
  kind: 'video' | 'audio' | 'png' | 'gif';
  transfer?: 'sdr' | 'hlg' | 'pq';
  w?: number;
  h?: number;
  fps?: number;
  seconds?: number;
  base?: number[];
  toneHz?: number;
  orientation?: number;
  frames?: Array<{ rgb: number[]; delayCs: number }>;
  channelTones?: number[];
  solid?: number[];
}

function run(args: string[], input?: Buffer): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { input, maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${result.stderr?.toString()}`);
}

const PATCHES: Array<{ x: number; y: number; w: number; h: number; v: number[] }> = [
  { x: 20, y: 80, w: 100, h: 100, v: [1, 1, 1] },
  { x: 140, y: 80, w: 100, h: 100, v: [0.18, 0.18, 0.18] },
  { x: 260, y: 80, w: 80, h: 100, v: [0.6, 0.25, 0.05] },
  { x: 20, y: 200, w: 100, h: 100, v: [2, 2, 2] },
];

/** One frame of the pattern as linear BT.2020 RGB (row-major, 3 floats a pixel). */
function patternFrame(index: number, width: number, height: number, base: number[], out: Float32Array): void {
  const s = width / 360;
  const fill = (x: number, y: number, w: number, h: number, v: number[]): void => {
    const x0 = Math.max(0, Math.round(x * s));
    const y0 = Math.max(0, Math.round(y * s));
    const x1 = Math.min(width, Math.round((x + w) * s));
    const y1 = Math.min(height, Math.round((y + h) * s));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        const at = (yy * width + xx) * 3;
        out[at] = v[0]!;
        out[at + 1] = v[1]!;
        out[at + 2] = v[2]!;
      }
    }
  };
  const tall = height / s;
  fill(0, 0, 360, tall, base);
  for (let x = 60; x < 360; x += 60) fill(x - 1, 320, 2, tall - 320, [0.5, 0.5, 0.5]);
  for (let y = 320; y < tall; y += 80) fill(0, y - 1, 360, 2, [0.5, 0.5, 0.5]);
  for (const patch of PATCHES) fill(patch.x, patch.y, patch.w, patch.h, patch.v);
  const block = 360 / 8;
  for (let bit = 0; bit < 8; bit += 1) {
    const on = ((index >> (7 - bit)) & 1) === 1;
    fill(bit * block, 0, block, 40, on ? [1, 1, 1] : [0, 0, 0]);
  }
}

/** Planar gbrpf32le bytes of an interleaved RGB frame, after `map` per pixel. */
function planar(rgb: Float32Array, map: (pixel: [number, number, number]) => [number, number, number]): Buffer {
  const count = rgb.length / 3;
  const planes = new Float32Array(rgb.length);
  for (let index = 0; index < count; index += 1) {
    const [r, g, b] = map([rgb[index * 3]!, rgb[index * 3 + 1]!, rgb[index * 3 + 2]!]);
    planes[index] = g;
    planes[count + index] = b;
    planes[2 * count + index] = r;
  }
  return Buffer.from(planes.buffer);
}

async function pipeFrames(args: string[], frames: number, frameAt: (index: number) => Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${stderr}`))));
    child.stdin.on('error', () => undefined);
    (async () => {
      for (let index = 0; index < frames; index += 1) {
        if (!child.stdin.write(frameAt(index))) await new Promise((done) => child.stdin.once('drain', done));
      }
      child.stdin.end();
    })().catch(reject);
  });
}

export async function writeVideo(spec: MediaSpec, path: string): Promise<void> {
  const width = spec.w ?? 360;
  const height = spec.h ?? 640;
  const fps = spec.fps ?? 30;
  const seconds = spec.seconds ?? 8;
  const frames = Math.round(seconds * fps);
  const transfer = spec.transfer ?? 'sdr';
  const rgb = new Float32Array(width * height * 3);
  const sdrPixel = (pixel: [number, number, number]): [number, number, number] =>
    multiply3(BT2020_TO_BT709, pixel).map((value) => sdrEncode(Math.min(1, Math.max(0, value)))) as [number, number, number];
  const map = transfer === 'sdr' ? sdrPixel : (pixel: [number, number, number]): [number, number, number] => pixel;
  // Frames differ only in the code strip (the top 40 rows at 360 wide): convert the pattern once, patch the strip.
  patternFrame(0, width, height, spec.base ?? [0.1, 0.1, 0.1], rgb);
  const frame = planar(rgb, map);
  const stripRows = Math.min(height, Math.round(40 * (width / 360)));
  const count = width * height;
  const on = map([1, 1, 1]);
  const off = map([0, 0, 0]);
  const planes = new Float32Array(frame.buffer, frame.byteOffset, count * 3);
  const frameAt = (index: number): Buffer => {
    const block = width / 8;
    for (let y = 0; y < stripRows; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const bit = Math.min(7, Math.floor(x / block));
        const value = ((index >> (7 - bit)) & 1) === 1 ? on : off;
        const at = y * width + x;
        planes[at] = value[1];
        planes[count + at] = value[2];
        planes[2 * count + at] = value[0];
      }
    }
    return Buffer.from(frame);
  };
  const audio = spec.toneHz
    ? ['-f', 'lavfi', '-i', `aevalsrc=0.25*sin(2*PI*${spec.toneHz}*t)|0.25*sin(2*PI*${spec.toneHz}*t):s=48000:d=${seconds}`]
    : [];
  const input = ['-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0', ...audio];
  const audioOut = spec.toneHz ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : [];
  if (transfer === 'sdr') {
    await pipeFrames([
      ...input, '-vf', 'zscale=rin=full:pin=709:tin=709:p=709:t=709:m=709:r=limited,format=yuv420p',
      '-c:v', 'libx264', '-qp', '0', '-g', '10', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      ...audioOut, '-shortest', path,
    ], frames, frameAt);
    return;
  }
  const trc = transfer === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  await pipeFrames([
    ...input, '-vf', `zscale=rin=full:pin=2020:tin=linear:npl=203:p=2020:t=${trc}:m=2020_ncl:r=limited,format=yuv420p10le`,
    '-c:v', 'libx265', '-x265-params', `lossless=1:keyint=10:colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc:range=limited:log-level=error`,
    '-tag:v', 'hvc1', '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', trc, '-color_range', 'tv',
    ...audioOut, '-shortest', path,
  ], frames, frameAt);
}

export function writeAudio(spec: MediaSpec, path: string): void {
  const seconds = spec.seconds ?? 8;
  const tones = spec.channelTones ?? [spec.toneHz ?? 440, spec.toneHz ?? 440];
  const exprs = tones.map((hz) => `0.25*sin(2*PI*${hz}*t)`).join('|');
  const layout = tones.length === 6 ? ':c=5.1(side)' : tones.length === 2 ? ':c=stereo' : '';
  run(['-f', 'lavfi', '-i', `aevalsrc=${exprs}:s=48000:d=${seconds}${layout}`, '-c:a', 'aac', '-b:a', tones.length === 6 ? '384k' : '192k', path]);
}

/** A PNG chunk with its CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** Inserts an eXIf chunk carrying `orientation` after IHDR. */
function withExifOrientation(png: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk('eXIf', tiff), png.subarray(ihdrEnd)]);
}

export function writePng(spec: MediaSpec, path: string): void {
  if (spec.solid) {
    const w = spec.w ?? 100;
    const h = spec.h ?? 100;
    const pixel = spec.solid.map((value) => Math.round(value * 255));
    const raw = Buffer.alloc(w * h * 3);
    for (let at = 0; at < w * h; at += 1) raw.set(pixel, at * 3);
    run(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1', path], raw);
    return;
  }
  // Upright 100 x 160: top half red, bottom half blue, white 40 px square top-left.
  const w = 100;
  const h = 160;
  const upright = (x: number, y: number): number[] => {
    if (x < 40 && y < 40) return [255, 255, 255];
    return y < h / 2 ? [255, 26, 26] : [0, 51, 255];
  };
  const orientation = spec.orientation ?? 1;
  // Stored pixels: the upright image turned back by the inverse of the orientation (6: stored turned 90 counter-clockwise).
  const quarter = orientation === 6 || orientation === 8;
  const sw = quarter ? h : w;
  const sh = quarter ? w : h;
  const raw = Buffer.alloc(sw * sh * 3);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      // Viewing applies `orientation` to the stored image; find the upright pixel each stored pixel becomes.
      let ux = x;
      let uy = y;
      if (orientation === 6) { ux = sh - 1 - y; uy = x; }
      if (orientation === 8) { ux = y; uy = sw - 1 - x; }
      if (orientation === 3) { ux = sw - 1 - x; uy = sh - 1 - y; }
      raw.set(upright(ux, uy), (y * sw + x) * 3);
    }
  }
  const tmp = `${path}.plain.png`;
  run(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${sw}x${sh}`, '-i', 'pipe:0', '-frames:v', '1', tmp], raw);
  writeFileSync(path, orientation === 1 ? readFileSync(tmp) : withExifOrientation(readFileSync(tmp), orientation));
}

export function writeGif(spec: MediaSpec, path: string): void {
  const frames = spec.frames ?? [];
  const w = spec.w ?? 120;
  const h = spec.h ?? 90;
  const raw = Buffer.alloc(w * h * 3 * frames.length);
  frames.forEach((frame, index) => {
    const pixel = frame.rgb.map((value) => Math.round(value * 255));
    for (let at = 0; at < w * h; at += 1) raw.set(pixel, (index * w * h + at) * 3);
  });
  run(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', '10', '-i', 'pipe:0', '-pix_fmt', 'rgb8', '-gifflags', '0', '-loop', '0', '-f', 'gif', path], raw);
  // Patch each Graphic Control Extension (21 F9 04 packed delayLo delayHi transp 00) to the manifest's delay.
  const gif = readFileSync(path);
  let frame = 0;
  for (let at = 0; at + 7 < gif.length && frame < frames.length; at += 1) {
    if (gif[at] === 0x21 && gif[at + 1] === 0xf9 && gif[at + 2] === 0x04 && gif[at + 7] === 0x00) {
      gif.writeUInt16LE(frames[frame]!.delayCs, at + 4);
      frame += 1;
      at += 7;
    }
  }
  if (frame !== frames.length) throw new Error(`patched ${frame} of ${frames.length} GIF delays`);
  writeFileSync(path, gif);
}

/** Writes every medium in `specs` into `directory`; returns id -> path. */
export async function synthesizeMedia(specs: Record<string, MediaSpec>, directory: string, only?: ReadonlySet<string>): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  for (const [id, spec] of Object.entries(specs)) {
    if (only && !only.has(id)) continue;
    const extension = { video: 'mp4', audio: 'm4a', png: 'png', gif: 'gif' }[spec.kind];
    const path = join(directory, `${id}.${extension}`);
    if (spec.kind === 'video') await writeVideo(spec, path);
    else if (spec.kind === 'audio') writeAudio(spec, path);
    else if (spec.kind === 'png') writePng(spec, path);
    else writeGif(spec, path);
    paths.set(id, path);
  }
  return paths;
}
