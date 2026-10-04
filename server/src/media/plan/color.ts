import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RenderPlan } from '@editify/shared';
import { dataRoot } from '../../config.js';
import type { SourceColor } from '../color.js';

/*
 * The plan render's colour pipeline (RenderPlan COLOUR, decisions 4A + OV6).
 *
 * Working space: linear light, extended-range BT.2020, as 32-bit float planar
 * RGB (gbrpf32le). Linear 1.0 is the BT.2408 reference white of 203 cd/m2:
 * zscale with npl=203 decodes an HLG signal of 0.75 and PQ at 203 cd/m2 to
 * 1.0 and the HLG peak to 4.926 (measured on ffmpeg 6.1 and 9.0), and SDR
 * white decodes to 1.0. Every source and every graphic is converted into it
 * before anything blends, and the composite is encoded afterwards:
 *
 *   sdr  linear 2020 -> BT.709 primaries -> SDR curve -> Y'CbCr BT.709 limited, H.264 High 8-bit
 *   hlg  linear 2020 -> clip at 4.926 -> BT.2100 HLG (npl 203) -> Y'CbCr BT.2020 NCL limited, HEVC Main10
 *
 * THE SDR CURVE. BT.709-tagged video (and 601/unspecified) is decoded and
 * encoded with a pure power law, gamma 1.961, not the BT.709 camera OETF and
 * not BT.1886. That is the curve Core Video decodes 709-tagged video with and
 * EditifyCompositor encodes with (PlanColorPipeline.bt709, "0.18 came back as
 * 0.25" through the OETF); the native goldens confirm it (linear 0.18 encodes
 * to 106/255, the sRGB #0B0B0F background to 14/255). Matching it is what
 * makes the two renderers' SDR exports agree: SDR video passes through
 * unchanged either way (decode and encode are inverses), but graphics, blends
 * and tone-mapped HDR land on the same code values only with the same curve.
 * sRGB-tagged sources and every hex colour use the exact sRGB curve.
 *
 * zscale cannot apply a custom curve, so the SDR curve is a lut1d: zscale
 * converts Y'CbCr to R'G'B' float with the transfer left alone, lut1d applies
 * the curve, and a second zscale converts primaries in linear light.
 *
 * SDR TONE CURVE (schema): in an `sdr` plan every HLG or PQ source is tone
 * mapped per channel on its linear BT.2020 values before blending, knee 0.8,
 * Reinhard shoulder: y = v (v <= 0.8), y = 0.8 + 0.2 e / (0.2 + e) (e = v - 0.8).
 * Implemented as a lut1d .cube over the linear domain [0, 64] with a sample
 * every 0.004 (the knee sits exactly on a sample; the interpolation error is
 * under 2e-5). Inputs above 64 (over 13,000 cd/m2, past PQ's own range) clamp
 * to the last sample, 0.99971.
 */

export type TransferKind = 'sdr' | 'srgb' | 'linear' | 'hlg' | 'pq';

/** The SDR video curve, a pure power law (see above). */
export const SDR_GAMMA = 1.961;
/** Linear value of the HLG nominal peak, 1000 / 203. HLG output clips every channel here. */
export const HLG_PEAK_LINEAR = 1000 / 203;
export const TONE_KNEE = 0.8;

/** The schema's SDR tone curve, per channel on linear values (EditifyCompositor.sdrCurve). */
export function sdrToneCurve(value: number): number {
  if (!(value > TONE_KNEE)) return value;
  const shoulder = 1 - TONE_KNEE;
  const excess = value - TONE_KNEE;
  return TONE_KNEE + (shoulder * excess) / (shoulder + excess);
}

export function sdrDecode(encoded: number): number {
  return encoded > 0 ? encoded ** SDR_GAMMA : 0;
}

export function sdrEncode(linear: number): number {
  return linear > 0 ? linear ** (1 / SDR_GAMMA) : 0;
}

