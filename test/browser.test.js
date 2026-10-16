// End-to-end checks in real headless Chrome against a real server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from '../server.js';

const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2); }

// BASE_URL=https://your-host runs the same checks against a deployed instance.
const REMOTE = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : null;
const server = REMOTE ? null : createServer();
if (server) await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = REMOTE || 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });

let passed = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); passed++; results.push('ok   ' + name); }
  catch (e) { results.push('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; }
}

async function newPage({ width = 1280, height = 900, mobile = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.ctx = context;
  await page.setViewport({ width, height, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.type() + ': ' + m.text()); });
  page.problems = problems;
  return page;
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
const waitDone = (page, ms = 60000) => page.waitForFunction(() => !document.getElementById('verdict').classList.contains('hidden'), { timeout: ms });

await t('page loads with no console errors or CSP violations', async () => {
  const page = await newPage();
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  assert.match(await page.title(), /Zero5G/);
  assert.equal(await page.$eval('#quick', (e) => e.checked), true, 'quick param');
  assert.deepEqual(page.problems, []);
  await page.close();
});

await t('custom fonts actually load', async () => {
  const page = await newPage();
  await page.goto(base, { waitUntil: 'networkidle0' });
  const ok = await page.evaluate(async () => { await document.fonts.ready; return ['Instrument Serif', 'Plex Mono', 'Hanken'].map((f) => document.fonts.check('16px "' + f + '"')); });
  assert.deepEqual(ok, [true, true, true]);
  const fam = await page.$eval('h1', (h) => getComputedStyle(h).fontFamily);
  assert.match(fam, /Instrument Serif/);
  await page.close();
});

await t('claim chips: click, keyboard arrows, persistence', async () => {
  const page = await newPage();
  await page.goto(base, { waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('[data-claim="5g"]', (e) => e.getAttribute('aria-checked')), 'true');
  await page.click('[data-claim="4g"]');
  assert.equal(await page.$eval('[data-claim="4g"]', (e) => e.getAttribute('aria-checked')), 'true');
  assert.equal(await page.$eval('[data-claim="5g"]', (e) => e.getAttribute('aria-checked')), 'false');
  await page.focus('[data-claim="4g"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('[data-claim="wifi"]', (e) => e.getAttribute('aria-checked')), 'true');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.$eval('[data-claim="5g"]', (e) => e.getAttribute('aria-checked')), 'true');
  await page.keyboard.press('ArrowLeft'); // wraps to last
  assert.equal(await page.$eval('[data-claim="unsure"]', (e) => e.getAttribute('aria-checked')), 'true');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('[data-claim="unsure"]', (e) => e.getAttribute('aria-checked')), 'true', 'persisted');
  await page.close();
});

await t('full quick run on a fast link: real 5G verdict, tiles, history, no errors', async () => {
  const page = await newPage();
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  await page.click('[data-claim="5g"]');
  await page.click('#start');
  assert.equal(await page.$eval('#start', (e) => e.disabled), true, 'start disabled while testing');
  assert.equal(await page.$eval('body', (b) => b.classList.contains('testing')), true);
  await waitDone(page);
  if (REMOTE) assert.match(await text(page, '#vBadge'), /^(REAL 5G|PARTIAL|FAKE 5G)$/); // real internet: any verdict is valid
  else { assert.equal(await text(page, '#vBadge'), 'REAL 5G'); assert.match(await text(page, '#vHead'), /Real 5G/); }
  const down = await text(page, '#vDown'); const up = await text(page, '#vUp');
  assert.match(down, /\d.*(Mbps|Gbps)/); assert.match(up, /\d.*(Mbps|Gbps)/);
  assert.match(await text(page, '#vPing'), /ms$/);
  assert.match(await text(page, '#vJitter'), /ms$/);
  assert.match(await text(page, '#vLoaded'), /ms$/);
  if (!REMOTE) assert.ok(Number(await text(page, '#sNum')) >= 80);
  assert.equal(await page.$$eval('.bar-row', (r) => r.length), 4);
  assert.equal(await page.$eval('#start', (e) => e.disabled), false, 'start re-enabled');
  assert.equal(await page.$$eval('#historyList li', (l) => l.length), 1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('zero5g.history.v1')));
  assert.equal(stored.length, 1); assert.equal(stored[0].verdict, 'real');
  // chart actually drew something
  const drawn = await page.$eval('#chart', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  assert.ok(drawn > 500, 'chart pixels ' + drawn);
  assert.deepEqual(page.problems, []);
  await page.close();
});

await t('throttled to 4G-like speed with a 5G claim: FAKE verdict', async () => {
  const page = await newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 70, downloadThroughput: (6 * 1e6) / 8, uploadThroughput: (2 * 1e6) / 8 });
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  await page.click('[data-claim="5g-plus"]');
  await page.click('#start');
  await waitDone(page, 90000);
  assert.equal(await text(page, '#vBadge'), 'FAKE 5G');
  assert.match(await text(page, '#vHead'), /Fake 5G/);
  const mbps = parseFloat(await text(page, '#vDown'));
  assert.ok(mbps > 1 && mbps < 12, 'throttled download measured ' + mbps);
  assert.ok(parseFloat(await text(page, '#vPing')) > 60, 'ping reflects latency');
  assert.equal(await page.$eval('[data-k=down]', (e) => e.classList.contains('poor')), true);
  assert.ok(Number(await text(page, '#sNum')) < 40);
  await page.close();
});

await t('non-5G claim gives a speed report, not real/fake', async () => {
  const page = await newPage();
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  await page.click('[data-claim="wifi"]');
  await page.click('#start'); await waitDone(page);
  assert.equal(await text(page, '#vBadge'), 'SPEED REPORT');
  await page.close();
});

await t('stop button cancels cleanly and the app can run again', async () => {
  const page = await newPage();
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  await page.click('#start');
  await page.waitForFunction(() => document.getElementById('gPhase').textContent === 'Download', { timeout: 20000 });
  await page.click('#stop');
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Test stopped.', { timeout: 10000 });
  assert.equal(await page.$eval('#start', (e) => e.disabled), false);
  assert.equal(await page.$eval('#verdict', (e) => e.classList.contains('hidden')), true);
  await page.click('#start'); await waitDone(page);
  assert.equal(await page.$$eval('#historyList li', (l) => l.length), 1, 'cancelled run not saved');
  assert.deepEqual(page.problems.filter((p) => !/aborted|AbortError|net::ERR_ABORTED/i.test(p)), []);
  await page.close();
});

await t('server failure shows an error and recovers', async () => {
  const page = await newPage();
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().includes('/api/ping') ? r.respond({ status: 500, body: 'x' }) : r.continue()));
  await page.click('#start');
  await page.waitForFunction(() => document.getElementById('status').classList.contains('error'), { timeout: 15000 });
  assert.match(await text(page, '#status'), /Ping failed/);
  assert.equal(await page.$eval('#start', (e) => e.disabled), false);
  await page.close();
});

