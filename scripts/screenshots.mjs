// Regenerates the README screenshots in docs/ using headless Chrome.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from '../server.js';

const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
fs.mkdirSync('docs', { recursive: true });

async function run({ name, width, height, mobile, throttle, claim, midTest }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: !!mobile, hasTouch: !!mobile });
  if (throttle) {
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: throttle.latency, downloadThroughput: (throttle.down * 1e6) / 8, uploadThroughput: (throttle.up * 1e6) / 8 });
  }
  await page.goto(base + '/?quick=1', { waitUntil: 'networkidle0' });
  if (claim) await page.click(`[data-claim="${claim}"]`);
  if (name.includes('idle')) { await page.screenshot({ path: `docs/${name}.png` }); await ctx.close(); return; }
  await page.click('#start');
  if (midTest) {
    await page.waitForFunction(() => document.getElementById('gPhase').textContent === 'Download' && parseFloat(document.getElementById('gValue').textContent) > 1, { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: `docs/${name}.png` });
  } else {
    await page.waitForFunction(() => !document.getElementById('verdict').classList.contains('hidden'), { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `docs/${name}-top.png` });
    const v = await page.$('#verdict');
    await v.screenshot({ path: `docs/${name}.png` });
  }
  await ctx.close();
}

await run({ name: 'desktop-idle', width: 1280, height: 860 });
await run({ name: 'desktop-testing', width: 1280, height: 860, midTest: true, throttle: { latency: 30, down: 60, up: 20 } });
await run({ name: 'verdict-real', width: 1280, height: 860, claim: '5g' });
await run({ name: 'verdict-fake', width: 1280, height: 860, claim: '5g', throttle: { latency: 70, down: 6, up: 2 } });
await run({ name: 'mobile-idle', width: 390, height: 844, mobile: true });
await run({ name: 'mobile-verdict-fake', width: 390, height: 844, mobile: true, claim: '5g', throttle: { latency: 70, down: 6, up: 2 } });
await browser.close(); server.closeAllConnections(); server.close();
console.log('screenshots written to docs/');
