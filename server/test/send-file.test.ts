import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { sendMediaFile } from '../src/media/send-file.js';

async function serve(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'editify-range-'));
  const path = join(directory, 'file.mp4');
  await writeFile(path, body);
  const app = Fastify();
  app.get('/file.mp4', async (request, reply) => await sendMediaFile(reply, path, 'video/mp4', request.headers.range));
  return app;
}

describe('sendMediaFile', () => {
  it('serves whole files with a length players can plan against', async () => {
    const app = await serve('0123456789');
    const response = await app.inject({ url: '/file.mp4' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-length']).toBe('10');
    expect(response.body).toBe('0123456789');
  });

  it('answers ranges with 206 and the requested slice', async () => {
    const app = await serve('0123456789');
    const closed = await app.inject({ url: '/file.mp4', headers: { range: 'bytes=2-4' } });
    expect(closed.statusCode).toBe(206);
    expect(closed.headers['content-range']).toBe('bytes 2-4/10');
    expect(closed.body).toBe('234');

    const open = await app.inject({ url: '/file.mp4', headers: { range: 'bytes=8-' } });
    expect(open.body).toBe('89');

    const suffix = await app.inject({ url: '/file.mp4', headers: { range: 'bytes=-3' } });
    expect(suffix.body).toBe('789');
  });

  it('rejects ranges past the end of the file', async () => {
    const app = await serve('0123456789');
    const response = await app.inject({ url: '/file.mp4', headers: { range: 'bytes=20-30' } });
    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */10');
  });
});
