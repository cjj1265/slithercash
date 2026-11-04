'use strict';
/**
 * Posts a verified win to a Discord channel (a webhook), as the card picture plus a one-line message.
 *
 * WINS_WEBHOOK_URL is the webhook address of the #wins channel. Anyone holding it can post to that channel, so it
 * is only ever read from the environment and is never sent to the page or written to a log. Keep it separate from
 * ALERT_WEBHOOK_URL (the private alerts channel). Only Discord webhook addresses are accepted (plus localhost,
 * which the tests use).
 */
const { renderWinCard } = require('./winCard');

function webhookOk(value) {
  try {
    const u = new URL(value);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return u.protocol === 'https:' && /^(discord|discordapp)\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/');
  } catch (e) { return false; }
}

const RAW = process.env.WINS_WEBHOOK_URL || '';
const URL_OK = RAW && webhookOk(RAW) ? RAW : '';
if (RAW && !URL_OK) console.error('[wins] WINS_WEBHOOK_URL is not a Discord webhook address: posting wins is turned off');

const enabled = () => !!URL_OK;

/** Keeps a player's name from turning into Discord formatting. (Mentions are switched off separately.) */
const plain = (s) => String(s || '').replace(/([\\*_~`|>])/g, '\\$1').slice(0, 40);

/**
 * data: { profit, pct, invested, position, name, sym } in the units to show (see winCard.js).
 * Rejects if Discord does not accept the post.
 */
async function postWin(data) {
  if (!URL_OK) throw new Error('wins webhook is not configured');
  const png = renderWinCard(data);
  const sign = data.profit >= 0 ? '+' : '-';
  const sym = data.sym === 'sol' ? '◎' : '$';
  const amount = Math.abs(data.profit) >= 1 ? Math.abs(data.profit).toFixed(2) : Math.abs(data.profit).toFixed(3);
  const content = '**@' + plain(data.name || 'Player') + '** cashed out **' + sign + sym + amount + '** (' + (data.pct >= 0 ? '+' : '-') + Math.abs(data.pct).toFixed(2) + '%) · ' + (data.profit > 0 ? 'verified win' : 'verified cash-out');
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content, username: 'SnakePay Wins', allowed_mentions: { parse: [] } }));
  form.append('files[0]', new Blob([png], { type: 'image/png' }), 'snakepay-win.png');
  const res = await fetch(URL_OK, { method: 'POST', body: form, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error('Discord answered ' + res.status);
  return true;
}

module.exports = { enabled, postWin };
