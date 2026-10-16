// Result summary text and a shareable PNG card.
import { fmtMbps, fmtMs } from './stats.js';

export function summaryText(r, j) {
  return [
    `Zero5G: ${j.headline}`,
    `Phone shows: ${j.claimLabel}. Verdict: ${j.verdict.toUpperCase()} (score ${j.score}/100, ${j.tier.label})`,
    `Download ${fmtMbps(r.down)} | Upload ${fmtMbps(r.up)} | Ping ${fmtMs(r.ping)} | Jitter ${fmtMs(r.jitter)}`,
  ].join('\n');
}

const COLORS = { real: '#2cff9a', partial: '#ffc247', fake: '#ff4d6d', info: '#29c6ff' };

export function renderCard(r, j) {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1080;
  const x = c.getContext('2d');
  const accent = COLORS[j.verdict] || COLORS.info;
  x.fillStyle = '#070b12'; x.fillRect(0, 0, 1080, 1080);
  const g = x.createRadialGradient(900, 0, 50, 900, 0, 800);
  g.addColorStop(0, accent + '33'); g.addColorStop(1, '#00000000');
  x.fillStyle = g; x.fillRect(0, 0, 1080, 1080);

  const font = (px, w = 600) => `${w} ${px}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  x.textBaseline = 'alphabetic';
  x.fillStyle = '#e8f0fb'; x.font = font(44, 700); x.fillText('Zero', 80, 110);
  const zw = x.measureText('Zero').width;
  x.fillStyle = accent; x.fillText('5G', 80 + zw, 110);

  // score ring
  const cx = 540, cy = 400, R = 190;
  x.lineWidth = 26; x.lineCap = 'round';
  x.strokeStyle = '#16233a'; x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = accent; x.beginPath();
  x.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * j.score) / 100); x.stroke();
  x.textAlign = 'center';
  x.fillStyle = '#e8f0fb'; x.font = font(150, 700); x.fillText(String(j.score), cx, cy + 40);
  x.fillStyle = '#8aa0bd'; x.font = font(30, 500); x.fillText('/100', cx, cy + 100);

  x.fillStyle = accent; x.font = font(34, 700); x.fillText(j.verdict === 'info' ? 'SPEED REPORT' : j.verdict.toUpperCase() + ' 5G', cx, 690);
  x.fillStyle = '#e8f0fb'; x.font = font(40, 700);
  wrap(x, j.headline, cx, 750, 880, 50);

  const stats = [['Download', fmtMbps(r.down)], ['Upload', fmtMbps(r.up)], ['Ping', fmtMs(r.ping)], ['Jitter', fmtMs(r.jitter)]];
  stats.forEach(([k, v], i) => {
    const sx = 80 + i * 240;
    x.fillStyle = '#0f1828'; roundRect(x, sx, 880, 220, 130, 18); x.fill();
    x.textAlign = 'left'; x.fillStyle = '#8aa0bd'; x.font = font(22, 500); x.fillText(k.toUpperCase(), sx + 20, 925);
    x.fillStyle = '#e8f0fb'; x.font = font(34, 700); x.fillText(v, sx + 20, 980);
  });
  x.textAlign = 'center'; x.fillStyle = '#5f7694'; x.font = font(22, 500);
  x.fillText(`Phone showed ${j.claimLabel}  -  zero5g`, cx, 1050);
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
