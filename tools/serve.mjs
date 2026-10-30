/**
 * Zero-dependency static dev server. Qoder ships an Electron binary that can
 * act as Node, so the iPad can reach this over Wi-Fi without an install step.
 *
 *   ELECTRON_RUN_AS_NODE=1 Qoder.exe tools/serve.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const port = Number(process.argv[2] || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

// iPad Safari refuses to run an AudioWorklet without a secure context, so a
// self-signed cert would be needed for anything beyond localhost. Serve plain
// HTTP and note that the iPad must use http://<this-host>:<port> directly.
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let file = path;
    const info = await stat(file).catch(() => null);
    if (info && info.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(port, '0.0.0.0', () => {
  const nets = Object.values(networkInterfaces()).flat();
  const ips = nets.filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log(`serving ${root}`);
  console.log(`  local:   http://localhost:${port}`);
  for (const ip of ips) console.log(`  network: http://${ip}:${port}`);
});
