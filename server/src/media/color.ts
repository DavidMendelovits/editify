import { runProcess } from './process.js';

/**
 * One source of truth for colour. Thumbnails, proxies and the final render all
 * hand ffmpeg raw source frames; without an explicit conversion each path
 * guesses differently and the library ends up a different colour to the
 * preview. Everything below answers two questions: what space is the source in,
 * and what has to happen to land it in the target space.
 */

export type HdrHandling = 'sdr' | 'hdr';

/** ffprobe stream fields verbatim; `'unknown'` when the container says nothing. */
export interface SourceColor {
  primaries: string;
  transfer: string;
  matrix: string;
  range: string;
}

/** Bumped whenever the chains below change: cached thumbnails older than this are stale. */
export const COLOR_PIPELINE_VERSION = 2;

const probes = new Map<string, Promise<SourceColor>>();

/**
 * Cached per path — a render probes the same original once per clip otherwise,
 * and ffprobe on a 4k master is not free.
 */
export async function probeColor(path: string): Promise<SourceColor> {
  const existing = probes.get(path);
  if (existing) return await existing;
  const pending = (async (): Promise<SourceColor> => {
    const { stdout } = await runProcess('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_primaries,color_transfer,color_space,color_range',
      '-of', 'json', path,
    ]);
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string }>;
    };
    const stream = parsed.streams?.[0];
    return {
      primaries: stream?.color_primaries ?? 'unknown',
      transfer: stream?.color_transfer ?? 'unknown',
      matrix: stream?.color_space ?? 'unknown',
      range: stream?.color_range ?? 'unknown',
    };
  })();
  probes.set(path, pending);
  return await pending;
}

/** PQ (iPhone/HLG cameras) and HLG are the two transfers that need tone mapping. */
export function isHdr(color: SourceColor): boolean {
  return color.transfer === 'smpte2084' || color.transfer === 'arib-std-b67';
}

/** BT.2020 or a DCI/Display-P3 gamut: SDR, but not BT.709, so it still needs converting. */
export function isWideGamut(color: SourceColor): boolean {
  return ['bt2020', 'smpte428', 'smpte431', 'smpte432'].includes(color.primaries)
    || color.matrix === 'bt2020nc' || color.matrix === 'bt2020c';
}

/**
 * The filter chain that brings `color` into `target`. No leading or trailing
 * comma, so callers splice it into a -vf chain; always ends in a pixel format,
 * so the graph downstream is in one format whatever the source was.
 */
export function normalizeFilter(
  color: SourceColor,
  target: HdrHandling,
  opts?: { zscale?: boolean },
): string {
  const zscale = opts?.zscale !== false;
  const hdr = isHdr(color);
  if (target === 'hdr' && hdr) return 'format=yuv420p10le'; // Passthrough: a 10-bit master keeps its own space.
  if (!zscale) {
    // Some ffmpeg builds ship without libzimg. Degrade to a plain format
    // conversion rather than failing the render: a cast beats no export.
    return 'format=yuv420p';
  }
  if (hdr) {
    // Tone map in linear light, then land in BT.709 limited — the space the
    // preview player and every SDR display assume.
    return 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,'
      + 'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
  }
  if (isWideGamut(color)) return 'zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p';
  // Full-range (yuvj*) sources are the common "washed out" cast: everything
  // downstream treats them as limited unless the levels are mapped first.
  if (color.range === 'pc') return 'scale=in_range=full:out_range=limited,format=yuv420p';
  return 'format=yuv420p';
}

/**
 * Frame-side tagging. ffmpeg 7 lets the decoded frames' own colour properties
 * win over the encoder flags below, so a source that says nothing stays
 * untagged unless the chain stamps the space it was just converted into.
 */
export function outputColorFilter(target: HdrHandling, sourceIsHdr: boolean): string {
  return target === 'hdr' && sourceIsHdr
    ? 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv'
    : 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
}

/** Encoder-side tagging, so players do not have to guess what we just produced. */
export function outputColorArgs(target: HdrHandling, sourceIsHdr: boolean): string[] {
  if (target === 'hdr' && sourceIsHdr) {
    return [
      '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020',
      '-color_trc', 'smpte2084', '-color_range', 'tv',
      '-profile:v', 'main10',
    ];
  }
  return ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
}

let filters: Promise<boolean> | undefined;

/** True when this ffmpeg build has libzimg and the tonemap filter. Probed once. */
export async function zscaleAvailable(): Promise<boolean> {
  filters ??= runProcess('ffmpeg', ['-hide_banner', '-filters'])
    .then(({ stdout }) => stdout.includes('zscale') && stdout.includes('tonemap'))
    .catch(() => false);
  return await filters;
}