await t('share image and copy summary work', async () => {
  const page = await newPage();
  await page.ctx.overridePermissions(base, ['clipboard-read', 'clipboard-write']);
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  await page.click('#start'); await waitDone(page);
  await page.bringToFront();
  await page.click('#copy');
  await page.waitForFunction(() => document.getElementById('shareNote').textContent.includes('copied'));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^Zero5G: /); assert.match(clip, /Download .*Upload .*Ping .*Jitter/);
  // the PNG card renders at 1080x1080 with real pixels
  const info = await page.evaluate(async () => {
    const m = await import('/js/share.js');
    const c = m.renderCard({ down: 120, up: 30, ping: 20, jitter: 3 }, { verdict: 'real', headline: 'Real 5G. It performs like it says.', claimLabel: '5G', score: 88 });
    const blob = await m.canvasToBlob(c);
    return { w: c.width, h: c.height, type: blob.type, size: blob.size };
  });
  assert.deepEqual([info.w, info.h, info.type], [1080, 1080, 'image/png']);
  assert.ok(info.size > 10000);
  await page.click('#share');
  await page.waitForFunction(() => /saved|Shared/.test(document.getElementById('shareNote').textContent));
  await page.close();
});

await t('history clears', async () => {
  const page = await newPage();
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  await page.click('#start'); await waitDone(page);
  await page.click('#clearHistory');
  assert.equal(await page.$$eval('#historyList li', (l) => l.length), 0);
  assert.equal(await page.$eval('#historyEmpty', (e) => e.classList.contains('hidden')), false);
  await page.close();
});

await t('mobile layout: no horizontal overflow, tap targets >= 44px', async () => {
  const page = await newPage({ width: 390, height: 844, mobile: true });
  await page.goto(base, { waitUntil: 'networkidle0' });
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    small: [...document.querySelectorAll('button, .chip')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.id || b.textContent) }));
  assert.ok(m.sw <= m.cw, `overflow ${m.sw} > ${m.cw}`);
  assert.deepEqual(m.small, []);
  await page.close();
});

await t('no accessibility basics missing: lang, labels, live region, radio roles', async () => {
  const page = await newPage();
  await page.goto(base, { waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('html', (h) => h.lang), 'en');
  assert.equal(await page.$$eval('[role=radio]', (r) => r.length), 5);
  assert.equal(await page.$eval('#status', (e) => e.getAttribute('role')), 'status');
  const unnamed = await page.$$eval('button', (bs) => bs.filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label')).length);
  assert.equal(unnamed, 0);
  await page.close();
});

await browser.close();
if (server) { server.closeAllConnections(); server.close(); }
console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} browser checks passed`);
