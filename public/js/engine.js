// Speed test engine: latency, parallel download, parallel upload, loaded latency.
import { summarisePing, steadyMbps, windowMbps } from './stats.js';

export const PRESETS = {
  full: { pingCount: 20, downMs: 8000, upMs: 8000, streams: 4 },
  quick: { pingCount: 8, downMs: 2500, upMs: 2500, streams: 4 },
};

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2);

export class Cancelled extends Error {
  constructor() { super('Test cancelled'); this.name = 'Cancelled'; }
}

async function pingOnce(signal) {
  const t = now();
  const res = await fetch('/api/ping?r=' + rnd(), { cache: 'no-store', signal });
  if (!res.ok && res.status !== 204) throw new Error('Ping failed: HTTP ' + res.status);
  return now() - t;
}

export async function measurePing(count, signal, onSample) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    if (signal.aborted) throw new Cancelled();
    samples.push(await pingOnce(signal));
    onSample && onSample(samples[samples.length - 1], samples);
    await sleep(40);
  }
  return summarisePing(samples);
}

/** Pings while the caller's load runs. Returns a stop function that yields the median. */
function backgroundPing(signal) {
  const samples = [];
  let stopped = false;
  const loop = (async () => {
    await sleep(600); // let the transfer ramp up
    while (!stopped && !signal.aborted) {
      try { samples.push(await pingOnce(signal)); } catch { /* ignore, transfer may be saturating */ }
      await sleep(150);
    }
  })();
  return async () => {
    stopped = true;
    await loop.catch(() => {});
    if (!samples.length) return NaN;
    const s = [...samples].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
}

function runTimed(ms, signal, tick) {
  return new Promise((resolve, reject) => {
    const t0 = now();
    const samples = [{ t: 0, bytes: 0 }];
    const id = setInterval(() => {
      if (signal.aborted) { clearInterval(id); return reject(new Cancelled()); }
      const t = now() - t0;
      const bytes = tick.bytes();
      samples.push({ t, bytes });
      try { tick.onSample && tick.onSample(samples, Math.min(1, t / ms)); }
      catch (e) { clearInterval(id); return reject(e); }
      if (t >= ms) { clearInterval(id); resolve(samples); }
    }, 100);
  });
}

export async function measureDownload({ ms, streams }, signal, onSample) {
  let total = 0;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  let failure = null;
  const worker = async () => {
    while (!ctrl.signal.aborted) {
      const res = await fetch('/api/download?bytes=' + 25 * 1024 * 1024 + '&r=' + rnd(), { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
      }
    }
  };
  const workers = Array.from({ length: streams }, () =>
    worker().catch((e) => { if (!ctrl.signal.aborted) failure = e; })
  );
  const bg = backgroundPing(signal);
  try {
    const samples = await runTimed(ms, signal, {
      bytes: () => total,
      onSample: (s, p) => { if (failure) throw failure; onSample && onSample(windowMbps(s), p, s); },
    });
    const loadedPing = await bg();
    return { mbps: steadyMbps(samples), loadedPing, samples };
  } finally {
    ctrl.abort();
    signal.removeEventListener('abort', onAbort);
    await Promise.all(workers);
  }
}

export async function measureUpload({ ms, streams }, signal, onSample) {
  const payload = new Blob([crypto.getRandomValues(new Uint8Array(65536))]);
  const body = new Blob(Array.from({ length: 64 }, () => payload)); // 4 MiB
  let done = 0;
  const inflight = new Map();
  let failure = null;
  const xhrs = new Set();
  let stop = false;
  const worker = (id) => new Promise((resolve) => {
    const next = () => {
      if (stop) return resolve();
      const x = new XMLHttpRequest();
      xhrs.add(x);
      x.open('POST', '/api/upload?r=' + rnd());
      x.upload.onprogress = (e) => inflight.set(id, e.loaded);
      x.onload = () => {
        xhrs.delete(x);
        if (x.status !== 200) { failure = new Error('Upload failed: HTTP ' + x.status); return resolve(); }
        done += body.size; inflight.set(id, 0); next();
      };
      x.onerror = () => { xhrs.delete(x); if (!stop) failure = new Error('Upload failed (network)'); resolve(); };
      x.onabort = () => resolve();
      x.send(body);
    };
    next();
  });
  const onAbort = () => { stop = true; xhrs.forEach((x) => x.abort()); };
  signal.addEventListener('abort', onAbort);
  const workers = Array.from({ length: streams }, (_, i) => worker(i));
  try {
    const bytes = () => done + [...inflight.values()].reduce((a, b) => a + b, 0);
    const samples = await runTimed(ms, signal, {
      bytes,
      onSample: (s, p) => { if (failure) throw failure; onSample && onSample(windowMbps(s), p, s); },
    });
    return { mbps: steadyMbps(samples), samples };
  } finally {
    stop = true;
    xhrs.forEach((x) => x.abort());
    signal.removeEventListener('abort', onAbort);
    await Promise.all(workers);
  }
}

/**
 * Runs the whole suite. `on` receives {phase, ...} events:
 * phase: 'ping' | 'download' | 'upload' ; live value + progress 0..1 ; 'done' with the result.
 */
export async function runSuite(preset, signal, on) {
  const cfg = typeof preset === 'string' ? PRESETS[preset] : preset;
  const result = {};

  on({ type: 'phase', phase: 'ping' });
  const ping = await measurePing(cfg.pingCount, signal, (v, all) =>
    on({ type: 'live', phase: 'ping', value: v, progress: all.length / cfg.pingCount })
  );
  result.ping = ping.median; result.pingMin = ping.min; result.jitter = ping.jitter;
  on({ type: 'result', phase: 'ping', ping });

  on({ type: 'phase', phase: 'download' });
  const d = await measureDownload({ ms: cfg.downMs, streams: cfg.streams }, signal, (v, p, s) =>
    on({ type: 'live', phase: 'download', value: v, progress: p, samples: s })
  );
  result.down = d.mbps; result.loadedPing = d.loadedPing;
  on({ type: 'result', phase: 'download', mbps: d.mbps, loadedPing: d.loadedPing, samples: d.samples });

  on({ type: 'phase', phase: 'upload' });
  const u = await measureUpload({ ms: cfg.upMs, streams: cfg.streams }, signal, (v, p, s) =>
    on({ type: 'live', phase: 'upload', value: v, progress: p, samples: s })
  );
  result.up = u.mbps;
  on({ type: 'result', phase: 'upload', mbps: u.mbps, samples: u.samples });

  result.at = Date.now();
  result.downSeries = d.samples;
  result.upSeries = u.samples;
  return result;
}
