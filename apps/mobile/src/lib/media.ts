import type { AssetMetadata } from '@editify/shared';

/**
 * An audio-only asset: a voice memo or a track, not footage. The editor routes
 * these to the audio track and the sound sheet lists them under MY MUSIC, so
 * both ask here rather than keep two copies of the rule in step.
 */
export function isAudioOnly(asset: AssetMetadata): boolean {
  return asset.mimeType.startsWith('audio/') || (asset.hasAudio && asset.width === 0);
}
