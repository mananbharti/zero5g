import { runSuite, Cancelled } from './engine.js';
import { judge, TARGETS, CLAIMS } from './verdict.js';
import { fmtMbps, fmtMs } from './stats.js';
import { drawChart, toSeries } from './chart.js';
import { loadHistory, saveRun, clearHistory, getPref, setPref } from './history.js';
import { summaryText, renderCard, canvasToBlob } from './share.js';

const $ = (id) => document.getElementById(id);
const GAUGE_LEN = 628.32;
const SCORE_LEN = 326.73;

const el = {
  start: $('start'), stop: $('stop'), quick: $('quick'), hint: $('hint'), status: $('status'),
  gFill: $('gFill'), gPhase: $('gPhase'), gValue: $('gValue'), gUnit: $('gUnit'), pBar: $('pBar'),
  chart: $('chart'), chartLabel: $('chartLabel'),
  verdict: $('verdict'), sFill: $('sFill'), sNum: $('sNum'), vBadge: $('vBadge'), vHead: $('vHead'),
  vDetail: $('vDetail'), vReasons: $('vReasons'), vBars: $('vBars'), again: $('again'), share: $('share'),
  copy: $('copy'), shareNote: $('shareNote'),
};
const tiles = {
  down: [document.querySelector('[data-k=down]'), $('vDown')],
  up: [document.querySelector('[data-k=up]'), $('vUp')],
  ping: [document.querySelector('[data-k=ping]'), $('vPing')],
  jitter: [document.querySelector('[data-k=jitter]'), $('vJitter')],
  loaded: [document.querySelector('[data-k=loaded]'), $('vLoaded')],
};

let claim = getPref('claim', '5g');
if (!CLAIMS[claim]) claim = '5g';
let controller = null;
let last = null; // {result, judgement}
let chartSeries = [];
let chartColor = '#2cff9a';

