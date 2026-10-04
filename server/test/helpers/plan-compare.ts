import { spawnSync } from 'node:child_process';
import { BT709_TO_BT2020, multiply3, sdrDecode } from '../../src/media/plan/color.js';

/*
 * Reading rendered frames the way the native golden harness writes them: the
 * ENCODED R'G'B' values (8-bit for SDR, 16-bit for HLG), no transfer
 * conversion, compared with the goldens by the harness's own metrics
 * (per-channel mean absolute difference, and the maximum of the 5 x 5
 * box-blurred per-pixel worst-channel difference).
 */

export interface Picture { width: number; height: number; rgb: Float32Array }

function ffmpegRaw(args: string[]): Buffer {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', ...args], { maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${result.stderr?.toString()}`);
  return result.stdout;
}

function toPicture(raw: Buffer, width: number, height: number, sixteen: boolean): Picture {
  const rgb = new Float32Array(width * height * 3);
  for (let index = 0; index < rgb.length; index += 1) {
    rgb[index] = sixteen ? raw.readUInt16LE(index * 2) / 65535 : raw[index]! / 255;
  }
  return { width, height, rgb };
}

/** Frame k of a rendered file as encoded R'G'B' (Y'CbCr decoded with the file's own matrix, full range). */
export function decodeFrame(path: string, k: number, size: { w: number; h: number }, hlg: boolean): Picture {
  const matrix = hlg ? '2020_ncl' : '709';
  const raw = ffmpegRaw([
    '-i', path, '-vf', `select='eq(n\\,${k})',zscale=min=${matrix}:rin=limited:r=full,format=${hlg ? 'rgb48le' : 'rgb24'}`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ]);
  return toPicture(raw, size.w, size.h, hlg);
}

/** Frame k of an HLG file decoded to linear BT.2020 (1.0 = 203 cd/m2) by zscale, the inverse of the encode. */
export function decodeLinearHlg(path: string, k: number, size: { w: number; h: number }): Picture {
  const raw = ffmpegRaw([
    '-i', path, '-vf', `select='eq(n\\,${k})',zscale=min=2020_ncl:rin=limited:tin=arib-std-b67:pin=2020:t=linear:p=2020:npl=203:r=full,format=gbrpf32le`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ]);
  const planes = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const count = size.w * size.h;
  const rgb = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    rgb[index * 3] = planes[2 * count + index]!;
    rgb[index * 3 + 1] = planes[index]!;
    rgb[index * 3 + 2] = planes[count + index]!;
  }
  return { width: size.w, height: size.h, rgb };
}

export function readPng(path: string): Picture {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', path], { encoding: 'utf8' });
  const stream = (JSON.parse(probe.stdout) as { streams: Array<{ width: number; height: number; pix_fmt: string }> }).streams[0]!;
  const sixteen = stream.pix_fmt.includes('48') || stream.pix_fmt.includes('64');
  const raw = ffmpegRaw(['-i', path, '-f', 'rawvideo', '-pix_fmt', sixteen ? 'rgb48le' : 'rgb24', 'pipe:1']);
  return toPicture(raw, stream.width, stream.height, sixteen);
}

/** Averages `factor` x `factor` blocks (the harness's downscale for 1080 x 1920 goldens). */
export function downscale(picture: Picture, factor: number): Picture {
  if (factor === 1) return picture;
  const width = Math.floor(picture.width / factor);
  const height = Math.floor(picture.height / factor);
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy += 1) for (let dx = 0; dx < factor; dx += 1) sum += picture.rgb[((y * factor + dy) * picture.width + x * factor + dx) * 3 + c]!;
        rgb[(y * width + x) * 3 + c] = sum / (factor * factor);
      }
    }
  }
  return { width, height, rgb };
}

/** Quantizes to the golden's bit depth, as the harness's PNG writer does. */
export function quantize(picture: Picture, sixteen: boolean): Picture {
  const levels = sixteen ? 65535 : 255;
  return { ...picture, rgb: picture.rgb.map((value) => Math.round(Math.min(1, Math.max(0, value)) * levels) / levels) };
}

export interface Comparison { meanAbs: [number, number, number]; blurredMax: number; maxAbs: number }

export function compare(a: Picture, b: Picture): Comparison {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const count = a.width * a.height;
  const mean = [0, 0, 0];
  const worst = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    let most = 0;
    for (let c = 0; c < 3; c += 1) {
      const difference = Math.abs(a.rgb[index * 3 + c]! - b.rgb[index * 3 + c]!);
      mean[c]! += difference;
      most = Math.max(most, difference);
    }
    worst[index] = most;
  }
  let blurred = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= a.height || xx < 0 || xx >= a.width) continue;
          sum += worst[yy * a.width + xx]!;
          n += 1;
        }
      }
      blurred = Math.max(blurred, sum / n);
    }
  }
  return { meanAbs: mean.map((value) => value / count) as [number, number, number], blurredMax: blurred, maxAbs: worst.reduce((most, value) => Math.max(most, value), 0) };
}

/** Mean of a (2r+1)^2 neighbourhood. */
export function probe(picture: Picture, x: number, y: number, r = 2): [number, number, number] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const xx = Math.min(picture.width - 1, Math.max(0, Math.round(x) + dx));
      const yy = Math.min(picture.height - 1, Math.max(0, Math.round(y) + dy));
      for (let c = 0; c < 3; c += 1) sum[c]! += picture.rgb[(yy * picture.width + xx) * 3 + c]!;
      n += 1;
    }
  }
  return sum.map((value) => value / n) as [number, number, number];
}

/** Encoded SDR output values to linear working-space values: the 1.961 curve, BT.709 to BT.2020. */
export function sdrToLinear(encoded: readonly number[]): [number, number, number] {
  return multiply3(BT709_TO_BT2020, encoded.map(sdrDecode));
}

