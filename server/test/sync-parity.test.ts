import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncError, measureSync, type SyncMeasurement } from '../src/media/sync.js';
import { capture, performance, reverberant } from './helpers/sync-fixtures.js';

/*
 * Decision 1A: the phone syncs with a Swift/vDSP port of packages/shared/src/sync.ts. This test is
 * what makes that safe: identical PCM through both, same answer or CI fails.
 * Needs swiftc (macOS); the path-filtered macOS CI job runs it, Linux skips.
 *
 *   fixture PCM ──▶ measureSync (TS spec) ─┐
 *              └─▶ sync-parity (Swift) ────┴─▶ lag ±2 ms, rate ±5 ppm, same verdict
 */
const engine = resolve(fileURLToPath(import.meta.url), '../../../apps/mobile/modules/editify-engine');
const hasSwift = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;

let dir: string;
let binary: string;

beforeAll(() => {
  if (!hasSwift) return;
  dir = mkdtempSync(join(tmpdir(), 'editify-parity-'));
  binary = join(dir, 'sync-parity');
  execFileSync('xcrun', ['swiftc', '-O', join(engine, 'ios/Core/AudioSync.swift'), join(engine, 'parity/main.swift'), '-o', binary]);
}, 120000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Swift = Pick<SyncMeasurement, 'lag' | 'anchor' | 'rate' | 'confident' | 'coarseRatio' | 'fineScore' | 'windows'> & { driftSec?: number; error?: string };

function swift(video: Float32Array, memo: Float32Array): Swift {
  const videoPath = join(dir, 'video.f32');
  const memoPath = join(dir, 'memo.f32');
  writeFileSync(videoPath, Buffer.from(video.buffer, video.byteOffset, video.byteLength));
  writeFileSync(memoPath, Buffer.from(memo.buffer, memo.byteOffset, memo.byteLength));
  return JSON.parse(execFileSync(binary, [videoPath, memoPath], { encoding: 'utf8', maxBuffer: 1 << 20 })) as Swift;
}

function expectParity(video: Float32Array, memo: Float32Array): void {
  const spec = measureSync(video, memo);
  const port = swift(video, memo);
  expect(port.confident).toBe(spec.confident);
  expect(Math.abs(port.lag - spec.lag)).toBeLessThan(0.002);
  expect(Math.abs(port.rate - spec.rate)).toBeLessThan(5e-6);
  expect(port.windows).toHaveLength(spec.windows.length);
  expect(port.driftSec === undefined).toBe(spec.driftSec === undefined);
}

const show = performance(120, 1);

describe.skipIf(!hasSwift)('Swift AudioSync matches sync.ts', () => {
  it('memo started before the camera', () => {
    expectParity(capture(show, { from: 12.3456, seconds: 60, gain: 0.4, echo: 0.021, noise: 0.01 }),
      capture(show, { from: 0, seconds: 100, gain: 1.3, noise: 0.005, seed: 9 }));
  });

  it('memo started after the camera', () => {
    expectParity(capture(show, { from: 3, seconds: 90, gain: 0.5, echo: 0.013, noise: 0.02 }),
      capture(show, { from: 20.5, seconds: 40, noise: 0.01, seed: 3 }));
  });

  it('clock drift across a long overlap', () => {
    const long = performance(700, 2);
    expectParity(capture(long, { from: 30, seconds: 600, gain: 0.4, noise: 0.01 }),
      capture(long, { from: 0, seconds: 660, drift: 60e-6, seed: 5 }));
  }, 60000);

  it('reverberant room: coarse-only fallback', () => {
    const long = performance(90, 3);
    expectParity(reverberant(long, { from: 12, seconds: 60, rt: 0.8, direct: 0.05, noise: 0.05 }), long.subarray(0, 90 * 8000));
  });

  it('unrelated recordings stay unconfident', () => {
    expectParity(capture(performance(60, 11), { from: 0, seconds: 60 }), capture(performance(60, 12), { from: 0, seconds: 60 }));
  });

  it('silence is refused by both', () => {
    const video = capture(show, { from: 0, seconds: 20 });
    const memo = new Float32Array(20 * 8000);
    expect(() => measureSync(video, memo)).toThrow(SyncError);
    expect(swift(video, memo).error).toBe('silent');
  });
});