export function srgbDecode(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

/** BT.709 to BT.2020 primaries, linear light (ITU-R BT.2087). */
export const BT709_TO_BT2020 = [
  [0.6274039, 0.3292830, 0.0433131],
  [0.0690973, 0.9195404, 0.0113623],
  [0.0163914, 0.0880133, 0.8955953],
] as const;

/** BT.2020 to BT.709, the inverse of BT709_TO_BT2020. */
export const BT2020_TO_BT709 = [
  [1.6604910, -0.5876411, -0.0728499],
  [-0.1245505, 1.1328999, -0.0083494],
  [-0.0181508, -0.1005789, 1.1187297],
] as const;

export function multiply3(matrix: ReadonlyArray<readonly number[]>, rgb: readonly number[]): [number, number, number] {
  return [0, 1, 2].map((row) => matrix[row]![0]! * rgb[0]! + matrix[row]![1]! * rgb[1]! + matrix[row]![2]! * rgb[2]!) as [number, number, number];
}

/** A `#RRGGBB` (or `#RRGGBBAA`) graphic colour in the working space: sRGB decoded, BT.709 to BT.2020. */
export function hexToWorking(hex: string): { rgb: [number, number, number]; alpha: number } {
  const digits = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(hex)?.[1] ?? '000000';
  const alphaDigits = /^#[\da-f]{6}([\da-f]{2})$/i.exec(hex)?.[1];
  const channel = (at: number): number => srgbDecode(Number.parseInt(digits.slice(at, at + 2), 16) / 255);
  return {
    rgb: multiply3(BT709_TO_BT2020, [channel(0), channel(2), channel(4)]),
    alpha: alphaDigits ? Number.parseInt(alphaDigits, 16) / 255 : 1,
  };
}

export function transferKind(color: SourceColor): TransferKind {
  switch (color.transfer) {
    case 'smpte2084': return 'pq';
    case 'arib-std-b67': return 'hlg';
    case 'iec61966-2-1': return 'srgb';
    case 'linear': return 'linear';
    default: return 'sdr';
  }
}

export function isHdrTransfer(kind: TransferKind): boolean {
  return kind === 'hlg' || kind === 'pq';
}

const PRIMARIES: Record<string, string> = {
  bt709: '709', bt2020: '2020', smpte170m: '170m', smpte240m: '240m', bt470bg: 'bt470bg', bt470m: 'bt470m',
  film: 'film', smpte431: 'smpte431', smpte432: 'smpte432', 'jedec-p22': 'jedec-p22', ebu3213: 'ebu3213',
};
const MATRICES: Record<string, string> = {
  bt709: '709', bt2020nc: '2020_ncl', bt2020c: '2020_cl', smpte170m: '170m', bt470bg: '470bg', fcc: 'fcc', smpte240m: '240m', ycgco: 'ycgco',
};

/** zscale's input description of a source, with the defaults ffmpeg players assume for untagged files. */
export function zscaleInput(color: SourceColor, options: { rgb?: boolean | undefined } = {}): string {
  const kind = transferKind(color);
  const hdr = isHdrTransfer(kind);
  const primaries = PRIMARIES[color.primaries] ?? (hdr ? '2020' : '709');
  const transfer = { pq: 'smpte2084', hlg: 'arib-std-b67', srgb: 'iec61966-2-1', linear: 'linear', sdr: '709' }[kind];
  const parts = [`pin=${primaries}`, `tin=${transfer}`];
  if (options.rgb) {
    parts.push('rin=full');
  } else {
    const matrix = MATRICES[color.matrix] ?? (primaries === '2020' ? '2020_ncl' : '709');
    parts.push(`min=${matrix}`, `rin=${color.range === 'pc' ? 'full' : 'limited'}`);
  }
  return parts.join(':');
}

export interface LutFiles {
  /** SDR curve decode, encoded [0, 1] -> linear. */
  sdrDecode: string;
  /** SDR curve encode, linear [0, 1] -> encoded. */
  sdrEncode: string;
  /** The schema's SDR tone curve over linear [0, 64]. */
  tone: string;
  /** Identity clamp to [0, HLG peak]: HLG output clips per channel. */
  hlgClip: string;
}

/** Bumped whenever a curve below changes, so a cached .cube is never stale. */
const LUT_VERSION = 1;

function cube(size: number, min: number, max: number, curve: (x: number) => number): string {
  const lines = [`TITLE "editify"`, `LUT_1D_SIZE ${size}`, `DOMAIN_MIN ${min} ${min} ${min}`, `DOMAIN_MAX ${max} ${max} ${max}`];
  for (let index = 0; index < size; index += 1) {
    const value = curve(min + ((max - min) * index) / (size - 1)).toFixed(9);
    lines.push(`${value} ${value} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

let luts: Promise<LutFiles> | undefined;

/** The .cube files, written once per data directory (atomically, so concurrent renders never read half a file). */
export async function lutFiles(): Promise<LutFiles> {
  luts ??= (async () => {
    const directory = join(dataRoot, 'luts');
    await mkdir(directory, { recursive: true });
    const files: Record<keyof LutFiles, [number, number, number, (x: number) => number]> = {
      // 65536 (lut1d's maximum) keeps the power curve's steep foot accurate near black.
      sdrDecode: [65536, 0, 1, sdrDecode],
      sdrEncode: [65536, 0, 1, sdrEncode],
      tone: [16001, 0, 64, sdrToneCurve],
      hlgClip: [2, 0, HLG_PEAK_LINEAR, (x) => x],
    };
    const out = {} as LutFiles;
    for (const [name, [size, min, max, curve]] of Object.entries(files) as Array<[keyof LutFiles, [number, number, number, (x: number) => number]]>) {
      const path = join(directory, `${name}-v${LUT_VERSION}.cube`);
      if (!existsSync(path)) {
        const pending = `${path}.${process.pid}.tmp`;
        await writeFile(pending, cube(size, min, max, curve), 'utf8');
        await rename(pending, path);
      }
      out[name] = path;
    }
    return out;
  })();
  try {
    return await luts;
  } catch (error) {
    luts = undefined;
    throw error;
  }
}

/** A path inside a filtergraph option value. */
export function filterPath(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll(',', '\\,').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll(';', '\\;');
}

/**
 * Filters that take a decoded source frame (any pixel format ffmpeg decodes
 * to) into the working space. `alpha` keeps an alpha plane through
 * (gbrapf32le): the conversions touch colour only.
 */
export function toWorkingSpace(color: SourceColor, plan: Pick<RenderPlan, 'color'>, files: LutFiles, options: { alpha?: boolean; rgb?: boolean } = {}): string {
  const float = options.alpha ? 'gbrapf32le' : 'gbrpf32le';
  const kind = transferKind(color);
  const input = zscaleInput(color, { rgb: options.rgb });
  if (kind === 'sdr') {
    const primaries = /pin=([^:]+)/.exec(input)?.[1] ?? '709';
    const steps = [
      `zscale=${input}:t=709:p=${primaries}:r=full`,
      `format=${float}`,
      `lut1d=file='${filterPath(files.sdrDecode)}':interp=linear`,
    ];
    if (primaries !== '2020') steps.push(`zscale=tin=linear:pin=${primaries}:rin=full:t=linear:p=2020:r=full`, `format=${float}`);
    return steps.join(',');
  }
  const steps = [`zscale=${input}:t=linear:p=2020:r=full:npl=203`, `format=${float}`];
  if (isHdrTransfer(kind) && plan.color === 'sdr') steps.push(`lut1d=file='${filterPath(files.tone)}':interp=linear`);
  return steps.join(',');
}

/** Filters that encode the working space for the output: ends in the encoder's pixel format, frames tagged. */
export function fromWorkingSpace(plan: Pick<RenderPlan, 'color'>, files: LutFiles): string {
  if (plan.color === 'hlg') {
    return [
      `lut1d=file='${filterPath(files.hlgClip)}':interp=linear`,
      'zscale=tin=linear:pin=2020:rin=full:npl=203:t=arib-std-b67:p=2020:m=2020_ncl:r=limited',
      'format=yuv420p10le',
      'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv',
    ].join(',');
  }
  return [
    'zscale=tin=linear:pin=2020:rin=full:t=linear:p=709:r=full',
    'format=gbrpf32le',
    `lut1d=file='${filterPath(files.sdrEncode)}':interp=linear`,
    'zscale=tin=709:pin=709:rin=full:t=709:p=709:m=709:r=limited',
    'format=yuv420p',
    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
  ].join(',');
}

/**
 * Encoder arguments for the plan's output colour (8A: H.264 High 8-bit SDR,
 * HEVC Main10 HLG). Threads and lookahead are capped for memory, not left to
 * the host's core count: at 1080 x 1920 x264's defaults held 0.88 GB on a
 * 14-core host (1.5 frame threads a core, a 40-frame lookahead) and 0.4 GB
 * capped at 4 threads and 20 frames, with no loss of speed (the final pass is
 * bound by its float filters, not the encode); x265 0.87 GB with 4 pools and
 * 2 frame threads against 1.07 GB (its lookahead stays at medium's 20).
 */
export function encoderArgs(plan: Pick<RenderPlan, 'color'>): string[] {
  if (plan.color === 'hlg') {
    return [
      '-c:v', 'libx265', '-tag:v', 'hvc1', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p10le', '-profile:v', 'main10',
      '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited:log-level=error:pools=4:frame-threads=2',
      '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-color_range', 'tv',
    ];
  }
  return [
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-threads:v', '4', '-rc-lookahead', '20',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  ];
}
