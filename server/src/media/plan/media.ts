import { open } from 'node:fs/promises';
import type { PlanAssetInfo } from '@editify/shared';
import { runProcess } from '../process.js';
import type { SourceColor } from '../color.js';

/**
 * What the plan render needs to know about one source file, from one
 * ffprobe: the builder's PlanAssetInfo (upright size, duration, audio,
 * animation) plus the colour tags, the EXIF orientation of a still and the
 * audio channel layout.
 */
export interface PlanMediaProbe {
  path: string;
  info: PlanAssetInfo;
  color: SourceColor;
  /** EXIF orientation 1..8 of a still image (1 when absent). ffmpeg does not apply it, so the render does. */
  orientation: number;
  hasVideo: boolean;
  audioChannels: number;
  audioLayout: string;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  channels?: number;
  channel_layout?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  color_range?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
  disposition?: { attached_pic?: number };
}

function rate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator = '0', denominator = '1'] = value.split('/');
  const divisor = Number(denominator);
  return divisor ? Number(numerator) / divisor : 0;
}

/**
 * EXIF orientation from a JPEG APP1 segment or a PNG eXIf chunk (1 when
 * there is none). Reads only the head of the file.
 */
export async function readExifOrientation(path: string): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return exifOrientation(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function exifOrientation(data: Buffer): number {
  let tiff: Buffer | undefined;
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) {
    // PNG: chunks after the 8-byte signature.
    for (let at = 8; at + 8 <= data.length;) {
      const length = data.readUInt32BE(at);
      const type = data.toString('latin1', at + 4, at + 8);
      if (type === 'eXIf') {
        tiff = data.subarray(at + 8, at + 8 + length);
        break;
      }
      if (type === 'IDAT' || type === 'IEND') break;
      at += 12 + length;
    }
  } else if (data.length > 4 && data.readUInt16BE(0) === 0xffd8) {
    for (let at = 2; at + 4 <= data.length;) {
      if (data[at] !== 0xff) break;
      const marker = data[at + 1]!;
      const length = data.readUInt16BE(at + 2);
      if (marker === 0xe1 && data.toString('latin1', at + 4, at + 10) === 'Exif\0\0') {
        tiff = data.subarray(at + 10, at + 2 + length);
        break;
      }
      if (marker === 0xda) break;
      at += 2 + length;
    }
  }
  if (!tiff || tiff.length < 8) return 1;
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (at: number): number => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number): number => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const entries = u16(ifd);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** Filters that turn a still stored with EXIF `orientation` upright. */
export function orientationFilter(orientation: number): string | undefined {
  return {
    2: 'hflip',
    3: 'hflip,vflip',
    4: 'vflip',
    5: 'transpose=0',
    6: 'transpose=1',
    7: 'transpose=3',
    8: 'transpose=2',
  }[orientation];
}

const probes = new Map<string, Promise<PlanMediaProbe>>();

/** One ffprobe per file per process (originals never change under an id). */
export async function probePlanMedia(path: string, kind: PlanAssetInfo['kind']): Promise<PlanMediaProbe> {
  const key = `${kind}:${path}`;
  let pending = probes.get(key);
  if (!pending) {
    pending = probeOnce(path, kind);
    probes.set(key, pending);
    pending.catch(() => probes.delete(key));
  }
  return await pending;
}

async function probeOnce(path: string, kind: PlanAssetInfo['kind']): Promise<PlanMediaProbe> {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path,
  ]);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: ProbeStream[] };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0) || 0;
  const color: SourceColor = {
    primaries: video?.color_primaries ?? 'unknown',
    transfer: video?.color_transfer ?? 'unknown',
    matrix: video?.color_space ?? 'unknown',
    range: video?.color_range ?? 'unknown',
  };
  let orientation = 1;
  let rotation = 0;
  if (kind === 'image') {
    orientation = await readExifOrientation(path).catch(() => 1);
    rotation = [5, 6, 7, 8].includes(orientation) ? 90 : 0;
  } else if (video) {
    const matrix = video.side_data_list?.find((side) => side.side_data_type === 'Display Matrix');
    // ffprobe reports the display matrix rotation counter-clockwise.
    rotation = matrix?.rotation !== undefined ? -matrix.rotation : Number(video.tags?.rotate ?? 0);
  }
  const frames = Number(video?.nb_frames ?? 0);
  const animated = kind === 'image' && video?.codec_name === 'gif' && (frames > 1 || duration > 0.05);
  return {
    path,
    info: {
      kind,
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      duration: kind === 'image' && !animated ? 0 : duration,
      hasAudio: Boolean(audio),
      ...(animated ? { animated: true } : {}),
      ...(video ? { fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate) } : {}),
      ...(rotation ? { rotation: ((Math.round(rotation) % 360) + 360) % 360 } : {}),
    },
    color,
    orientation,
    hasVideo: Boolean(video),
    audioChannels: audio?.channels ?? 0,
    audioLayout: audio?.channel_layout ?? '',
  };
}

/** Upright pixel size of a probed picture. */
export function uprightSize(probe: PlanMediaProbe): { width: number; height: number } {
  const quarter = (((Math.round((probe.info.rotation ?? 0) / 90) % 4) + 4) % 4);
  return quarter % 2 === 1 ? { width: probe.info.height, height: probe.info.width } : { width: probe.info.width, height: probe.info.height };
}

/**
 * A GIF's frame timing, read from its Graphic Control Extensions: delays in
 * centiseconds with anything under 2 cs played as 10 cs (schema MEDIA rule;
 * ffmpeg's demuxer clamps only some of them, so the render does not rely on
 * it), and each frame's start within one loop.
 */
export interface GifTiming { starts: number[]; total: number }

export function gifTiming(data: Buffer): GifTiming {
  const delays: number[] = [];
  if (data.length < 13 || data.toString('latin1', 0, 3) !== 'GIF') return { starts: [0], total: 0.1 };
  let at = 13;
  const packed = data[10]!;
  if (packed & 0x80) at += 3 * (1 << ((packed & 0x07) + 1));
  let pending = 0;
  const skipSubBlocks = (from: number): number => {
    let cursor = from;
    while (cursor < data.length && data[cursor]! !== 0) cursor += data[cursor]! + 1;
    return cursor + 1;
  };
  while (at < data.length) {
    const block = data[at]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = data[at + 1]!;
      if (label === 0xf9 && at + 6 < data.length) pending = data.readUInt16LE(at + 4);
      at = skipSubBlocks(at + 2);
    } else if (block === 0x2c) {
      const flags = data[at + 9]!;
      at += 10;
      if (flags & 0x80) at += 3 * (1 << ((flags & 0x07) + 1));
      at = skipSubBlocks(at + 1);
      delays.push(pending < 2 ? 10 : pending);
      pending = 0;
    } else {
      break;
    }
  }
  if (delays.length === 0) return { starts: [0], total: 0.1 };
  const starts: number[] = [];
  let total = 0;
  for (const delay of delays) {
    starts.push(total / 100);
    total += delay;
  }
  return { starts, total: total / 100 };
}
