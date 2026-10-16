import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, LIMITS } from '../server.js';

let server, base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.closeAllConnections(); server.close(); });

test('ping returns 204 with no-store', async () => {
  const r = await fetch(base + '/api/ping');
  assert.equal(r.status, 204);
  assert.match(r.headers.get('cache-control'), /no-store/);
});

test('download streams exactly the requested bytes', async () => {
  for (const n of [1, 1000, 262144, 262145, 1_500_000]) {
    const r = await fetch(base + '/api/download?bytes=' + n);
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers.get('content-length')), n);
    assert.equal((await r.arrayBuffer()).byteLength, n);
  }
});

test('download payload is not trivially compressible', async () => {
  const buf = Buffer.from(await (await fetch(base + '/api/download?bytes=65536')).arrayBuffer());
  assert.ok(new Set(buf).size > 200);
});

test('download rejects bad sizes', async () => {
  for (const q of ['', '0', '-5', 'abc', '1.5', String(LIMITS.maxDownloadBytes + 1)]) {
    const r = await fetch(base + '/api/download?bytes=' + q);
    assert.equal(r.status, 400, 'bytes=' + q);
  }
  assert.equal((await fetch(base + '/api/download?bytes=10', { method: 'POST' })).status, 405);
});

test('upload counts bytes', async () => {
  const body = Buffer.alloc(3_000_000, 7);
  const r = await fetch(base + '/api/upload', { method: 'POST', body });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { received: body.length });
  assert.equal((await fetch(base + '/api/upload')).status, 405);
});

test('upload over the limit is refused', async () => {
  const status = await new Promise((resolve) => {
    const req = http.request(base + '/api/upload', { method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('closed'));
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const write = () => {
      while (sent < LIMITS.maxUploadBytes + 4 * 1024 * 1024) {
        sent += chunk.length;
        if (!req.write(chunk)) return req.once('drain', write);
      }
      req.end();
    };
    write();
  });
  assert.ok(status === 413 || status === 'closed', String(status));
});

test('unknown api route is JSON 404', async () => {
  const r = await fetch(base + '/api/nope');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'not found' });
});

test('static: index, assets and content types', async () => {
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-type'), /text\/html/);
  assert.match(await idx.text(), /Zero5G/);
  assert.match((await fetch(base + '/js/app.js')).headers.get('content-type'), /javascript/);
  assert.match((await fetch(base + '/css/style.css')).headers.get('content-type'), /css/);
  assert.match((await fetch(base + '/favicon.svg')).headers.get('content-type'), /svg/);
});

test('static: path traversal is blocked', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fserver.js', '/js/../../server.js']) {
    const r = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.ok([403, 404].includes(r), p + ' -> ' + r);
  }
  assert.equal((await fetch(base + '/nope.html')).status, 404);
  assert.equal((await fetch(base + '/%')).status, 400);
});

test('security headers present', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('bundled fonts are served as woff2', async () => {
  for (const f of ['instrument-serif-latin-400-normal', 'ibm-plex-mono-latin-400-normal', 'hanken-grotesk-latin-400-normal']) {
    const r = await fetch(base + '/fonts/' + f + '.woff2');
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('content-type'), 'font/woff2');
  }
});
