import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibrarySound, SoundCategory } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import { dataRoot } from '../config.js';
import { probeMedia, runProcess } from './process.js';

export const soundsRoot = join(dataRoot, 'sounds');

/** Library sounds are the only NULL-owner assets a signed-in user can see. */
export const SOUND_ID_PREFIX = 'sound-';

/**
 * The built-in sound library is synthesized with ffmpeg's lavfi sources on
 * first request — no downloads, no licensing, works offline. Each entry is a
 * filtergraph over aevalsrc/anoisesrc; recipes aim for the classic short-form
 * editing palette (whoosh, riser, pop, boom, tape stop, two music beds).
 */
interface SoundRecipe {
  id: string;
  name: string;
  category: SoundCategory;
  /** Either a single lavfi source, or [sourceA, sourceB, mixdownFilter]. */
  graph: string[];
}

const RECIPES: SoundRecipe[] = [
  {
    id: 'whoosh-soft', name: 'Soft whoosh', category: 'whoosh',
    graph: ["anoisesrc=d=0.8:c=pink:a=0.9,bandpass=f=900:w=500,afade=t=in:curve=qsin:d=0.3,afade=t=out:st=0.4:d=0.4"],
  },
  {
    id: 'whoosh-fast', name: 'Fast whoosh', category: 'whoosh',
    graph: ["anoisesrc=d=0.4:c=pink:a=1,bandpass=f=1600:w=900,afade=t=in:curve=qsin:d=0.12,afade=t=out:st=0.18:d=0.22"],
  },
  {
    id: 'impact-boom', name: 'Boom', category: 'impact',
    graph: [
      "aevalsrc='0.95*sin(2*PI*58*t)*exp(-5*t)':d=1.4",
      "anoisesrc=d=0.18:c=brown:a=0.8",
      'amix=inputs=2:duration=longest:normalize=0',
    ],
  },
  {
    id: 'impact-hit', name: 'Hard hit', category: 'impact',
    graph: [
      "aevalsrc='0.9*sin(2*PI*90*t)*exp(-14*t)':d=0.7",
      "anoisesrc=d=0.09:c=white:a=0.7",
      'amix=inputs=2:duration=longest:normalize=0',
    ],
  },
  {
    id: 'pop-bubble', name: 'Bubble pop', category: 'pop',
    graph: ["aevalsrc='0.9*sin(2*PI*440*t*(1+9*t))*exp(-28*t)':d=0.3"],
  },
  {
    id: 'pop-double', name: 'Double blip', category: 'pop',
    graph: ["aevalsrc='0.7*sin(2*PI*660*t)*exp(-30*t)+0.7*sin(2*PI*880*(t-0.1))*exp(-30*(t-0.1))*gt(t,0.1)':d=0.4"],
  },
  {
    id: 'ui-click', name: 'Click', category: 'ui',
    graph: ["aevalsrc='0.8*sin(2*PI*2100*t)*exp(-90*t)':d=0.1"],
  },
  {
    id: 'ui-ding', name: 'Ding', category: 'ui',
    graph: ["aevalsrc='0.55*sin(2*PI*1318.5*t)*exp(-4*t)+0.35*sin(2*PI*1975*t)*exp(-7*t)':d=1.6"],
  },
  {
    id: 'riser-sweep', name: 'Riser', category: 'riser',
    graph: ["aevalsrc='0.65*sin(2*PI*(180+520*t)*t)*min(t/1.6,1)':d=2,afade=t=out:st=1.85:d=0.15"],
  },
  {
    id: 'riser-tape-stop', name: 'Tape stop', category: 'riser',
    graph: ["aevalsrc='0.8*sin(2*PI*420*(1-t/1.4)*t)*(1-t/1.4)':d=1.3"],
  },
  {
    id: 'music-drive', name: 'Drive (120 BPM)', category: 'music',
    graph: [
      // Kick every half second, hat between, minor pad on top — an 8s loop.
      "aevalsrc='0.85*sin(2*PI*55*mod(t,0.5))*exp(-16*mod(t,0.5))+0.14*(random(0)-0.5)*exp(-70*mod(t+0.25,0.5))':d=8",
      "aevalsrc='(0.14*sin(2*PI*220*t)+0.11*sin(2*PI*261.63*t)+0.11*sin(2*PI*329.63*t))*(0.75+0.25*sin(2*PI*0.25*t))':d=8",
      'amix=inputs=2:duration=longest:normalize=0',
    ],
  },
  {
    id: 'music-dream', name: 'Dream pad', category: 'music',
    graph: [
      "aevalsrc='(0.16*sin(2*PI*196*t)+0.13*sin(2*PI*246.94*t)+0.12*sin(2*PI*293.66*t)+0.08*sin(2*PI*392*t))*(0.7+0.3*sin(2*PI*0.125*t))':d=8",
      "anoisesrc=d=8:c=pink:a=0.05,lowpass=f=800",
      'amix=inputs=2:duration=longest:normalize=0',
    ],
  },
];

