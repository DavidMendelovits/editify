import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply } from 'fastify';

/**
 * Serve a media file with byte-range support. Players (AVPlayer on iOS, <video>
 * on web) need `Accept-Ranges` + `Content-Length` to start playback at all, and
 * 206 responses to seek — without them the preview stays blank and scrubbing
 * garbles the audio.
 */
export async function sendMediaFile(
  reply: FastifyReply,
  path: string,
  type: string,
  range: string | undefined,
): Promise<FastifyReply> {
  const { size } = await stat(path);
  reply.type(type).header('Accept-Ranges', 'bytes');
  const match = /^bytes=(\d*)-(\d*)$/.exec(range?.trim() ?? '');
  if (!match || (!match[1] && !match[2])) {
    return reply.header('Content-Length', size).send(createReadStream(path));
  }
  // `bytes=-500` means the last 500 bytes; otherwise an open end runs to EOF.
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  }
  return reply
    .code(206)
    .header('Content-Range', `bytes ${start}-${end}/${size}`)
    .header('Content-Length', end - start + 1)
    .send(createReadStream(path, { start, end }));
}
