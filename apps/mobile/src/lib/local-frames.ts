/**
 * A clip's timeline frames and waveform from this phone, for a clip whose server copies
 * aren't there yet (land first: its original is still uploading, or the server is still
 * making its proxy). The frames come from expo-video's thumbnail generator on the local
 * file, the waveform from the engine's own energy analyzer; both are cached per asset for
 * this launch. Nothing here on web or without the engine: those clips wait for the server.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { createVideoPlayer, type VideoThumbnail } from 'expo-video';
import { EditifyEngine, type NativeEnergy } from '../../modules/editify-engine';
import { analyzeMedia, resolveMedia } from './local-media';
import { localMedia } from './local-media-native';
import { localSources } from './uploads';
import { FILMSTRIP_TILES } from './timeline';

const frames = new Map<string, Promise<VideoThumbnail[] | null>>();
const waveforms = new Map<string, Promise<NativeEnergy | null>>();

/** A file:// URI for the clip on this phone: the one it landed from, else what the registry resolves. */
async function localUri(assetId: string): Promise<string | null> {
  const remembered = localSources.get(assetId);
  if (remembered) return remembered;
  const deps = await localMedia();
  if (!deps) return null;
  const media = await resolveMedia({ id: assetId, kind: 'video' }, deps);
  if (media.state === 'file') return media.proxyUri ?? media.ref;
  return media.state === 'local' ? media.proxyUri ?? null : null;
}

/** FILMSTRIP_TILES frames left to right over [0, duration], like the server's filmstrip.jpg. */
async function makeFrames(assetId: string, duration: number): Promise<VideoThumbnail[] | null> {
  const uri = await localUri(assetId);
  if (!uri) return null;
  const player = createVideoPlayer(uri);
  try {
    const times = Array.from({ length: FILMSTRIP_TILES }, (_, tile) => ((tile + 0.5) * duration) / FILMSTRIP_TILES);
    return await player.generateThumbnailsAsync(times, { maxWidth: 240 });
  } finally {
    player.release();
  }
}

export function useLocalFrames(assetId: string | undefined, duration: number, enabled: boolean): VideoThumbnail[] | null {
  const [result, setResult] = useState<VideoThumbnail[] | null>(null);
  useEffect(() => {
    setResult(null);
    if (!enabled || !assetId || Platform.OS !== 'ios' || !(duration > 0)) return undefined;
    let live = true;
    let pending = frames.get(assetId);
    if (!pending) {
      pending = makeFrames(assetId, duration).catch(() => null);
      frames.set(assetId, pending);
      // A failure (no local file yet) is retried by the next mount, not cached.
      void pending.then((made) => { if (!made) frames.delete(assetId); });
    }
    void pending.then((made) => { if (live) setResult(made); });
    return () => { live = false; };
  }, [assetId, duration, enabled]);
  return result;
}

/** The engine's energy part for the clip ({cellSeconds, rmsDb}, the server waveform's shape), once ready. */
async function makeWaveform(assetId: string): Promise<NativeEnergy | null> {
  const engine = EditifyEngine;
  const deps = await localMedia();
  if (!engine || !deps) return null;
  const read = async (): Promise<NativeEnergy | null | undefined> => {
    const part = (await engine.getAnalysis(assetId)).parts.energy;
    if (part?.status === 'ready') return part.data as NativeEnergy;
    return part?.status === 'failed' || part?.status === 'unavailable' ? null : undefined;
  };
  return await new Promise<NativeEnergy | null>((resolve) => {
    const subscription = engine.addListener('analysisStatus', (event) => {
      if (event.assetId !== assetId || event.part !== 'energy' || event.removed) return;
      void read().then((energy) => {
        if (energy === undefined) return;
        subscription.remove();
        resolve(energy);
      }, () => undefined);
    });
    void analyzeMedia({ id: assetId, kind: 'video' }, deps, ['energy'])
      .then(async (media) => {
        if (media.state !== 'local' && media.state !== 'file') throw new Error('Not on this iPhone');
        const energy = await read();
        if (energy === undefined) return;
        subscription.remove();
        resolve(energy);
      })
      .catch(() => { subscription.remove(); resolve(null); });
  });
}

export function useLocalWaveform(assetId: string | undefined, enabled: boolean): NativeEnergy | null {
  const [result, setResult] = useState<NativeEnergy | null>(null);
  useEffect(() => {
    setResult(null);
    if (!enabled || !assetId || !EditifyEngine) return undefined;
    let live = true;
    let pending = waveforms.get(assetId);
    if (!pending) {
      pending = makeWaveform(assetId).catch(() => null);
      waveforms.set(assetId, pending);
      void pending.then((made) => { if (!made) waveforms.delete(assetId); });
    }
    void pending.then((made) => { if (live) setResult(made); });
    return () => { live = false; };
  }, [assetId, enabled]);
  return result;
}