/** Every sound is normalized to this peak, so the library plays at one level. */
const TARGET_PEAK_DB = -1;

/**
 * Peak level of `path` in dBFS, via ffmpeg's `volumedetect`. Returns null for
 * digital silence (volumedetect reports `-inf`, or nothing at all).
 */
export async function measurePeakDb(path: string): Promise<number | null> {
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-',
  ]);
  const value = stderr.match(/max_volume:\s*(-?[0-9.]+|-inf)\s*dB/)?.[1];
  return value === undefined || value === '-inf' ? null : Number(value);
}

/**
 * Two passes, because the recipes have no gain staging of their own: render
 * the filtergraph to a WAV, measure its peak, then apply the makeup gain on
 * the encode. `loudnorm` is not an option here — pop-bubble (0.3s) and
 * ui-click (0.1s) are shorter than its gating window. `alimiter` stays as the
 * safety net for the rare intersample overshoot.
 */
async function synthesize(recipe: SoundRecipe, path: string): Promise<void> {
  const raw = `${path}.${process.pid}.raw.wav`;
  try {
    const args = ['-y'];
    const sources = recipe.graph.length > 1 ? recipe.graph.slice(0, -1) : recipe.graph;
    for (const source of sources) args.push('-f', 'lavfi', '-i', source);
    if (recipe.graph.length > 1) {
      const mixdown = recipe.graph.at(-1) as string;
      args.push('-filter_complex', `${sources.map((_source, index) => `[${index}:a]`).join('')}${mixdown}[out]`, '-map', '[out]');
    }
    args.push('-ar', '48000', '-c:a', 'pcm_f32le', raw);
    await runProcess('ffmpeg', args);

    const peak = await measurePeakDb(raw);
    const makeup = peak === null ? 0 : TARGET_PEAK_DB - peak;
    await runProcess('ffmpeg', [
      '-y', '-i', raw,
      '-af', `volume=${makeup.toFixed(2)}dB,alimiter=limit=0.9`,
      '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', path,
    ]);
  } finally {
    await rm(raw, { force: true });
  }
}

let generated: Promise<LibrarySound[]> | undefined;

/**
 * Generate (once) and register every library sound as a regular asset, so
 * timeline clips, the preview, and the renderer treat them like any upload.
 * Idempotent across restarts via `getByOriginalName`.
 */
/** Every built-in sound id, so callers (and tests) can name sounds without ffmpeg. */
export const SOUND_LIBRARY_IDS = RECIPES.map((recipe) => recipe.id);

/** Render one recipe by id to `path` — the unit test's way in, without the store. */
export async function synthesizeSound(id: string, path: string): Promise<void> {
  const recipe = RECIPES.find((entry) => entry.id === id);
  if (!recipe) throw new Error(`unknown sound: ${id}`);
  await synthesize(recipe, path);
}

export async function ensureSoundLibrary(assets: AssetStore): Promise<LibrarySound[]> {
  generated ??= (async () => {
    await mkdir(soundsRoot, { recursive: true });
    const sounds: LibrarySound[] = [];
    for (const recipe of RECIPES) {
      // -v2: the original files were rendered without gain staging; two of
      // them (the whooshes) were inaudible. Bumping the name forces a re-render.
      const fileName = `sfx-${recipe.id}-v2.m4a`;
      const path = join(soundsRoot, fileName);
      if (!existsSync(path)) await synthesize(recipe, path);
      let asset = assets.getByOriginalName(fileName);
      if (!asset) {
        const probe = await probeMedia(path);
        // upsert, not insert: a pre-v2 row already holds this `sound-<id>`.
        asset = assets.upsert({
          id: `${SOUND_ID_PREFIX}${recipe.id}`,
          originalName: fileName,
          mimeType: 'audio/mp4',
          duration: probe.duration,
          width: 0,
          height: 0,
          fps: 0,
          hasAudio: true,
          status: 'ready',
          originalPath: path,
          proxyPath: path,
          thumbnailPath: path,
          originalUrl: `/assets/sound-${recipe.id}/original`,
          proxyUrl: `/assets/sound-${recipe.id}/original`,
          thumbnailUrl: `/assets/sound-${recipe.id}/thumb.jpg`,
          filmstripUrl: `/assets/sound-${recipe.id}/filmstrip.jpg`,
          createdAt: new Date().toISOString(),
        });
      }
      sounds.push({
        id: recipe.id,
        name: recipe.name,
        category: recipe.category,
        duration: asset.duration,
        assetId: asset.id,
        url: `/assets/${asset.id}/original`,
      });
    }
    return sounds;
  })().catch((error: unknown) => {
    generated = undefined; // let the next request retry a failed generation
    throw error;
  });
  return await generated;
}
