// Zero5G server: static files + the measurement endpoints. No runtime dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
export const LIMITS = {
  maxDownloadBytes: 100 * 1024 * 1024,
  maxUploadBytes: 64 * 1024 * 1024,
  maxActive: 64,
};
const CHUNK = crypto.randomBytes(256 * 1024); // incompressible payload, reused

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

export function createServer() {
  let active = 0;
  const label = process.env.ZERO5G_SERVER_LABEL || 'This server';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/ping') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
      return send(res, 204, null);
    }
    if (p === '/api/health') return json(res, 200, { ok: true });
    if (p === '/api/info') return json(res, 200, { name: 'Zero5G', server: label, limits: LIMITS });

    if (p === '/api/download') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method' });
      const bytes = Number(url.searchParams.get('bytes'));
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > LIMITS.maxDownloadBytes)
        return json(res, 400, { error: 'bytes must be an integer between 1 and ' + LIMITS.maxDownloadBytes });
      if (active >= LIMITS.maxActive) return json(res, 503, { error: 'busy' });
      active++;
      let done = false;
      const finish = () => { if (!done) { done = true; active--; } };
      res.writeHead(200, {
        ...SECURITY,
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes,
        'Cache-Control': 'no-store, no-transform',
      });
      let left = bytes;
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, CHUNK.length);
          left -= n;
          const ok = res.write(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n));
          if (!ok && left > 0) return res.once('drain', pump);
        }
        res.end();
      };
      res.on('close', finish);
      pump();
      return;
    }

    if (p === '/api/upload') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      if (active >= LIMITS.maxActive) return json(res, 503, { error: 'busy' });
      active++;
      let received = 0;
      let aborted = false;
      let done = false;
      const finish = () => { if (!done) { done = true; active--; } };
      req.on('data', (c) => {
        received += c.length;
        if (received > LIMITS.maxUploadBytes && !aborted) {
          aborted = true;
          json(res, 413, { error: 'too large' });
          req.destroy();
        }
      });
      req.on('end', () => { if (!aborted) json(res, 200, { received }); finish(); });
      req.on('error', finish);
      req.on('close', finish);
      return;
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try { rel = decodeURIComponent(p); } catch { return send(res, 400, 'Bad request'); }
    if (rel.includes('\0')) return send(res, 400, 'Bad request');
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, {
        ...SECURITY,
        'Content-Type': type,
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
  server.keepAliveTimeout = 30000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  createServer().listen(port, host, () => {
    console.log(`Zero5G running on http://localhost:${port}`);
  });
}
