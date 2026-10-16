// Tiny canvas line chart for live throughput. No dependencies.
export function drawChart(canvas, series, { maxHint = 10, color = '#2cff9a' } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 180;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 44, r: 10, t: 22, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const peak = Math.max(maxHint, ...series.map((p) => p.v));
  const top = niceCeil(peak * 1.1);

  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = '#6d85a5';
  ctx.strokeStyle = '#1c2a40';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ih - (ih * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(String(Math.round((top * i) / 4)), pad.l - 6, y);
  }
  if (series.length < 2) return;
  const tMax = Math.max(series[series.length - 1].t, 1);
  const x = (t) => pad.l + (t / tMax) * iw;
  const y = (v) => pad.t + ih - (v / top) * ih;

  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
  grad.addColorStop(0, color + '55'); grad.addColorStop(1, color + '00');
  ctx.beginPath();
  ctx.moveTo(x(series[0].t), y(series[0].v));
  for (const p of series) ctx.lineTo(x(p.t), y(p.v));
  ctx.lineTo(x(series[series.length - 1].t), pad.t + ih);
  ctx.lineTo(x(series[0].t), pad.t + ih);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x(series[0].t), y(series[0].v));
  for (const p of series) ctx.lineTo(x(p.t), y(p.v));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

  ctx.fillStyle = '#6d85a5'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText((tMax / 1000).toFixed(0) + ' s', w - pad.r, h - pad.b + 6);
  ctx.textAlign = 'left'; ctx.fillText('Mbps', pad.l, 2);
}

function niceCeil(v) {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  return steps.find((s) => s >= v) || Math.ceil(v / 1000) * 1000;
}

/** Convert cumulative byte samples to a per-window Mbps series for plotting. */
export function toSeries(samples, windowMs = 500) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    let j = i;
    while (j > 0 && samples[i].t - samples[j].t < windowMs) j--;
    const dt = (samples[i].t - samples[j].t) / 1000;
    if (dt > 0) out.push({ t: samples[i].t, v: ((samples[i].bytes - samples[j].bytes) * 8) / dt / 1e6 });
  }
  return out;
}