/* ---------- claim chips ---------- */
const chips = [...document.querySelectorAll('.chip')];
function setClaim(c, focus) {
  claim = c; setPref('claim', c);
  chips.forEach((b) => {
    const on = b.dataset.claim === c;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
}
chips.forEach((b, i) => {
  b.addEventListener('click', () => setClaim(b.dataset.claim));
  b.addEventListener('keydown', (e) => {
    const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!k) return;
    e.preventDefault();
    setClaim(chips[(i + k + chips.length) % chips.length].dataset.claim, true);
  });
});
setClaim(claim);

/* ---------- gauge ---------- */
function setGauge(frac) {
  el.gFill.setAttribute('stroke-dashoffset', String(GAUGE_LEN * (1 - Math.min(1, Math.max(0, frac)))));
}
const mbpsFrac = (v) => Math.min(1, Math.log10(1 + v) / 3); // 0..1000 Mbps on a log scale
function showValue(phase, v) {
  if (phase === 'ping') {
    el.gValue.textContent = Number.isFinite(v) ? (v >= 100 ? Math.round(v) : v.toFixed(1)) : '0';
    el.gUnit.textContent = 'ms';
  } else {
    const g = v >= 1000;
    el.gValue.textContent = v >= 100 || g ? (g ? (v / 1000).toFixed(2) : Math.round(v)) : v.toFixed(1);
    el.gUnit.textContent = g ? 'Gbps' : 'Mbps';
  }
}
const PHASE_LABEL = { ping: 'Latency', download: 'Download', upload: 'Upload', done: 'Done', ready: 'Ready' };
function setPhase(p) { el.gPhase.textContent = PHASE_LABEL[p] || p; }

function resetTiles() {
  Object.values(tiles).forEach(([t, v]) => { t.className = 'tile'; v.textContent = '-'; });
}

/* ---------- running a test ---------- */
function setTesting(on) {
  document.body.classList.toggle('testing', on);
  el.start.disabled = on;
  el.stop.classList.toggle('hidden', !on);
  el.start.textContent = on ? 'Testing...' : 'Start test';
}

function setStatus(msg, err = false) { el.status.textContent = msg; el.status.classList.toggle('error', err); }

async function start() {
  if (controller) return;
  controller = new AbortController();
  last = null;
  el.verdict.classList.add('hidden');
  resetTiles();
  chartSeries = []; drawChart(el.chart, chartSeries);
  setTesting(true); setGauge(0); setPhase('ping'); showValue('ping', 0);
  el.pBar.style.width = '0%';
  setStatus('Measuring latency...');
  el.chartLabel.textContent = 'Measuring latency';

  const preset = el.quick.checked ? 'quick' : 'full';
  const order = ['ping', 'download', 'upload'];
  const live = {};
  try {
    const result = await runSuite(preset, controller.signal, (ev) => {
      if (ev.type === 'phase') {
        setPhase(ev.phase);
        const labels = { ping: 'Measuring latency...', download: 'Testing download...', upload: 'Testing upload...' };
        setStatus(labels[ev.phase]);
        el.chartLabel.textContent = ev.phase === 'ping' ? 'Measuring latency' : ev.phase === 'download' ? 'Download speed' : 'Upload speed';
        if (ev.phase !== 'ping') {
          chartSeries = []; chartColor = ev.phase === 'download' ? '#2cff9a' : '#29c6ff';
          drawChart(el.chart, chartSeries, { color: chartColor });
        }
        setGauge(0);
      } else if (ev.type === 'live') {
        live[ev.phase] = ev.value;
        showValue(ev.phase, ev.value);
        setGauge(ev.phase === 'ping' ? Math.min(1, ev.value / 200) : mbpsFrac(ev.value));
        const base = order.indexOf(ev.phase) / 3;
        el.pBar.style.width = ((base + ev.progress / 3) * 100).toFixed(1) + '%';
        if (ev.samples) {
          chartSeries = toSeries(ev.samples);
          drawChart(el.chart, chartSeries, { color: chartColor });
        }
      } else if (ev.type === 'result') {
        if (ev.phase === 'ping') {
          tiles.ping[1].textContent = fmtMs(ev.ping.median);
          tiles.jitter[1].textContent = fmtMs(ev.ping.jitter);
        } else if (ev.phase === 'download') {
          tiles.down[1].textContent = fmtMbps(ev.mbps);
          tiles.loaded[1].textContent = fmtMs(ev.loadedPing);
        } else if (ev.phase === 'upload') {
          tiles.up[1].textContent = fmtMbps(ev.mbps);
        }
      }
    });
    el.pBar.style.width = '100%';
    finish(result);
  } catch (e) {
    if (e instanceof Cancelled || e.name === 'AbortError') {
      setStatus('Test stopped.'); setPhase('ready'); showValue('download', 0); setGauge(0);
    } else {
      setStatus((e && e.message ? e.message : 'Test failed') + '. Check your connection and try again.', true);
      setPhase('ready');
    }
  } finally {
    controller = null; setTesting(false);
  }
}

function finish(result) {
  const j = judge(result, claim);
  last = { result, judgement: j };
  setPhase('done'); showValue('download', result.down); setGauge(mbpsFrac(result.down));
  setStatus('Done. Scroll down for the verdict.');
  el.chartLabel.textContent = 'Upload speed (last phase)';
  for (const [k, rating] of Object.entries(j.ratings)) tiles[k][0].className = 'tile ' + (rating === 'na' ? '' : rating);
  renderVerdict(result, j);
  saveRun({ at: result.at, down: result.down, up: result.up, ping: result.ping, jitter: result.jitter, loadedPing: result.loadedPing, verdict: j.verdict, score: j.score, claim, tier: j.tier.label });
  renderHistory();
  requestAnimationFrame(() => el.verdict.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

/* ---------- verdict ---------- */
const BADGE = { real: 'REAL 5G', partial: 'PARTIAL', fake: 'FAKE 5G', info: 'SPEED REPORT' };
function renderVerdict(r, j) {
  el.verdict.className = 'card verdict ' + j.verdict;
  el.vBadge.textContent = BADGE[j.verdict];
  el.vHead.textContent = j.headline;
  el.vDetail.textContent = j.detail;
  el.sNum.textContent = String(j.score);
  el.sFill.setAttribute('stroke-dashoffset', String(SCORE_LEN));
  requestAnimationFrame(() => el.sFill.setAttribute('stroke-dashoffset', String(SCORE_LEN * (1 - j.score / 100))));
  el.vReasons.replaceChildren(...j.reasons.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  const rows = [
    ['Download', r.down / TARGETS.down, fmtMbps(r.down), j.ratings.down],
    ['Upload', r.up / TARGETS.up, fmtMbps(r.up), j.ratings.up],
    ['Ping', Number.isFinite(r.ping) ? TARGETS.ping / r.ping : 0, fmtMs(r.ping), j.ratings.ping],
    ['Jitter', Number.isFinite(r.jitter) ? TARGETS.jitter / Math.max(r.jitter, 0.1) : 0, fmtMs(r.jitter), j.ratings.jitter],
  ];
  el.vBars.replaceChildren(...rows.map(([label, ratio, val, rating]) => {
    const row = document.createElement('div'); row.className = 'bar-row ' + rating;
    const l = document.createElement('span'); l.textContent = label;
    const tr = document.createElement('div'); tr.className = 'bar-track';
    const f = document.createElement('div'); f.className = 'bar-fill'; f.style.width = '0%';
    tr.append(f);
    const v = document.createElement('span'); v.className = 'bar-val'; v.textContent = val;
    row.append(l, tr, v);
    requestAnimationFrame(() => { f.style.width = Math.min(100, Math.max(2, ratio * 100)) + '%'; });
    return row;
  }));
  el.shareNote.textContent = '';
}

/* ---------- share / copy ---------- */
el.copy.addEventListener('click', async () => {
  if (!last) return;
  const text = summaryText(last.result, last.judgement);
  try { await navigator.clipboard.writeText(text); el.shareNote.textContent = 'Summary copied.'; }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.setAttribute('readonly', ''); ta.className = 'offscreen';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) { el.shareNote.textContent = 'Summary copied.'; return; } el.shareNote.textContent = 'Could not copy automatically. Select and copy this: ' + text.replace(/\n/g, ' | '); }
});
el.share.addEventListener('click', async () => {
  if (!last) return;
  const blob = await canvasToBlob(renderCard(last.result, last.judgement));
  const file = new File([blob], 'zero5g-result.png', { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: summaryText(last.result, last.judgement) });
      el.shareNote.textContent = 'Shared.'; return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'zero5g-result.png' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  el.shareNote.textContent = 'Result image saved.';
});

/* ---------- history ---------- */
function renderHistory() {
  const list = loadHistory();
  $('historyEmpty').classList.toggle('hidden', list.length > 0);
  $('clearHistory').classList.toggle('hidden', list.length === 0);
  $('historyList').replaceChildren(...list.map((h) => {
    const li = document.createElement('li');
    const b = document.createElement('span'); b.className = 'h-badge ' + h.verdict; b.textContent = h.verdict === 'info' ? 'INFO' : h.verdict.toUpperCase();
    const n = document.createElement('span'); n.className = 'h-nums';
    n.textContent = `${fmtMbps(h.down)} down, ${fmtMbps(h.up)} up, ${fmtMs(h.ping)} ping`;
    const t = document.createElement('span'); t.className = 'h-time';
    t.textContent = `${CLAIMS[h.claim] ? CLAIMS[h.claim].label : ''} - ${new Date(h.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    li.append(b, n, t);
    return li;
  }));
}
$('clearHistory').addEventListener('click', () => { clearHistory(); renderHistory(); });

/* ---------- browser connection info ---------- */
function renderConn() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const list = $('connList');
  const rows = [['Online', navigator.onLine ? 'Yes' : 'No']];
  if (c) {
    if (c.type) rows.push(['Connection type', c.type]);
    if (c.effectiveType) rows.push(['Effective type', c.effectiveType.toUpperCase()]);
    if (Number.isFinite(c.downlink)) rows.push(['Browser downlink est.', c.downlink + ' Mbps']);
    if (Number.isFinite(c.rtt)) rows.push(['Browser RTT est.', c.rtt + ' ms']);
    if (c.saveData) rows.push(['Data saver', 'On']);
  }
  list.replaceChildren(...rows.map(([k, v]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    d.append(dt, dd); return d;
  }));
  $('connNote').textContent = c
    ? 'The browser can only guess "4G" at most (it never reports 5G) and its numbers are rough estimates. That is why Zero5G measures for real.'
    : 'This browser does not expose connection details. The speed test works the same either way.';
}

/* ---------- wiring ---------- */
el.start.addEventListener('click', start);
el.stop.addEventListener('click', () => controller && controller.abort());
el.again.addEventListener('click', () => { document.getElementById('test').scrollIntoView({ behavior: 'smooth' }); start(); });
window.addEventListener('resize', () => drawChart(el.chart, chartSeries, { color: chartColor }));
window.addEventListener('online', renderConn); window.addEventListener('offline', renderConn);
if (new URLSearchParams(location.search).get('quick') === '1') el.quick.checked = true;
renderConn(); renderHistory(); drawChart(el.chart, []);
