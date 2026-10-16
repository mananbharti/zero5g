// Result summary text and a shareable PNG card.
import { fmtMbps, fmtMs } from './stats.js';

export function summaryText(r, j) {
  return [
    `Zero5G: ${j.headline}`,
    `Phone shows: ${j.claimLabel}. Verdict: ${j.verdict.toUpperCase()} (score ${j.score}/100, ${j.tier.label})`,
    `Download ${fmtMbps(r.down)} | Upload ${fmtMbps(r.up)} | Ping ${fmtMs(r.ping)} | Jitter ${fmtMs(r.jitter)}`,
  ].join('\n');
}

const COLORS = { real: '#1d6b3d', partial: '#a86a0c', fake: '#e5381b', info: '#16140f' };

export function renderCard(r, j) {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1080;
  const x = c.getContext('2d');
  const bg = COLORS[j.verdict] || COLORS.info;
  const paper = '#ece6d8';
  x.fillStyle = bg; x.fillRect(0, 0, 1080, 1080);
  x.fillStyle = paper;

  const serif = (px, st = '') => `${st} ${px}px "Instrument Serif", Georgia, serif`;
  const mono = (px, w = 500) => `${w} ${px}px "Plex Mono", ui-monospace, Menlo, monospace`;
  x.textBaseline = 'alphabetic'; x.textAlign = 'left';
  x.font = serif(64); x.fillText('Zero', 70, 120);
  const zw = x.measureText('Zero').width;
  x.font = serif(64, 'italic'); x.fillText('5G', 70 + zw, 120);
  x.font = mono(24); x.textAlign = 'right';
  x.fillText(j.verdict === 'info' ? 'SPEED REPORT' : j.verdict.toUpperCase() + ' 5G', 1010, 112);
  x.fillRect(70, 150, 940, 2);

  x.textAlign = 'left';
  x.font = serif(100);
  wrap(x, j.headline, 70, 290, 940, 104);
  x.font = serif(300); x.fillText(String(j.score), 70, 700);
  const sw = x.measureText(String(j.score)).width;
  x.font = mono(34); x.fillText('/100', 90 + sw, 700);

  const stats = [['Download', fmtMbps(r.down)], ['Upload', fmtMbps(r.up)], ['Ping', fmtMs(r.ping)], ['Jitter', fmtMs(r.jitter)]];
  x.fillRect(70, 770, 940, 2);
  stats.forEach(([k, v], i) => {
    const sx = 70 + i * 235;
    x.font = mono(20); x.fillText(k.toUpperCase(), sx, 818);
    x.font = serif(58); x.fillText(v, sx, 892);
  });
  x.fillRect(70, 940, 940, 2);
  x.font = mono(22); x.fillText(`Phone said ${j.claimLabel}.  zero5g`, 70, 990);
  return c;
}

function wrap(ctx, text, x, y, maxW, lh) {
  const words = text.split(' ');
  let line = '';
  const lines = [];
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  lines.push(line);
  lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, x, y + i * lh));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const canvasToBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));
