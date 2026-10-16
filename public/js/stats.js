// Pure measurement maths. Shared by the browser app and the unit tests.

export const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/** Jitter = mean absolute difference between consecutive latency samples (RFC 3550 style, unsmoothed). */
export function jitter(samples) {
  if (samples.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1]);
  return sum / (samples.length - 1);
}

/** Summarise ping samples (ms). Drops the first sample (connection setup) when there are enough. */
export function summarisePing(raw) {
  const s = raw.length > 5 ? raw.slice(1) : raw.slice();
  if (!s.length) return { min: NaN, median: NaN, jitter: NaN, count: 0 };
  return { min: Math.min(...s), median: median(s), jitter: jitter(s), count: s.length };
}

/**
 * Steady-state throughput from cumulative samples [{t: ms, bytes: totalBytes}].
 * Ignores the first `warmupFrac` of the run (TCP slow start) and returns Mbps.
 */
export function steadyMbps(samples, warmupFrac = 0.25) {
  if (samples.length < 2) return 0;
  const t0 = samples[0].t;
  const tEnd = samples[samples.length - 1].t;
  const cutoff = t0 + (tEnd - t0) * warmupFrac;
  let start = samples.find((s) => s.t >= cutoff) || samples[0];
  const end = samples[samples.length - 1];
  const dt = (end.t - start.t) / 1000;
  if (dt <= 0) return 0;
  return ((end.bytes - start.bytes) * 8) / dt / 1e6;
}

/** Instantaneous Mbps over a trailing window, for the live gauge. */
export function windowMbps(samples, windowMs = 500) {
  if (samples.length < 2) return 0;
  const end = samples[samples.length - 1];
  let start = samples[0];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (end.t - samples[i].t >= windowMs) { start = samples[i]; break; }
  }
  const dt = (end.t - start.t) / 1000;
  return dt > 0 ? ((end.bytes - start.bytes) * 8) / dt / 1e6 : 0;
}

export function fmtMbps(v) {
  if (!Number.isFinite(v)) return '-';
  if (v >= 1000) return (v / 1000).toFixed(2) + ' Gbps';
  if (v >= 100) return Math.round(v) + ' Mbps';
  if (v >= 10) return v.toFixed(1) + ' Mbps';
  return v.toFixed(2) + ' Mbps';
}

export function fmtMs(v) {
  if (!Number.isFinite(v)) return '-';
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ms';
}
