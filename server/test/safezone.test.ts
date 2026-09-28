import { describe, expect, it } from 'vitest';
import type { CaptionStyle, Clip, Project } from '@editify/shared';
import { planCaptionPlacements, placeableCaption, sourceYToScreen, type PlaceableCaption } from '../src/media/safezone.js';
import type { FaceTrack } from '../src/services/face-service.js';

const frame = { width: 1080, height: 1920 };

function project(videoClip: Partial<Clip> = {}, platform?: Project['platform']): Project {
  return {
    id: 'p', title: 'Placement', format: '9:16', fps: 30, duration: 10, version: 0,
    ...(platform ? { platform } : {}),
    tracks: [{ id: 'video-main', kind: 'video', clips: [{ id: 'clip-a', assetId: 'a1', start: 0, in: 0, out: 10, ...videoClip }] }],
  };
}

/** A steady face between `top` and `bottom` (fractions of source height) for 10 seconds. */
function steadyFace(top: number, bottom: number): (assetId: string) => FaceTrack | undefined {
  const samples: FaceTrack['samples'] = Array.from({ length: 51 }, (_unused, index) => [index * 0.2, top, bottom, 0.3, 0.7]);
  return (assetId) => (assetId === 'a1' ? { fps: 5, width: 1080, height: 1920, samples } : undefined);
}

function caption(id: string, style: Partial<CaptionStyle>, start = 1, end = 3): PlaceableCaption {
  return {
    id, start, end, text: 'hello world',
    style: { font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'bottom', emphasis: 'bold', ...style },
  };
}

describe('caption placement', () => {
  it('moves a caption that would sit on the face to just below the chin', () => {
    const [placement] = planCaptionPlacements(project(), [caption('c1', { anchorPct: 35, sizePct: 4 })], steadyFace(0.2, 0.45));
    expect(placement).toMatchObject({ clipId: 'c1', fromPct: 35, reason: 'below-face' });
    // Chin at 864px + 36px gap + half the ~94px block.
    expect(placement?.toPct).toBeCloseTo(49.3, 1);
  });

  it('keeps a caption that already clears the face and the app UI', () => {
    const [placement] = planCaptionPlacements(project(), [caption('c1', { anchorPct: 60, sizePct: 4 })], steadyFace(0.2, 0.45));
    expect(placement).toMatchObject({ reason: 'kept', fromPct: 60, toPct: 60 });
  });

  it('lifts a bottom caption out of the platform band even without a face track', () => {
    const instagram = planCaptionPlacements(project(), [caption('c1', {})], () => undefined)[0];
    expect(instagram).toMatchObject({ reason: 'safe-area' });
    expect(instagram?.toPct).toBeCloseTo(76.1, 1);
    const shorts = planCaptionPlacements(project({}, 'shorts'), [caption('c1', {})], () => undefined)[0];
    expect(shorts?.toPct).toBeCloseTo(78.1, 1);
  });

  it('places an unstyled caption as the renderer draws it: bottom, 52px', () => {
    const unstyled = placeableCaption({ id: 'bare', start: 0, in: 0, out: 2, text: 'no style' });
    expect(unstyled?.style).toMatchObject({ position: 'bottom', size: 52 });
    const [placement] = planCaptionPlacements(project(), [unstyled as PlaceableCaption], () => undefined);
    expect(placement?.reason).toBe('safe-area');
  });

  it('drops to the lowest safe spot when the face fills the frame', () => {
    const [placement] = planCaptionPlacements(project(), [caption('c1', { anchorPct: 50, sizePct: 4 })], steadyFace(0.1, 0.8));
    expect(placement?.reason).toBe('no-room');
    expect(placement?.toPct).toBeCloseTo(75.7, 1);
  });

  it('follows a punch-in: the zoomed chin grows down onto a caption the unzoomed one cleared', () => {
    // Zoom scales around the frame centre, so a chin below centre moves further down.
    const style = { anchorPct: 60, sizePct: 4 };
    const plain = planCaptionPlacements(project(), [caption('c1', style)], steadyFace(0.3, 0.55))[0];
    expect(plain?.reason).toBe('kept');
    const zoomed = planCaptionPlacements(project({ transform: { scale: 1.3, x: 0, y: 0 } }), [caption('c1', style)], steadyFace(0.3, 0.55))[0];
    expect(zoomed?.reason).not.toBe('kept');
  });

  it('maps source height through the same crop and zoompan geometry the renderer uses', () => {
    const clip: Clip = { id: 'c', start: 0, in: 0, out: 10, transform: { scale: 1.2, x: 0, y: 0 } };
    expect(sourceYToScreen(0.5, clip, 0, frame, frame)).toBeCloseTo(960);
    expect(sourceYToScreen(0.25, clip, 0, frame, frame)).toBeCloseTo(384);
    const animated: Clip = { ...clip, transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.2, x: 0, y: 0 } };
    expect(sourceYToScreen(0.25, animated, 0, frame, frame)).toBeCloseTo(480);
    // Once the zoom lands, the animated clip matches the static one.
    expect(sourceYToScreen(0.25, animated, 10, frame, frame)).toBeCloseTo(384);
  });
});
