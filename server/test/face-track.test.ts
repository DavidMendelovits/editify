import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess } from '../src/media/process.js';
import { faceAt, runFaceTrack, type FaceTrack } from '../src/services/face-service.js';

const python = process.env.PYTHON_BIN ?? 'python3';
const hasOpenCv = spawnSync(python, ['-c', 'import cv2'], { stdio: 'ignore' }).status === 0;

describe('faceAt', () => {
  const track: FaceTrack = {
    fps: 5, width: 1080, height: 1920,
    samples: [[0, 0.2, 0.4, 0.3, 0.7], [0.2, null], [0.4, null], [2.6, 0.3, 0.5, 0.3, 0.7]],
  };

  it('holds the last face across a short miss and lets go after a long one', () => {
    expect(faceAt(track, 0.4)).toEqual({ top: 0.2, bottom: 0.4, left: 0.3, right: 0.7 });
    expect(faceAt(track, 1.3)).toBeUndefined();
    expect(faceAt(track, 2.5)?.top).toBe(0.3);
  });
});

// OpenCV is optional (the Docker image installs it); without it placement only keeps the safe area.
describe.skipIf(!hasOpenCv)('face_track.py', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'editify-face-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('samples a faceless clip at 5 per second with the decoded frame size', async () => {
    const clip = join(directory, 'wall.mp4');
    await runProcess('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=2', '-pix_fmt', 'yuv420p', clip]);
    const track = await runFaceTrack(clip);
    expect(track).toMatchObject({ fps: 5, width: 360, height: 640 });
    expect(track.samples).toHaveLength(10);
    expect(track.samples.every((sample) => sample[1] === null)).toBe(true);
  }, 60_000);
});
