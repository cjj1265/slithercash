'use strict';
/**
 * Draws the "CASHED OUT" card as a PNG, on the server, from numbers the server itself recorded.
 *
 * This is the same drawing as the card on the page (slithercash.html: FACE_LAYERS), laid flat. If the look of
 * one changes, change the other. Fonts come from the @fontsource packages so the picture does not depend on
 * anything installed on the machine.
 *
 *   renderWinCard({ profit, pct, invested, position, name, sym })  ->  Buffer (PNG, 1100x640)
 *
 * profit, invested and position are in the units to show (SOL on mainnet, play money otherwise); sym is 'sol' or '$'.
 */
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const FONTS = [
  ['@fontsource/exo-2', 'exo-2-latin-800-italic.woff2', 'Exo 2'],
  ['@fontsource/exo-2', 'exo-2-latin-900-italic.woff2', 'Exo 2'],
  ['@fontsource/space-grotesk', 'space-grotesk-latin-500-normal.woff2', 'Space Grotesk'],
  ['@fontsource/space-grotesk', 'space-grotesk-latin-700-normal.woff2', 'Space Grotesk'],
];
let fontsReady = false;
function loadFonts() {
  if (fontsReady) return;
  for (const [pkg, file, family] of FONTS) GlobalFonts.registerFromPath(require.resolve(pkg + '/files/' + file), family);
  fontsReady = true;
}

const GOLD = '#ffc928', RED = '#e6465c';
const EXO = '"Exo 2", "Space Grotesk", sans-serif', SG = '"Space Grotesk", sans-serif';
const FACE_W = 1100, FACE_H = 640;

/** An amount as sign, symbol and number, so the symbol can be drawn with room around it. */
function parts(v, signed, sym) {
  const a = Math.abs(v);
  let t;
  if (a >= 1e6) t = (a / 1e6).toFixed(2) + 'M';
  else if (a >= 1e3) t = (a / 1e3).toFixed(2) + 'K';
  else if (a >= 100) t = a.toFixed(1);
  else if (a >= 1) t = a.toFixed(2);
  else t = a.toFixed(3);
  return { sign: signed ? (v < 0 ? '-' : '+') : '', sym, num: t };
}

