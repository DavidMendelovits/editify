/*
 * One project and the edit batches the phone paints optimistically. Both the
 * phone's test (apps/mobile/src/lib/optimistic.test.ts) and the server's
 * (server/test/optimistic-parity.test.ts) run these, so the paint is held
 * equal to the real ProjectStore path. Test-only: not exported from src.
 */
import type { Operation, Project } from '../src/index.js';

export function editFixture(): Project {
  return {
    id: 'p-optimistic',
    title: 'Stand-up',
    format: '9:16',
    fps: 30,
    duration: 14,
    version: 7,
    tracks: [
      {
        id: 'video-main',
        kind: 'video',
        clips: [
          { id: 'a', assetId: 'asset-1', start: 0, in: 0, out: 4, volume: 1, speed: 1 },
          { id: 'b', assetId: 'asset-2', start: 4, in: 1, out: 7, volume: 1, speed: 1, transition: { type: 'crossfade', duration: 0.5 } },
          { id: 'c', assetId: 'asset-3', start: 10, in: 0, out: 4, speed: 2 },
        ],
      },
      { id: 'audio-main', kind: 'audio', clips: [{ id: 'memo', assetId: 'asset-4', start: 1, in: 0, out: 9, volume: 0.8 }] },
      {
        id: 'captions',
        kind: 'caption',
        clips: [
          {
            id: 'cap-1', start: 0.5, in: 0, out: 2, text: 'hello there',
            style: {
              font: 'Montserrat', size: 52, color: '#FFFFFF', position: 'bottom', emphasis: 'bold',
              words: [{ w: 'hello', s: 0.5, e: 1 }, { w: 'there', s: 1.1, e: 2.4 }],
            },
          },
          { id: 'cap-2', start: 6, in: 0, out: 1.5, text: 'late line' },
        ],
      },
      { id: 'overlays', kind: 'overlay', clips: [{ id: 'sticker', text: '★', start: 3, in: 0, out: 3 }] },
    ],
  };
}

/** Every batch here is one the server accepts on editFixture(). */
export const EDIT_BATCHES: ReadonlyArray<{ name: string; ops: Operation[] }> = [
  { name: 'trim_clip', ops: [{ type: 'trim_clip', params: { clipId: 'a', out: 3.123457 } }] },
  { name: 'split_clip with an id', ops: [{ type: 'split_clip', params: { clipId: 'b', at: 5, newClipId: 'b-s1' } }] },
  { name: 'split_clip without an id (2x speed)', ops: [{ type: 'split_clip', params: { clipId: 'c', at: 11 } }] },
  { name: 'move_clip', ops: [{ type: 'move_clip', params: { clipId: 'memo', start: 2.5 } }] },
  { name: 'set_clip_properties start', ops: [{ type: 'set_clip_properties', params: { updates: [{ clipId: 'c', start: 12 }] } }] },
  {
    name: 'ripple_delete_ranges',
    ops: [{ type: 'ripple_delete_ranges', params: { trackId: 'video-main', ranges: [{ start: 1, end: 2 }, { start: 5, end: 6 }] } }],
  },
  { name: 'set_volume', ops: [{ type: 'set_volume', params: { clipId: 'memo', volume: 0.35 } }] },
  { name: 'add_caption', ops: [{ type: 'add_caption', params: { trackId: 'captions', clip: { id: 'cap-3', start: 9, in: 0, out: 1, text: 'new' } } }] },
  { name: 'update_caption text', ops: [{ type: 'update_caption', params: { clipId: 'cap-1', text: 'hello world' } }] },
  { name: 'remove_caption', ops: [{ type: 'remove_caption', params: { clipId: 'cap-2' } }] },
  {
    name: 'multi-op batch',
    ops: [
      { type: 'trim_clip', params: { clipId: 'a', in: 0.5 } },
      { type: 'set_clip_properties', params: { updates: [{ clipId: 'a', start: 0 }] } },
      { type: 'split_clip', params: { clipId: 'b', at: 6 } },
      { type: 'set_transition', params: { clipId: 'b', transition: null } },
      { type: 'set_overlay', params: { clipId: 'sticker', overlay: { x: 0.2, y: 0.8, width: 0.3, rotation: 15 } } },
      { type: 'add_clip', params: { trackId: 'overlays', clip: { id: 'star-2', text: '✨', start: 1, in: 0, out: 2 } } },
      { type: 'update_caption', params: { clipId: 'cap-2', start: 6.5 } },
      { type: 'remove_clip', params: { clipId: 'sticker' } },
      { type: 'ripple_delete_ranges', params: { trackId: 'video-main', ranges: [{ start: 2, end: 2.5 }] } },
    ],
  },
];

/** The id a test's withExplicitIds hands an unnamed split half. */
export const MINTED_ID = 'minted-id';
