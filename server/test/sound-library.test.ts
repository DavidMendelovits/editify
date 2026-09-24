import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measurePeakDb, synthesizeSound } from '../src/media/sound-library.js';

/**
 * #67: the recipes had no gain staging, so the two whooshes came out at around
 * -41 dBFS — audible only in theory. Every sound has to land near the same
 * peak, whatever its filtergraph does.
 */
describe('sound library levels', () => {
  let directory: string;

  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'editify-sounds-')); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  for (const id of ['whoosh-soft', 'whoosh-fast', 'impact-boom', 'ui-click']) {
    it(`renders ${id} loud enough to hear`, async () => {
      const path = join(directory, `${id}.m4a`);
      await synthesizeSound(id, path);
      const peak = await measurePeakDb(path);
      expect(peak).not.toBeNull();
      expect(peak ?? -Infinity).toBeGreaterThan(-6);
    }, 30_000);
  }
});
