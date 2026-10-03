/**
 * The lab's stand-up cut (plan P7, decision 5B): S1, S4 and S5 measure the finished
 * renderer on a realistic edit, built by the same buildRenderPlan the export screen uses.
 *
 *   picked clip (probeMedia: size, rotation, duration, colour) ─▶ standupLabProject:
 *     first 60 s of the set as 5 jump cuts (silences dropped), 3 crossfades into them,
 *     a punch-in on the 4th, 20 karaoke caption blocks (5 words each), 2 emoji stickers
 *   ─▶ buildRenderPlan(target from the variant) ─▶ planJson + media map ─▶ runSpike
 *
 * The variant picks the target:
 *   writer-60s-4k30   2160 x 3840, 30 fps; HLG when the source is HDR (HEVC Main10), else SDR
 *   writer-60s-1080   1080 x 1920, 30 fps, SDR (H.264 High): what the stand-up replay exports
 *   preview1080, render1080-plan   1080 x 1920 SDR, the preview's size cap, built as the native
 *                    preview builds its plans (buildPreviewPlan: kind preview, no loudness pass,
 *                    no self-check)
 */
import { buildRenderPlan, exportPlanSize, type Clip, type PlanAssetInfo, type Project, type RenderPlan } from '@editify/shared';

/** The id the plan names the picked clip by; the media map sends it to the PHAsset ref. */
export const LAB_ASSET_ID = 'lab-standup';
export const LAB_PLAN_SECONDS = 60;

export interface LabSource {
  /** Stored pixel size and the clockwise rotation that shows it upright. */
  width: number;
  height: number;
  rotation: number;
  duration: number;
  hasAudio: boolean;
  color: 'hlg' | 'pq' | 'log' | 'sdr' | null;
}

/** Timeline [start, end) of each cut and where its source starts (a jump cut drops the pause). */
const CUTS: ReadonlyArray<{ start: number; end: number; src: number }> = [
  { start: 0, end: 12, src: 0 },
  { start: 12, end: 24, src: 15 },
  { start: 24, end: 36, src: 31 },
  { start: 36, end: 48, src: 47 },
  { start: 48, end: 60, src: 63 },
];
const CROSSFADE_INTO = new Set([1, 2, 4]);
const ZOOMED = 3;

const LINES = [
  'SO I MOVED TO BROOKLYN', 'AND MY LANDLORD IS NINETY', 'HE STILL CALLS ME KID', 'EVERY SINGLE MORNING HE',
  'KNOCKS AT SIX AM SHARP', 'TO ASK ABOUT THE WEATHER', 'LIKE I AM THE NEWS', 'I SAID SIR LOOK OUTSIDE',
  'HE SAID I DID KID', 'I JUST WANTED A SECOND', 'OPINION ON THE CLOUDS', 'THAT IS WHEN I KNEW',
  'THIS MAN IS LONELY', 'SO NOW WE HAVE COFFEE', 'EVERY MORNING AT SIX', 'HE BRINGS THE DONUTS',
  'I BRING THE WEATHER', 'WE ARE BASICALLY MARRIED', 'MY MOM IS THRILLED', 'SHE FINALLY HAS A SON IN LAW',
];

export function standupLabProject(source: Pick<LabSource, 'duration'>): Project {
  const needed = CUTS[CUTS.length - 1]!.src + (CUTS[CUTS.length - 1]!.end - CUTS[CUTS.length - 1]!.start) + 1;
  if (source.duration < needed) throw new Error(`the stand-up cut needs a clip of at least ${needed} s; this one is ${Math.floor(source.duration)} s`);
  const video: Clip[] = CUTS.map((cut, index) => ({
    id: `cut-${index + 1}`, assetId: LAB_ASSET_ID, start: cut.start, in: cut.src, out: cut.src + (cut.end - cut.start),
    ...(CROSSFADE_INTO.has(index) ? { transition: { type: 'crossfade' as const, duration: 0.5 } } : {}),
    ...(index === ZOOMED ? { transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.25, x: 0, y: -0.1 } } : {}),
  }));
  // One karaoke block every 3 s, its words spread over 2.8 s (word times are relative to the first word).
  const captions: Clip[] = LINES.map((text, index) => {
    const split = text.split(' ');
    const step = Math.round((2.8 / split.length) * 1000) / 1000;
    const words = split.map((w, i) => ({ w, s: 100 + i * step, e: 100 + i * step + step * 0.9 }));
    return {
      id: `cap-${index + 1}`, start: index * 3, in: 0, out: 2.95, text,
      style: { font: 'Montserrat', size: 72, color: '#FFFFFF', position: 'bottom' as const, emphasis: 'highlight' as const, emphasisColor: '#FFD60A', words },
    };
  });
  const stickers: Clip[] = [
    { id: 'sticker-laugh', start: 10, in: 0, out: 4, text: '😂', overlay: { x: 0.78, y: 0.22, width: 0.22, rotation: 12 } },
    { id: 'sticker-fire', start: 40, in: 0, out: 5, text: '🔥', overlay: { x: 0.22, y: 0.3, width: 0.2, rotation: -10 } },
  ];
  return {
    id: 'lab-standup', title: 'Lab stand-up cut', format: '9:16', fps: 30, duration: LAB_PLAN_SECONDS, version: 1,
    tracks: [
      { id: 'video-main', kind: 'video', clips: video },
      { id: 'captions', kind: 'caption', clips: captions },
      { id: 'stickers', kind: 'overlay', clips: stickers },
    ],
  };
}

export function labPlanTarget(variant: string, source: Pick<LabSource, 'color'>): { size: { w: number; h: number }; color: 'sdr' | 'hlg' } {
  if (variant.includes('4k')) {
    const hdr = source.color === 'hlg' || source.color === 'pq';
    return { size: exportPlanSize('9:16', '4k'), color: hdr ? 'hlg' : 'sdr' };
  }
  return { size: exportPlanSize('9:16', variant.includes('720') ? '720p' : '1080p'), color: 'sdr' };
}

/** The variants the native preview's player runs (S5, S1 on the plan); the rest are exports. */
export function isPreviewVariant(variant: string): boolean {
  return variant === 'preview1080' || variant.endsWith('-plan');
}

export function standupLabPlan(source: LabSource, variant: string, buildSeq = 1): RenderPlan {
  const info: PlanAssetInfo = {
    kind: 'video', width: source.width, height: source.height, duration: source.duration, hasAudio: source.hasAudio,
    ...(source.rotation ? { rotation: source.rotation } : {}),
  };
  const target = labPlanTarget(variant, source);
  const preview = isPreviewVariant(variant);
  return buildRenderPlan(standupLabProject(source), { kind: preview ? 'preview' : 'export', ...target, loudness: !preview }, {
    revision: 1, buildSeq, assetInfo: (id) => (id === LAB_ASSET_ID ? info : undefined), selfCheck: !preview,
  });
}
