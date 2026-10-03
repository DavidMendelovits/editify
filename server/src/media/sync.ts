import { spawn } from 'node:child_process';
import { MAX_SYNC_SECONDS, SYNC_SAMPLE_RATE, SyncError, measureSyncSteps, type SyncMeasurement } from '@editify/shared';

// The measurement itself is pure and lives in @editify/shared; this file only decodes.
export {
  MAX_SYNC_SECONDS,
  SYNC_SAMPLE_RATE,
  SyncError,
  crossCorrelate,
  measureSync,
  type FineMatch,
  type SyncMeasurement,
} from '@editify/shared';

/** A decode this slow is stuck (a network mount, a pathological file), not busy. */
const DECODE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Decode a media file's first audio stream to mono float PCM at
 * `SYNC_SAMPLE_RATE`, stopping at `maxSeconds`. Samples are written into one
 * buffer as they arrive rather than collected and joined, so the peak is one
 * copy of the audio, not three.
 */
export async function decodeMono(path: string, maxSeconds = MAX_SYNC_SECONDS): Promise<Float32Array> {
  return await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error', '-nostdin', '-i', path, '-vn', '-map', '0:a:0', '-t', String(maxSeconds),
      '-ac', '1', '-ar', String(SYNC_SAMPLE_RATE), '-f', 'f32le', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const limit = Math.ceil(maxSeconds * SYNC_SAMPLE_RATE) * 4;
    let bytes = new Uint8Array(Math.min(limit, 1 << 22));
    let length = 0;
    let stderr = '';
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      // The stderr names server paths; it stays out of what a client is told.
      reject(new SyncError('Could not read the audio in one of these recordings'));
    };
    const timer = setTimeout(fail, DECODE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      const room = Math.min(chunk.byteLength, limit - length);
      if (length + room > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(limit, Math.max(bytes.byteLength * 2, length + room)));
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(chunk.subarray(0, room), length);
      length += room;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', fail);
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timer);
      // A fresh Uint8Array starts at offset 0, so viewing it as floats needs no copy.
      resolve(new Float32Array(bytes.buffer, 0, Math.floor(length / 4)));
    });
  });
}

export async function measureSyncFiles(videoPath: string, memoPath: string): Promise<SyncMeasurement> {
  // One at a time: two decodes at once doubles the memory peak for no gain on a busy server.
  const video = await decodeMono(videoPath);
  const memo = await decodeMono(memoPath);
  const steps = measureSyncSteps(video, memo);
  // Hand the event loop back between stages, so an hour-long measurement
  // costs other requests a few short pauses instead of one long stall.
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

