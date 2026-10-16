// The 5G reality check. Pure functions: numbers in, verdict out.
//
// A web page cannot read the radio technology of a phone, so the user tells us what the
// status bar says (the "claim") and we judge whether the measured performance matches it.
// Thresholds are practical heuristics, documented in the README.

import { median } from './stats.js';

export const CLAIMS = {
  '5g': { label: '5G', is5g: true },
  '5g-plus': { label: '5G+ / 5G UW / 5G Ace', is5g: true },
  '4g': { label: '4G / LTE', is5g: false },
  wifi: { label: 'Wi-Fi', is5g: false },
  unsure: { label: "Not sure", is5g: false },
};

/** Performance classes, best first. `minDown` is Mbps. */
export const TIERS = [
  { id: 'real5g-plus', label: '5G+ class', minDown: 300, rank: 5 },
  { id: 'real5g', label: 'Real 5G class', minDown: 100, rank: 4 },
  { id: 'weak5g', label: 'Entry 5G / strong 4G', minDown: 40, rank: 3 },
  { id: 'lte', label: '4G / LTE class', minDown: 10, rank: 2 },
  { id: 'slow', label: '3G class', minDown: 2, rank: 1 },
  { id: 'crawl', label: '2G class', minDown: 0, rank: 0 },
];

export const TARGETS = {
  down: 100, // Mbps, ITU IMT-2020 "user experienced" downlink target
  up: 20,
  ping: 30, // ms
  jitter: 15, // ms
};

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const logScale = (v, lo, hi) => clamp((Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)));
const linDown = (v, best, worst) => clamp((worst - v) / (worst - best));

export function tierFor({ down, ping, jitter }) {
  let tier = TIERS.find((t) => down >= t.minDown) || TIERS[TIERS.length - 1];
  // A fat pipe with poor latency does not feel like 5G: step down one class.
  const poorLatency = (Number.isFinite(ping) && ping > 60) || (Number.isFinite(jitter) && jitter > 30);
  if (poorLatency && tier.rank >= 4) tier = TIERS.find((t) => t.id === 'weak5g');
  return tier;
}

/** 0-100 score. Missing metrics are left out and the weights renormalised. */
export function score({ down, up, ping, jitter, loadedPing }) {
  const parts = [];
  if (Number.isFinite(down)) parts.push([0.45, logScale(down, 1, 300)]);
  if (Number.isFinite(up)) parts.push([0.15, logScale(up, 0.5, 60)]);
  if (Number.isFinite(ping)) parts.push([0.25, linDown(ping, 10, 90)]);
  if (Number.isFinite(jitter)) parts.push([0.1, linDown(jitter, 2, 40)]);
  if (Number.isFinite(loadedPing) && Number.isFinite(ping))
    parts.push([0.05, linDown(Math.max(0, loadedPing - ping), 10, 200)]);
  const w = parts.reduce((a, [x]) => a + x, 0);
  if (!w) return 0;
  return Math.round((parts.reduce((a, [x, v]) => a + x * v, 0) / w) * 100);
}

function rate(value, good, ok, lowerIsBetter) {
  if (!Number.isFinite(value)) return 'na';
  if (lowerIsBetter) return value <= good ? 'good' : value <= ok ? 'ok' : 'poor';
  return value >= good ? 'good' : value >= ok ? 'ok' : 'poor';
}

export function metricRatings(m) {
  return {
    down: rate(m.down, TARGETS.down, 40, false),
    up: rate(m.up, TARGETS.up, 5, false),
    ping: rate(m.ping, TARGETS.ping, 60, true),
    jitter: rate(m.jitter, TARGETS.jitter, 30, true),
    loaded: rate(Number.isFinite(m.loadedPing) && Number.isFinite(m.ping) ? m.loadedPing - m.ping : NaN, 40, 120, true),
  };
}

/**
 * @param {{down:number, up?:number, ping?:number, jitter?:number, loadedPing?:number}} m
 * @param {keyof CLAIMS} claim what the phone's status bar says
 */
export function judge(m, claim = 'unsure') {
  const c = CLAIMS[claim] || CLAIMS.unsure;
  const tier = tierFor(m);
  const sc = score(m);
  const ratings = metricRatings(m);
  const reasons = [];
  const reachedReal = tier.rank >= 4;

  if (Number.isFinite(m.down)) {
    const pct = Math.round((m.down / TARGETS.down) * 100);
    reasons.push(
      m.down >= TARGETS.down
        ? pct >= 300 ? `Download is more than ${Math.floor(pct / 100)}x the ${TARGETS.down} Mbps 5G reference.` : `Download is ${pct}% of the ${TARGETS.down} Mbps 5G reference.`
        : `Download is only ${pct}% of the ${TARGETS.down} Mbps 5G reference.`
    );
  }
  if (Number.isFinite(m.ping) && ratings.ping === 'poor') reasons.push(`Ping of ${Math.round(m.ping)} ms is slower than 5G should be (aim for ${TARGETS.ping} ms or less).`);
  if (Number.isFinite(m.jitter) && ratings.jitter === 'poor') reasons.push(`Jitter of ${m.jitter.toFixed(1)} ms makes calls and games stutter.`);
  if (ratings.loaded === 'poor') reasons.push('Latency spikes when the line is busy (bufferbloat).');
  if (Number.isFinite(m.up) && ratings.up === 'poor') reasons.push(`Upload is only ${m.up.toFixed(1)} Mbps.`);

  let verdict, headline, detail;
  if (c.is5g) {
    if (reachedReal) {
      verdict = 'real';
      headline = 'Real 5G. It performs like it says.';
      detail = `Your phone says ${c.label} and the numbers back it up: ${tier.label} speed with usable latency.`;
    } else if (tier.id === 'weak5g') {
      verdict = 'partial';
      headline = '5G in name, 4G-plus in practice.';
      detail = `Your phone says ${c.label} but you are getting entry-level 5G or strong LTE speed. Common on low-band 5G, a busy tower, or weak signal.`;
    } else {
      verdict = 'fake';
      headline = 'Fake 5G. Speeds are ' + tier.label.replace(' class', '') + ' level.';
      detail = `Your phone says ${c.label} but the connection behaves like ${tier.label}. The icon is lying. Try again closer to a window or outdoors, and compare at another time of day.`;
    }
  } else if (claim === 'wifi') {
    verdict = 'info';
    headline = reachedReal ? 'Wi-Fi is fast.' : tier.rank >= 3 ? 'Wi-Fi is decent.' : 'Wi-Fi is slow.';
    detail = `This line performs at ${tier.label} level. Zero5G judges 5G claims, so this is just a speed report for Wi-Fi.`;
  } else {
    verdict = 'info';
    headline = reachedReal ? 'This connection is 5G-class fast.' : `This connection is ${tier.label}.`;
    detail = claim === '4g'
      ? reachedReal ? 'Faster than 4G normally is. Carrier aggregation or a nearby 5G cell may be helping.' : 'That matches what 4G normally delivers.'
      : 'Pick what your phone shows in the status bar to get a real-or-fake verdict.';
  }
  return { verdict, headline, detail, tier, score: sc, ratings, reasons, claim, claimLabel: c.label };
}

/** Median of several runs, for the history summary. */
export function summariseRuns(runs) {
  const pick = (k) => median(runs.map((r) => r[k]).filter(Number.isFinite));
  return { down: pick('down'), up: pick('up'), ping: pick('ping'), jitter: pick('jitter') };
}
