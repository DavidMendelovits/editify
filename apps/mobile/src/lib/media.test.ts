import { describe, expect, it } from 'vitest';
import type { AssetMetadata } from '@editify/shared';
import { isAudioOnly } from './media';

function asset(overrides: Partial<AssetMetadata>): AssetMetadata {
  return {
    id: 'a', originalName: 'a', mimeType: 'video/mp4', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true,
    status: 'ready', originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: '', ...overrides,
  };
}

describe('isAudioOnly', () => {
  it('treats an audio MIME type as audio, whatever else it claims', () => {
    expect(isAudioOnly(asset({ mimeType: 'audio/x-m4a', width: 0, height: 0 }))).toBe(true);
  });

  it('treats a stream with sound and no picture as audio', () => {
    // An .m4a uploaded as application/octet-stream still probes as audio-only.
    expect(isAudioOnly(asset({ mimeType: 'application/octet-stream', width: 0, height: 0 }))).toBe(true);
  });

  it('keeps footage on the video track, with or without sound', () => {
    expect(isAudioOnly(asset({}))).toBe(false);
    expect(isAudioOnly(asset({ hasAudio: false }))).toBe(false);
  });

  it('does not call a silent pictureless file audio', () => {
    expect(isAudioOnly(asset({ mimeType: 'application/octet-stream', width: 0, height: 0, hasAudio: false }))).toBe(false);
  });
});