function measureAmount(c, p, size) {
  const gap = size * 0.16;
  const wSign = p.sign ? c.measureText(p.sign).width + gap : 0;
  const wSym = p.sym === 'sol' ? size * 0.6 : (p.sym === '$' ? c.measureText('$').width : 0);
  return wSign + wSym + (p.sym ? gap : 0) + c.measureText(p.num).width;
}
function drawAmount(c, p, x, baseY, font, size, color, align) {
  c.save();
  c.font = font; c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillStyle = color;
  const gap = size * 0.16, d = size * 0.6;
  const wSign = p.sign ? c.measureText(p.sign).width + gap : 0;
  const wSym = p.sym === 'sol' ? d : (p.sym === '$' ? c.measureText('$').width : 0);
  let cx = align === 'center' ? x - measureAmount(c, p, size) / 2 : x;
  if (p.sign) { c.fillText(p.sign, cx, baseY); cx += wSign; }
  if (p.sym === 'sol') {
    const r = d / 2, cy = baseY - size * 0.35, lw = Math.max(2, size * 0.08);
    c.strokeStyle = color; c.lineWidth = lw;
    c.beginPath(); c.arc(cx + r, cy, r - lw / 2, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(cx + r, cy, r * 0.36, 0, Math.PI * 2); c.fill();
  } else if (p.sym === '$') c.fillText('$', cx, baseY);
  cx += wSym + (p.sym ? gap : 0);
  c.fillText(p.num, cx, baseY);
  c.restore();
}

const LAYERS = {
  header(c, d) {
    const accent = GOLD, MID = FACE_W / 2;
    c.save();
    c.font = 'italic 800 92px ' + EXO; c.textBaseline = 'alphabetic';
    const wA = c.measureText('snakepay').width, wB = c.measureText('.lol').width, wx = MID - (wA + wB) / 2;
    c.shadowColor = 'rgba(255,255,255,0.22)'; c.shadowBlur = 16;
    c.fillStyle = '#f4f4f4'; c.fillText('snakepay', wx, 112);
    c.shadowColor = 'rgba(255,200,40,0.5)';
    c.fillStyle = GOLD; c.fillText('.lol', wx + wA, 112);
    c.restore();
    const left = wx - 36, right = wx + wA + wB + 36;
    c.save();
    [[80, 0.9], [104, 0.4]].forEach(([y, alpha]) => {
      const gl = c.createLinearGradient(44, 0, left, 0); gl.addColorStop(0, 'rgba(0,0,0,0)'); gl.addColorStop(1, accent);
      const gr = c.createLinearGradient(right, 0, FACE_W - 44, 0); gr.addColorStop(0, accent); gr.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = alpha;
      c.fillStyle = gl; c.fillRect(44, y, left - 44, 3);
      c.fillStyle = gr; c.fillRect(right, y, FACE_W - 44 - right, 3);
    });
    c.restore();
  },

  title(c) {
    const MID = FACE_W / 2;
    const tA = 'CASHED ', tB = 'OUT';
    c.save();
    c.font = 'italic 900 118px ' + EXO;
    const twA = c.measureText(tA).width, twB = c.measureText(tB).width, tx = MID - (twA + twB) / 2;
    c.textBaseline = 'alphabetic';
    c.shadowColor = 'rgba(255,255,255,0.18)'; c.shadowBlur = 14;
    c.fillStyle = '#ffffff'; c.fillText(tA, tx, 262);
    c.shadowColor = 'rgba(255,200,40,0.45)';
    c.fillStyle = GOLD; c.fillText(tB, tx + twA, 262);
    c.restore();
  },

  bar(c, d) {
    const ink = '#0b0b0b', MID = FACE_W / 2;
    c.save();
    const barW = 890, barH = 112, barX = MID - barW / 2, barY = 296;
    const fill = c.createLinearGradient(0, barY, 0, barY + barH);
    fill.addColorStop(0, '#ffd84a'); fill.addColorStop(1, '#f2a900');
    c.shadowColor = 'rgba(255,200,40,0.55)'; c.shadowBlur = 36;
    c.fillStyle = fill; c.beginPath(); c.roundRect(barX, barY, barW, barH, barH / 2); c.fill();
    c.shadowBlur = 0;
    const head = parts(d.profit, true, d.sym), headNum = { sign: head.sign, sym: null, num: head.num };
    const coinD = 76, coinGap = 34;
    let hs = 92;
    for (; hs > 24; hs -= 4) { c.font = 'italic 900 ' + hs + 'px ' + EXO; if (coinD + coinGap + measureAmount(c, headNum, hs) <= barW - 120) break; }
    c.font = 'italic 900 ' + hs + 'px ' + EXO;
    const groupW = coinD + coinGap + measureAmount(c, headNum, hs), gx = MID - groupW / 2, midY = barY + barH / 2;
    c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = 7;
    c.beginPath(); c.arc(gx + coinD / 2, midY, coinD / 2 - 3.5, 0, Math.PI * 2); c.stroke();
    if (head.sym === 'sol') {
      c.lineWidth = 6; c.beginPath(); c.arc(gx + coinD / 2, midY, 15, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(gx + coinD / 2, midY, 5.5, 0, Math.PI * 2); c.fill();
    } else {
      c.font = '700 46px ' + SG; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('$', gx + coinD / 2, midY + 2);
    }
    drawAmount(c, headNum, gx + coinD + coinGap, midY + hs * 0.35, 'italic 900 ' + hs + 'px ' + EXO, hs, ink, 'left');
    c.restore();
  },

  stats(c, d) {
    c.save();
    const bx = 50, by = 432, bw = FACE_W - 100, bh = 124;
    c.fillStyle = '#0e0e0e'; c.beginPath(); c.roundRect(bx, by, bw, bh, 30); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.09)'; c.lineWidth = 2; c.beginPath(); c.roundRect(bx, by, bw, bh, 30); c.stroke();
    const colW = bw / 3, centers = [bx + colW / 2, bx + colW * 1.5, bx + colW * 2.5];
    c.fillStyle = '#2c2c2c'; c.fillRect(bx + colW - 1, by + 26, 2, bh - 52); c.fillRect(bx + colW * 2 - 1, by + 26, 2, bh - 52);
    const pct = (d.pct >= 0 ? '+' : '-') + Math.abs(d.pct).toFixed(2) + '%';
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    ['PNL', 'Invested', 'Position'].forEach((l, i) => { c.font = '500 34px ' + SG; c.fillStyle = '#9a9a9a'; c.fillText(l, centers[i], by + 50); });
    c.font = '700 52px ' + SG; c.fillStyle = '#4be04b'; c.fillText(pct, centers[0], by + 105);
    drawAmount(c, parts(d.invested, false, d.sym), centers[1], by + 105, '700 52px ' + SG, 52, '#ffffff', 'center');
    drawAmount(c, parts(d.position, false, d.sym), centers[2], by + 105, '700 52px ' + SG, 52, '#ffffff', 'center');
    c.restore();
  },

  name(c, d) {
    if (!d.name) return;
    c.save();
    c.font = 'italic 800 32px ' + EXO; c.fillStyle = '#c4c4c4'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 6;
    c.fillText('@' + d.name, FACE_W / 2, 606);
    c.restore();
  },
};

/** The card's dark rounded panel, like the one the page draws around the layers (corners stay transparent). */
function drawPanel(c) {
  const R = 65, ang = 160 * Math.PI / 180;
  const half = (Math.abs(FACE_W * Math.sin(ang)) + Math.abs(FACE_H * Math.cos(ang))) / 2;
  const dx = Math.sin(ang) * half, dy = -Math.cos(ang) * half, cx = FACE_W / 2, cy = FACE_H / 2;
  const g = c.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  g.addColorStop(0, '#181818'); g.addColorStop(1, '#0a0a0a');
  c.fillStyle = g; c.beginPath(); c.roundRect(0, 0, FACE_W, FACE_H, R); c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 2; c.beginPath(); c.roundRect(1, 1, FACE_W - 2, FACE_H - 2, R - 1); c.stroke();
}

function renderWinCard(data) {
  loadFonts();
  const cv = createCanvas(FACE_W, FACE_H);
  const c = cv.getContext('2d');
  drawPanel(c);
  for (const name of ['header', 'stats', 'name', 'title', 'bar']) LAYERS[name](c, data);
  return cv.toBuffer('image/png');
}

module.exports = { renderWinCard, FACE_W, FACE_H };
