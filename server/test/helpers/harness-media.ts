import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Where the engine harnesses keep the media they synthesize (HARNESS_MEDIA_DIR, read by
 * `synthesized(...)` in parity/render-golden/HarnessMedia.swift). The videos go through the
 * hardware encoder, whose output moves by a few codes between runs under load, so they are
 * made once per test run and shared by both adapter sets: the Mutable-vs-Configuration
 * comparison then sees the same source bytes and holds byte for byte.
 *
 * HARNESS_MEDIA_CACHE (the macOS CI engine job sets it, and caches the directory) keeps them
 * across runs too, under the hash of HarnessMedia.swift: a change to the synthesis code starts
 * a fresh set, and inside a set each file is named by the hash of its spec.
 */
const harnessMedia = resolve(fileURLToPath(import.meta.url), '../../../../apps/mobile/modules/editify-engine/parity/render-golden/HarnessMedia.swift');

export function harnessMediaEnv(scratch: string): { HARNESS_MEDIA_DIR: string } {
  const cache = process.env.HARNESS_MEDIA_CACHE;
  const synthesis = createHash('sha256').update(readFileSync(harnessMedia)).digest('hex').slice(0, 16);
  const dir = cache ? join(cache, synthesis) : join(scratch, 'media');
  mkdirSync(dir, { recursive: true });
  return { HARNESS_MEDIA_DIR: dir };
}
