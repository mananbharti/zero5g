import test from 'node:test';
import assert from 'node:assert/strict';
import { median, mean, jitter, summarisePing, steadyMbps, windowMbps, fmtMbps, fmtMs } from '../public/js/stats.js';
import { judge, tierFor, score, metricRatings, TIERS, CLAIMS, summariseRuns } from '../public/js/verdict.js';
import { toSeries } from '../public/js/chart.js';

test('median and mean', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(mean([2, 4]), 3);
});

test('jitter is mean absolute consecutive difference', () => {
  assert.equal(jitter([10, 10, 10]), 0);
  assert.equal(jitter([10, 20, 10]), 10);
  assert.equal(jitter([5]), 0);
});

test('summarisePing drops the connection-setup sample when enough samples exist', () => {
  const s = summarisePing([200, 20, 22, 21, 20, 23, 22]);
  assert.equal(s.count, 6);
  assert.equal(s.min, 20);
  assert.ok(s.median < 25);
  const few = summarisePing([50, 60]);
  assert.equal(few.count, 2);
  assert.equal(summarisePing([]).count, 0);
});

test('steadyMbps ignores warm-up and converts to Mbps', () => {
  // 0-1s slow (1 MB), then 12.5 MB/s = 100 Mbps for 3 seconds
  const samples = [{ t: 0, bytes: 0 }, { t: 1000, bytes: 1e6 }];
  for (let i = 1; i <= 30; i++) samples.push({ t: 1000 + i * 100, bytes: 1e6 + i * 1.25e6 });
  const v = steadyMbps(samples, 0.25);
  assert.ok(Math.abs(v - 100) < 1, 'got ' + v);
  assert.equal(steadyMbps([]), 0);
  assert.equal(steadyMbps([{ t: 0, bytes: 0 }]), 0);
});

test('windowMbps uses a trailing window', () => {
  const s = [];
  for (let i = 0; i <= 20; i++) s.push({ t: i * 100, bytes: i * 125000 }); // 10 Mbps
  assert.ok(Math.abs(windowMbps(s, 500) - 10) < 0.01);
});

test('formatters', () => {
  assert.equal(fmtMbps(1500), '1.50 Gbps');
  assert.equal(fmtMbps(250.4), '250 Mbps');
  assert.equal(fmtMbps(42.34), '42.3 Mbps');
  assert.equal(fmtMbps(3.456), '3.46 Mbps');
  assert.equal(fmtMbps(NaN), '-');
  assert.equal(fmtMs(12.345), '12.3 ms');
  assert.equal(fmtMs(130.4), '130 ms');
});

test('tier boundaries', () => {
  const t = (down, ping = 20, jitter = 5) => tierFor({ down, ping, jitter }).id;
  assert.equal(t(350), 'real5g-plus');
  assert.equal(t(100), 'real5g');
  assert.equal(t(99.9), 'weak5g');
  assert.equal(t(40), 'weak5g');
  assert.equal(t(39), 'lte');
  assert.equal(t(10), 'lte');
  assert.equal(t(5), 'slow');
  assert.equal(t(0.5), 'crawl');
  assert.equal(TIERS.length, 6);
});

test('great speed with terrible latency is demoted', () => {
  assert.equal(tierFor({ down: 500, ping: 120, jitter: 5 }).id, 'weak5g');
  assert.equal(tierFor({ down: 500, ping: 20, jitter: 50 }).id, 'weak5g');
  assert.equal(tierFor({ down: 500, ping: 20, jitter: 5 }).id, 'real5g-plus');
});

test('score is monotonic and bounded', () => {
  const good = score({ down: 400, up: 60, ping: 10, jitter: 2, loadedPing: 15 });
  const mid = score({ down: 60, up: 10, ping: 40, jitter: 10, loadedPing: 80 });
  const bad = score({ down: 1, up: 0.5, ping: 120, jitter: 60, loadedPing: 600 });
  assert.ok(good >= 95 && good <= 100, 'good ' + good);
  assert.ok(mid > bad && good > mid, `${good} ${mid} ${bad}`);
  assert.ok(bad <= 10, 'bad ' + bad);
  assert.equal(score({}), 0);
  assert.ok(score({ down: 100 }) > 0);
});

test('metric ratings', () => {
  const r = metricRatings({ down: 150, up: 3, ping: 45, jitter: 50, loadedPing: 400 });
  assert.deepEqual([r.down, r.up, r.ping, r.jitter, r.loaded], ['good', 'poor', 'ok', 'poor', 'poor']);
  assert.equal(metricRatings({ down: 10 }).ping, 'na');
});

test('verdict: claims 5G and delivers', () => {
  const j = judge({ down: 220, up: 40, ping: 22, jitter: 4, loadedPing: 40 }, '5g');
  assert.equal(j.verdict, 'real');
  assert.match(j.headline, /Real 5G/);
});

test('verdict: claims 5G+ and gets 4G speeds is fake', () => {
  const j = judge({ down: 8, up: 2, ping: 70, jitter: 20, loadedPing: 300 }, '5g-plus');
  assert.equal(j.verdict, 'fake');
  assert.match(j.headline, /Fake 5G/);
  assert.ok(j.reasons.length >= 2);
});

test('verdict: claims 5G at crawl speed names the class', () => {
  const j = judge({ down: 1, up: 0.3, ping: 200, jitter: 80 }, '5g');
  assert.equal(j.verdict, 'fake');
  assert.match(j.headline, /2G/);
});

test('verdict: in-between is partial', () => {
  const j = judge({ down: 55, up: 12, ping: 35, jitter: 9, loadedPing: 70 }, '5g');
  assert.equal(j.verdict, 'partial');
});

test('verdict: exactly at the real-5G line passes', () => {
  assert.equal(judge({ down: 100, up: 20, ping: 30, jitter: 15 }, '5g').verdict, 'real');
});

test('verdict: non-5G claims give info, never real/fake', () => {
  for (const c of ['4g', 'wifi', 'unsure']) {
    assert.equal(judge({ down: 300, up: 50, ping: 15, jitter: 3 }, c).verdict, 'info');
    assert.equal(judge({ down: 3, up: 1, ping: 90, jitter: 30 }, c).verdict, 'info');
  }
  assert.match(judge({ down: 300, up: 50, ping: 15, jitter: 3 }, '4g').detail, /Faster than 4G/);
});

test('verdict: unknown claim falls back to unsure', () => {
  assert.equal(judge({ down: 50, ping: 20, jitter: 2 }, 'nonsense').verdict, 'info');
  assert.ok(CLAIMS['5g'].is5g && !CLAIMS.wifi.is5g);
});

test('summariseRuns takes medians and skips NaN', () => {
  const s = summariseRuns([{ down: 10, up: 1, ping: 20, jitter: NaN }, { down: 30, up: 3, ping: 40, jitter: 4 }, { down: 20, up: 2, ping: 30, jitter: 6 }]);
  assert.equal(s.down, 20);
  assert.equal(s.jitter, 5);
});

test('toSeries yields a per-window Mbps series', () => {
  const s = [];
  for (let i = 0; i <= 20; i++) s.push({ t: i * 100, bytes: i * 125000 });
  const out = toSeries(s, 500);
  assert.ok(out.length > 10);
  assert.ok(Math.abs(out[out.length - 1].v - 10) < 0.01);
});

test('reasons stay readable for very fast links and tier names keep their case', () => {
  const j = judge({ down: 4600, up: 3000, ping: 3, jitter: 1 }, '5g');
  assert.match(j.reasons[0], /more than 46x/);
  assert.match(j.detail, /5G\+ class/);
});
