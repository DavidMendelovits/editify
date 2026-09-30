import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { assetsRoot } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { UploadTooLargeError, capBytes } from '../src/routes/assets.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const scratch = mkdtempSync(join(tmpdir(), 'editify-raw-upload-'));
const created: string[] = [];

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const id of created) rmSync(join(assetsRoot, id), { recursive: true, force: true });
});

// The raw route exists because iOS buffers a whole multipart body in memory:
// a phone sends the file itself as the body, so memory stays flat at any size.
describe('POST /assets/raw', () => {
  it.skipIf(!hasFfmpeg)('stores a raw video body under the name from the query', async () => {
    const clip = join(scratch, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
    const app = await buildApp({ database: createDatabase(':memory:') });

    const response = await app.inject({
      method: 'POST',
      url: `/assets/raw?name=${encodeURIComponent('Beach day.mp4')}`,
      headers: { 'content-type': 'video/mp4' },
      payload: readFileSync(clip),
    });

    expect(response.statusCode).toBe(201);
    const asset = response.json<{ id: string; originalName: string; mimeType: string }>();
    created.push(asset.id);
    expect(asset).toMatchObject({ originalName: 'Beach day.mp4', mimeType: 'video/mp4' });
    // The proxy and thumbnail are made in the background; let that finish before the database closes.
    let status = 'processing';
    for (let tries = 0; status === 'processing' && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (await app.inject({ method: 'GET', url: `/assets/${asset.id}` })).json<{ status: string }>().status;
    }
    expect(status).toBe('ready');
    await app.close();
  });

  it('refuses a missing name and a non-media body before writing anything', async () => {
    const app = await buildApp({ database: createDatabase(':memory:') });

    const unnamed = await app.inject({ method: 'POST', url: '/assets/raw', headers: { 'content-type': 'video/mp4' }, payload: Buffer.from('x') });
    expect(unnamed.statusCode).toBe(400);

    const text = await app.inject({ method: 'POST', url: '/assets/raw?name=a.txt', headers: { 'content-type': 'text/plain' }, payload: 'hello' });
    expect(text.statusCode).toBe(415);
    await app.close();
  });

  it('fails the stream once the byte cap is crossed', async () => {
    const drain = async (source: AsyncIterable<unknown>): Promise<void> => { for await (const _chunk of source) { /* discard */ } };
    await expect(pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), capBytes(10), drain))
      .rejects.toBeInstanceOf(UploadTooLargeError);
    await expect(pipeline(Readable.from([Buffer.alloc(5), Buffer.alloc(5)]), capBytes(10), drain)).resolves.toBeUndefined();
  });
});
