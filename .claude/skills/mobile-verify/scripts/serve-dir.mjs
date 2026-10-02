#!/usr/bin/env node
// Static file server for the reviews folder, with HTTP Range so videos seek.
// Loopback only; serve-tailnet.sh puts `tailscale serve` in front of it (the
// Mac App Store tailscaled cannot serve a folder itself: sandbox).
//
//   node serve-dir.mjs <root> [port=8791]
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 8791);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.css': 'text/css', '.js': 'text/javascript',
};

createServer((request, response) => {
  let path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  const file = normalize(join(root, path));
  if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  let target = file;
  let stat;
  try {
    stat = statSync(target);
    if (stat.isDirectory()) {
      if (!path.endsWith('/')) { response.writeHead(301, { Location: `${path}/` }).end(); return; }
      target = join(target, 'index.html');
      stat = statSync(target);
    }
  } catch { response.writeHead(404).end('not found'); return; }
  const headers = { 'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(target, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(target).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
