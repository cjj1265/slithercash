// index.js — SnakePay multiplayer server entry point.
//
// Run: node index.js
// Env: PORT (default 8787)
//      GAME_WALLET_SECRET, DEPOSIT_MASTER_SEED, SOLANA_RPC_URL, WALLET_DATA_FILE
//        — see solanaWallet.js. Without GAME_WALLET_SECRET the server runs in
//        practice mode only and the /api wallet routes answer 503.
//      CORS_ORIGIN (optional, comma-separated allowlist for the /api routes)
//      ADMIN_TOKEN (20+ chars; enables /admin), ALERT_WEBHOOK_URL (Discord/Slack alerts),
//      OWNER_ADDRESS (the one address house earnings can be withdrawn to, from /admin),
//      WALLET_PAUSED=1 (start paused), MAX_WITHDRAW_SOL, MAX_PLAYER_DAILY_WITHDRAW_SOL,
//      MAX_DAILY_WITHDRAW_SOL, MAX_BUYIN_CREDITS, LOW_WALLET_SOL — see solanaWallet.js
//      TRUST_PROXY=1 (optional, rate-limit by X-Forwarded-For behind Render/Railway)
//      TRUST_CLOUDFLARE=1 (use Cloudflare's CF-Connecting-IP as the visitor address) and
//      ORIGIN_SECRET (a long random string Cloudflare adds to every request as the X-Origin-Secret
//        header; when set, requests without it are refused, so only Cloudflare can reach this server.
//        /health stays open for the host's health checks)
//
// Protocol (JSON text frames over WebSocket):
//
//   Client -> Server
//     { t:"join",   name, buyin, skinIndex, walletId? }   // must be sent first.
//                    // With a walletId (the playerId from /api/login) the buy-in
//                    // is deducted from that server-side balance and a cash-out
//                    // is credited back to it. Without one it's free practice play.
//     { t:"input",  angle, boosting }          // steering, send ~20x/sec
//     { t:"cashout" }                          // hold to cash out: re-send every second while held;
//                                              // pays out after CASHOUT_HOLD_SECONDS (default 5) on the server
//     { t:"cashout_cancel" }                   // released early
//     { t:"ping",   ts }
//
//   Server -> Client
//     { t:"welcome",        id, cfg:{WORLD_RADIUS, LEN_PER_DOLLAR, TICK_RATE} }
//     { t:"snapshot",       youId, snakes:[...], orbs:[...], elapsed }
//     { t:"death",          killerName, buyin, bestRank, coinsEaten }
//     { t:"cashout_result", amount, buyin, bestRank, coinsEaten }
//     { t:"kill",           victim }                   // you killed someone (for the kill sound)
//     { t:"pong",           ts }
//     { t:"error",          message }

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { attachWebSocketServer } = require('./wsProtocol');
const { GameWorld, CFG, SKIN_COUNT } = require('./gameServer');
const wallet = require('./solanaWallet');

const PORT = process.env.PORT || 8787;
const TICK_MS = 1000 / CFG.TICK_RATE;
const MAX_NAME_LEN = 16;

// Flat layout — every file lives together in one folder, no subfolders:
//   slithercash/
//     slithercash.html
//     index.js   <- this file
//     gameServer.js
//     wsProtocol.js
//     package.json
const CLIENT_HTML_PATH = path.join(__dirname, 'slithercash.html');

// Two separate worlds, and players in one never meet players in the other. Practice play is free and
// its snakes (and any bots) hold value nobody paid for; if they shared a map with real-money players,
// a free snake could die next to a paying one and hand it orbs to cash out. Every unit of value in
// realWorld was put there by a buy-in taken from a real balance, which is what the solvency check relies on.
// DEMO_MODE is for showing the game off on your own computer (`npm run demo`): a play-money world with lots of big
// bots, free food, and controls to change them. It never runs with a wallet, never on a host, and only answers
// to this computer.
const DEMO_MODE = process.env.DEMO_MODE === '1';
if (DEMO_MODE && (process.env.GAME_WALLET_SECRET || process.env.RENDER || process.env.ALLOW_MAINNET)) {
  console.error('[demo] DEMO_MODE is only for running on your own computer, with no wallet. Refusing to start.');
  process.exit(1);
}
const DEMO_DEFAULTS = { bots: 40, botScale: 3, radius: 1800, ambientOrbs: 450 };
const realWorld = new GameWorld({ bots: 0 });
const practiceWorld = DEMO_MODE ? new GameWorld(DEMO_DEFAULTS) : new GameWorld();
const worlds = [realWorld, practiceWorld];

/** connId -> { conn: WSConnection, playerId: string|null, world: GameWorld|null } */
const sessions = new Map();
let connCounter = 1;

/**
 * snake id -> wallet playerId, for players who bought in from a server balance.
 * Kept apart from `sessions` on purpose: a cash-out must still be credited even
 * if the socket closes in the same tick the cash-out is processed.
 */
const walletByPlayer = new Map();

// Wins that can still be posted to Discord. A win is recorded here by the server at cash-out, from its own numbers;
// the player gets only a random id for it, and can post that one win once, within WIN_TTL_MS.
const wins = require('./wins');
const winTokens = new Map(); // id -> { walletId, name, buyin, net, ts, posted }
const WIN_TTL_MS = 15 * 60 * 1000;
function rememberWin(walletId, name, buyin, net) {
  const now = Date.now();
  for (const [id, w] of winTokens) if (now - w.ts > WIN_TTL_MS) winTokens.delete(id);
  const id = crypto.randomBytes(12).toString('hex');
  winTokens.set(id, { walletId, name, buyin, net, ts: now, posted: false });
  return id;
}

/* ============================== wallet API ============================== */

const CORS_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === '1';
const ORIGIN_SECRET = process.env.ORIGIN_SECRET || '';
const WITHDRAW_RATE_MAX = Number(process.env.WITHDRAW_RATE_MAX) || 6; // withdraw requests per player per minute

/** The page is served from this same server, so CORS is off unless CORS_ORIGIN names other origins. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const any = CORS_ORIGINS.includes('*');
  if (any || CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', any ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Player-Id');
  }
}

const rateBuckets = new Map(); // `${bucket}:${key}` -> { count, resetAt }
function rateLimited(bucket, key, max, windowMs) {
  const now = Date.now();
  const id = bucket + ':' + key;
  let b = rateBuckets.get(id);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + windowMs }; rateBuckets.set(id, b); }
  b.count++;
  return b.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, b] of rateBuckets) if (b.resetAt < now) rateBuckets.delete(id);
}, 60000).unref();

/**
 * Behind Cloudflare every visitor reaches us from a Cloudflare address, so the real visitor is in the
 * CF-Connecting-IP header. It is only believed when TRUST_CLOUDFLARE=1 — and it can only be trusted at all
 * if nobody can reach this server except through Cloudflare, which is what ORIGIN_SECRET enforces.
 */
function clientIp(req) {
  if (TRUST_CLOUDFLARE) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cf)) return cf;
  }
  if (TRUST_PROXY) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',');
    const last = parts[parts.length - 1].trim();
    if (last) return last; // the entry added by our own proxy, not one the client can forge
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new wallet.WalletError('too_large', 'Request too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new wallet.WalletError('bad_json', 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function balanceBody(b) { return { sol: b.sol, credits: b.credits }; }

/**
 * Routes:
 *   GET  /api/login-challenge?publicKey=   -> { message, nonce }          (sign `message` with the wallet)
 *   POST /api/login { publicKey, message, signature(base64) } -> { playerId, address, sol, credits, rate }
 *   GET  /api/player-deposit-address?playerId= -> { address, balance, solBalance, rate, minDepositSol }
 *   GET  /api/player-balance?playerId=         -> { sol, credits }
 *   POST /api/check-deposit (X-Player-Id)      -> { sol, credits }  — looks for a pending deposit right now
 *   POST /api/withdraw { playerAddress, solAmount, playerId, idempotencyKey }
 * playerId may also be sent as an X-Player-Id header, which keeps it out of URLs and access logs.
 */
async function handleApi(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    const url = new URL(req.url, 'http://localhost');
    const route = req.method + ' ' + url.pathname;
    const known = ['GET /api/config', 'GET /api/online', 'GET /api/login-challenge', 'POST /api/login', 'GET /api/player-deposit-address', 'GET /api/player-balance', 'POST /api/check-deposit', 'POST /api/withdraw', 'GET /api/skins', 'POST /api/buy-skin', 'POST /api/post-win', 'GET /api/demo', 'POST /api/demo'];
    if (!known.includes(route)) { sendJson(res, 404, { error: 'Not found.' }); return; }

    // Public and harmless: lets the page say "Devnet" or not before anyone connects a wallet.
    if (route === 'GET /api/config') {
      sendJson(res, 200, { enabled: wallet.isEnabled(), network: wallet.getNetwork(), creditsPerSol: wallet.CREDITS_PER_SOL, paused: wallet.isEnabled() ? wallet.isPaused() : false, skinPrices: wallet.getSkinPrices(), winsEnabled: wins.enabled(), demo: DEMO_MODE });
      return;
    }
    // Demo controls (only exist in DEMO_MODE, which only answers to this computer): how many bots, how big, how big the arena.
    if (route === 'GET /api/demo' || route === 'POST /api/demo') {
      if (!DEMO_MODE) { sendJson(res, 404, { error: 'Not found.' }); return; }
      if (route === 'POST /api/demo') {
        const body = await readJson(req, 1024);
        if (body.reset === true) { practiceWorld.resetAll(DEMO_DEFAULTS); sendJson(res, 200, { bots: practiceWorld.botCount, botScale: practiceWorld.botScale, radius: practiceWorld.radius, reset: true }); return; }
        const count = clampNum(body.bots, 0, 80, practiceWorld.botCount);
        const scale = clampNum(body.botScale, 0.5, 6, practiceWorld.botScale);
        const radius = clampNum(body.radius, 1200, 3700, practiceWorld.pendingRadius || practiceWorld.radius);
        practiceWorld.setBots(Math.round(count), scale);
        if (Math.abs(radius - practiceWorld.radius) > 1) practiceWorld.setRadius(radius);
      }
      sendJson(res, 200, { bots: practiceWorld.botCount, botScale: practiceWorld.botScale, radius: practiceWorld.pendingRadius || practiceWorld.radius });
      return;
    }
    // Public: the "playing now" counter on the main screen. Just a number, no names or balances.
    if (route === 'GET /api/online') {
      if (rateLimited('online', clientIp(req), 30, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      sendJson(res, 200, { online: countPlayers() });
      return;
    }
    if (!wallet.isEnabled()) throw new wallet.WalletError('wallet_disabled', 'Solana wallet is not configured on this server', 503);

    if (route === 'GET /api/login-challenge') {
      if (rateLimited('login', clientIp(req), 20, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      sendJson(res, 200, wallet.createLoginChallenge(url.searchParams.get('publicKey')));
      return;
    }

    if (route === 'POST /api/login') {
      if (rateLimited('login', clientIp(req), 20, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const body = await readJson(req, 4096);
      const r = wallet.completeLogin(body.publicKey, body.message, body.signature);
      sendJson(res, 200, Object.assign({ playerId: r.playerId, address: r.address, rate: wallet.CREDITS_PER_SOL, limits: wallet.getPublicLimits(), paused: wallet.isPaused(), network: wallet.getNetwork() },
        balanceBody(wallet.getPlayerBalance(r.playerId))));
      return;
    }

    const body = req.method === 'POST' ? await readJson(req, 4096) : {};
    const playerId = body.playerId || url.searchParams.get('playerId') || req.headers['x-player-id'];
    if (!wallet.isKnownPlayer(playerId)) throw new wallet.WalletError('unknown_player', 'Unknown player — connect your wallet first', 401);

    if (route === 'GET /api/player-deposit-address') {
      if (rateLimited('read', playerId, 60, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const bal = wallet.getPlayerBalance(playerId);
      sendJson(res, 200, {
        address: wallet.getPlayerDepositAddress(playerId),
        balance: bal.credits,
        solBalance: bal.sol,
        rate: wallet.CREDITS_PER_SOL,
        minDepositSol: wallet.MIN_DEPOSIT_SOL,
        limits: wallet.getPublicLimits(),
      });
      return;
    }

    if (route === 'GET /api/player-balance') {
      if (rateLimited('read', playerId, 60, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      sendJson(res, 200, Object.assign(balanceBody(wallet.getPlayerBalance(playerId)), { paused: wallet.isPaused() }));
      return;
    }

    if (route === 'GET /api/skins') {
      if (rateLimited('read', playerId, 60, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      sendJson(res, 200, { owned: wallet.ownedSkins(playerId), prices: wallet.getSkinPrices() });
      return;
    }

    if (route === 'POST /api/buy-skin') {
      if (rateLimited('buy-skin', playerId, 10, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const r = wallet.buySkin(playerId, body.skin);
      sendJson(res, 200, Object.assign({ ok: true, owned: r.owned }, balanceBody(r.balance)));
      return;
    }

    if (route === 'POST /api/post-win') {
      if (!wins.enabled()) throw new wallet.WalletError('wins_off', 'Posting wins is not set up on this server', 503);
      if (rateLimited('post-win', playerId, 6, 3600000)) throw new wallet.WalletError('rate_limited', 'You have posted a lot of wins, try again later', 429);
      const w = winTokens.get(String(body.winId || ''));
      if (!w || w.walletId !== playerId || Date.now() - w.ts > WIN_TTL_MS) throw new wallet.WalletError('no_win', 'That win can no longer be posted', 404);
      if (w.posted) throw new wallet.WalletError('already_posted', 'That win is already posted', 409);
      const profit = w.net - w.buyin; // credits
      const minSol = wallet.getSettings().winPostMinSol.value;
      if (profit < minSol * wallet.CREDITS_PER_SOL - 1e-9) throw new wallet.WalletError('too_small', 'Cash-outs with less than ' + minSol + ' SOL profit are not posted', 400);
      w.posted = true; // set first, so a double click cannot post twice
      const real = wallet.getNetwork() === 'mainnet-beta';
      const unit = real ? 1 / wallet.CREDITS_PER_SOL : 1; // SOL on mainnet, play money elsewhere
      try {
        await wins.postWin({ profit: profit * unit, pct: w.buyin > 0 ? profit / w.buyin * 100 : 0, invested: w.buyin * unit, position: w.net * unit, name: w.name, sym: real ? 'sol' : '$' });
      } catch (e) {
        w.posted = false;
        console.error('[wins] could not post:', e.message);
        throw new wallet.WalletError('post_failed', 'Could not post right now. Try again in a moment.', 502);
      }
      wallet.logLedger('win_posted', { walletId: playerId, profitCredits: profit });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === 'POST /api/check-deposit') {
      // Same answer as /api/player-balance, but first looks on the chain for this player's deposit instead
      // of waiting for the 30s poll. Costs RPC calls, so it is rate limited per player.
      if (rateLimited('check', playerId, 20, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const bal = await wallet.checkPlayerDepositNow(playerId);
      sendJson(res, 200, Object.assign(balanceBody(bal), { paused: wallet.isPaused() }));
      return;
    }

    // POST /api/withdraw
    if (rateLimited('withdraw', playerId, WITHDRAW_RATE_MAX, 60000)) throw new wallet.WalletError('rate_limited', 'Too many withdrawals, wait a minute', 429);
    const r = await wallet.withdraw(body.playerAddress, body.solAmount, { playerId, idempotencyKey: body.idempotencyKey });
    const out = { status: r.status, signature: r.signature, sol: r.sol, balance: balanceBody(r.balance) };
    if (r.status === 'completed') sendJson(res, 200, Object.assign({ ok: true }, out));
    else if (r.status === 'refunded') sendJson(res, 502, Object.assign({ ok: false, error: r.error }, out));
    else sendJson(res, 202, Object.assign({ ok: false, error: 'Withdrawal is still processing — it will settle on its own' }, out));
  } catch (e) {
    if (e instanceof wallet.WalletError) { sendJson(res, e.status, { error: e.message, code: e.code }); return; }
    console.error('[api] unexpected error:', e);
    sendJson(res, 500, { error: 'Internal error' });
  }
}

/* ============================== admin ============================== */

// The admin page and its API only exist when ADMIN_TOKEN is set (20+ characters). The token is
// sent as a Bearer header by admin.html; the page itself carries no data, so it can be served openly.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_HTML_PATH = path.join(__dirname, 'admin.html');

function adminAuthorized(req) {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
  if (!m) return false;
  const given = crypto.createHash('sha256').update(m[1]).digest();
  const wanted = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(given, wanted);
}

// The cash-out hold is an admin setting (stored with the wallet data); the game reads it from CFG.
function applyCashoutHold() {
  const st = wallet.getSettings();
  if (st.cashoutHoldSec && Number.isFinite(st.cashoutHoldSec.value)) CFG.CASHOUT_HOLD_SEC = st.cashoutHoldSec.value;
  if (st.minPlaySec && Number.isFinite(st.minPlaySec.value)) CFG.MIN_PLAY_SEC = st.minPlaySec.value;
  if (st.spawnProtectSec && Number.isFinite(st.spawnProtectSec.value)) CFG.SPAWN_PROTECT_SEC = st.spawnProtectSec.value;
}

/** Everyone in a real-money game right now, for the admin page. Snake ids are already public (every snapshot carries them). */
function livePlayers() {
  const out = [];
  for (const s of realWorld.snakes.values()) {
    if (!s.isPlayer || !s.alive) continue;
    const link = walletByPlayer.get(s.id);
    out.push({
      snakeId: s.id, name: s.name, owner: link ? wallet.ownerOf(link.walletId) : null,
      stakeSol: link ? link.buyin / wallet.CREDITS_PER_SOL : 0,
      valueSol: (s.length / CFG.LEN_PER_DOLLAR) / wallet.CREDITS_PER_SOL,
      aliveSec: Math.round(realWorld.elapsed - s.bornAt),
      holdingCashout: s.cashoutHold !== undefined && s.cashoutHold !== null,
    });
  }
  return out.sort((a, b) => b.valueSol - a.valueSol);
}

/** Take a player out of the game. Paying out credits what the snake is worth now; forfeiting drops it on the map like a death. */
function kickSnake(snakeId, forfeit) {
  const s = realWorld.snakes.get(snakeId);
  if (!s || !s.isPlayer || !s.alive) return false;
  if (forfeit) realWorld._kill(s, 'the house');
  else realWorld.requestCashout(snakeId);
  return true;
}

/** Everything done from the admin page is written to the ledger with the caller's address, and shown in the audit card. */
function audit(req, action, detail) {
  wallet.logLedger('admin_action', { action, detail: detail || null, ip: clientIp(req) });
}

/**
 *   GET  /admin                    -> the admin page
 *   GET  /admin/api/status         -> balances, solvency, limits, unsettled withdrawals, recent ledger
 *   POST /admin/api/pause { paused, reason? } -> stop / resume buy-ins and withdrawals
 *   POST /admin/api/withdraw-earnings { solAmount, idempotencyKey } -> sends collected house fees to OWNER_ADDRESS
 *   POST /admin/api/test-alert     -> sends a test message to ALERT_WEBHOOK_URL
 *   POST /admin/api/settings { changes:{key:value} } -> change limits, the fee, the cash-out hold (bounded, logged)
 *   POST /admin/api/kick { snakeId, forfeit? }       -> remove a player from the game (pays out, or forfeits)
 *   POST /admin/api/ban { owner, reason? } / POST /admin/api/unban { owner } -> block / allow a wallet from buying in
 */
async function handleAdmin(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (ADMIN_TOKEN.length < 20) { res.writeHead(404); res.end('Not found.'); return; }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    fs.readFile(ADMIN_HTML_PATH, (err, data) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('admin.html is missing next to index.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
      res.end(data);
    });
    return;
  }
  if (!url.pathname.startsWith('/admin/api/')) { res.writeHead(404); res.end('Not found.'); return; }

  try {
    if (!adminAuthorized(req)) {
      if (rateLimited('admin-fail', clientIp(req), 10, 60000)) throw new wallet.WalletError('rate_limited', 'Too many attempts', 429);
      throw new wallet.WalletError('unauthorized', 'Wrong or missing admin token', 401);
    }
    const route = req.method + ' ' + url.pathname;
    if (route === 'GET /admin/api/status') {
      const status = await wallet.getAdminStatus();
      status.world = { realPlayers: realWorld.snakes.size, inPlayCredits: realWorld.totalValue(), inPlaySol: realWorld.totalValue() / wallet.CREDITS_PER_SOL, practicePlayers: practiceWorld.snakes.size };
      status.live = livePlayers();
      sendJson(res, 200, status);
    } else if (route === 'POST /admin/api/pause') {
      const body = await readJson(req, 2048);
      audit(req, body.paused ? 'pause' : 'resume', body.paused ? String(body.reason || 'manual').slice(0, 200) : null);
      sendJson(res, 200, wallet.setPaused(!!body.paused, body.reason, 'admin'));
    } else if (route === 'POST /admin/api/settings') {
      if (rateLimited('admin-actions', clientIp(req), 60, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const body = await readJson(req, 2048);
      const settings = wallet.updateSettings(body.changes, 'admin');
      applyCashoutHold();
      audit(req, 'settings', JSON.stringify(body.changes));
      sendJson(res, 200, { ok: true, settings });
    } else if (route === 'POST /admin/api/kick') {
      if (rateLimited('admin-actions', clientIp(req), 60, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const body = await readJson(req, 2048);
      const forfeit = body.forfeit === true;
      const done = kickSnake(String(body.snakeId || ''), forfeit);
      audit(req, forfeit ? 'kick (forfeit)' : 'kick (pay out)', String(body.snakeId || '').slice(0, 40) + (done ? '' : ' - not found'));
      if (!done) throw new wallet.WalletError('not_found', 'That player is no longer in the game', 404);
      sendJson(res, 200, { ok: true });
    } else if (route === 'POST /admin/api/ban') {
      if (rateLimited('admin-actions', clientIp(req), 60, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const body = await readJson(req, 2048);
      const owner = String(body.owner || '');
      wallet.banWallet(owner, body.reason, 'admin');
      audit(req, 'ban', owner + ' - ' + String(body.reason || 'no reason given').slice(0, 200));
      // A banned wallet is also taken out of any game it is in, paid out for what its snake is worth.
      for (const p of livePlayers()) if (p.owner === owner) kickSnake(p.snakeId, false);
      sendJson(res, 200, { ok: true });
    } else if (route === 'POST /admin/api/unban') {
      if (rateLimited('admin-actions', clientIp(req), 60, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const body = await readJson(req, 2048);
      wallet.unbanWallet(String(body.owner || ''), 'admin');
      audit(req, 'unban', String(body.owner || ''));
      sendJson(res, 200, { ok: true });
    } else if (route === 'POST /admin/api/withdraw-earnings') {
      // The destination is OWNER_ADDRESS from the environment; the request only says how much.
      if (rateLimited('admin-earnings', clientIp(req), 10, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      const body = await readJson(req, 2048);
      audit(req, 'withdraw earnings', String(body.solAmount) + ' SOL');
      const r = await wallet.withdrawEarnings(body.solAmount, body.idempotencyKey);
      if (r.status === 'completed') sendJson(res, 200, Object.assign({ ok: true }, r));
      else if (r.status === 'refunded') sendJson(res, 502, Object.assign({ ok: false }, r));
      else sendJson(res, 202, Object.assign({ ok: false }, r, { error: 'Still processing — it will settle on its own' }));
    } else if (route === 'POST /admin/api/test-alert') {
      audit(req, 'test alert', null);
      wallet.sendAlert('test-alert', 'Test alert from the admin page', 0);
      sendJson(res, 200, { ok: true, configured: !!process.env.ALERT_WEBHOOK_URL });
    } else {
      sendJson(res, 404, { error: 'Not found.' });
    }
  } catch (e) {
    if (e instanceof wallet.WalletError) { sendJson(res, e.status, { error: e.message, code: e.code }); return; }
    console.error('[admin] unexpected error:', e);
    sendJson(res, 500, { error: 'Internal error' });
  }
}

/**
 * With ORIGIN_SECRET set, only requests that carry it (Cloudflare adds it) are served. Anyone who finds the
 * direct onrender.com address gets a 403, so they cannot bypass Cloudflare's protection or forge the visitor
 * address header. /health is exempt because the host's own health checks do not go through Cloudflare.
 */
function originAllowed(req) {
  if (!ORIGIN_SECRET || req.url === '/health') return true;
  const given = crypto.createHash('sha256').update(String(req.headers['x-origin-secret'] || '')).digest();
  const wanted = crypto.createHash('sha256').update(ORIGIN_SECRET).digest();
  return crypto.timingSafeEqual(given, wanted);
}

const httpServer = http.createServer((req, res) => {
  if (!originAllowed(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
  // Simple healthcheck endpoint — useful for Railway/Render/Fly health probes.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: countPlayers(), bots: countBots() }));
    return;
  }
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }
  if (req.url === '/admin' || req.url.startsWith('/admin/') || req.url.startsWith('/admin?')) {
    handleAdmin(req, res);
    return;
  }
  if (req.url === '/' || req.url === '/index.html' || req.url === '/slithercash.html') {
    fs.readFile(CLIENT_HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(
          'Could not find slithercash.html.\n\n' +
          'Expected it right next to this server, at:\n' + CLIENT_HTML_PATH + '\n\n' +
          'Make sure every file sits in the SAME folder, no subfolders:\n' +
          '  slithercash/\n' +
          '    slithercash.html\n' +
          '    index.js   <- you are running this one\n' +
          '    gameServer.js\n' +
          '    wsProtocol.js\n' +
          '    package.json\n'
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found.');
});

function countPlayers() {
  let n = 0;
  for (const w of worlds) for (const s of w.snakes.values()) if (s.isPlayer) n++;
  return n;
}
function countBots() {
  let n = 0;
  for (const w of worlds) for (const s of w.snakes.values()) if (!s.isPlayer) n++;
  return n;
}

/* ============================== WebSocket limits ============================== */

const WS_ALLOWED_ORIGINS = (process.env.WS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const WS_JOIN_TIMEOUT_MS = Number(process.env.WS_JOIN_TIMEOUT_MS) || 10000; // a new connection must join a game within this long
const WS_IDLE_LOBBY_MS = Number(process.env.WS_IDLE_LOBBY_MS) || 30000;     // a connection sitting outside a game is dropped after this long

/**
 * Browsers always send Origin, so only this site's own pages (or origins listed in WS_ALLOWED_ORIGINS)
 * can open a game connection. Without this, any other website a player visits could open one for them.
 * A missing Origin means a non-browser client, which has no cross-site risk here.
 */
function verifyWsOrigin(req) {
  if (!originAllowed(req)) return false; // game connections must come through Cloudflare too
  const origin = req.headers.origin;
  if (!origin) return true;
  if (WS_ALLOWED_ORIGINS.includes('*') || WS_ALLOWED_ORIGINS.includes(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

const wsOptions = { verifyOrigin: verifyWsOrigin, getIp: clientIp };
if (Number(process.env.WS_MAX_CONNECTIONS) > 0) wsOptions.maxConnections = Number(process.env.WS_MAX_CONNECTIONS);
if (Number(process.env.WS_MAX_PER_IP) > 0) wsOptions.maxPerIp = Number(process.env.WS_MAX_PER_IP);
if (Number(process.env.WS_MAX_MESSAGES_PER_SEC) > 0) wsOptions.maxMessagesPerSec = Number(process.env.WS_MAX_MESSAGES_PER_SEC);

// Connections that sit outside a game (before joining, or after a death or cash-out) are cut loose.
setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!session.playerId && now - session.idleSince > WS_IDLE_LOBBY_MS) session.conn.close(1008, 'idle');
  }
}, 5000).unref();

attachWebSocketServer(httpServer, (conn, req) => {
  const connId = 'c' + (connCounter++);
  const session = { conn, playerId: null, world: null, joined: false, idleSince: Date.now() };
  sessions.set(connId, session);
  const joinTimer = setTimeout(() => { if (!session.joined) conn.close(1008, 'join timeout'); }, WS_JOIN_TIMEOUT_MS);

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    handleMessage(connId, msg);
  });

  conn.on('close', () => {
    clearTimeout(joinTimer);
    if (session.playerId) {
      // Dropping out mid-game forfeits the stake (it stays in play as orbs). If the
      // snake is already gone — cash-out or death queued this tick — leave the wallet
      // mapping for drainEvents() to settle.
      if (session.world.snakes.has(session.playerId)) {
        session.world.removePlayer(session.playerId);
        if (walletByPlayer.has(session.playerId)) {
          wallet.logLedger('forfeit_disconnect', { walletId: walletByPlayer.get(session.playerId).walletId, snake: session.playerId });
          walletByPlayer.delete(session.playerId);
        }
      }
    }
    sessions.delete(connId);
  });

  conn.on('error', () => {
    // 'close' will also fire; nothing extra needed here.
  });
}, wsOptions);

function handleMessage(connId, msg) {
  const session = sessions.get(connId);
  if (!session || !msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'join': {
      if (session.playerId) return; // already joined
      const name = cleanName(msg.name);
      const buyin = clampNum(msg.buyin, CFG.MIN_BUYIN, CFG.MAX_BUYIN, CFG.DEFAULT_BUYIN);
      let skinIndex = Number.isInteger(msg.skinIndex) ? Math.max(0, Math.min(SKIN_COUNT - 1, msg.skinIndex)) : 0;
      const playerId = connId; // reuse the connection id as the snake id — simple and unique

      // Real-balance play: the buy-in comes out of the server-side balance, never
      // from anything the client claims. No walletId means free practice play.
      let walletId = null;
      let world = practiceWorld;
      // With the wallet on, nobody plays without a signed-in wallet balance. Practice play only exists
      // on a server that has no wallet configured at all.
      if (wallet.isEnabled() && typeof msg.walletId !== 'string') {
        session.conn.send({ t: 'error', message: 'Connect your Phantom wallet to play.' });
        return;
      }
      if (typeof msg.walletId === 'string') {
        walletId = msg.walletId;
        if (wallet.isBanned(walletId)) {
          session.conn.send({ t: 'error', message: 'This wallet is not allowed to play. You can still withdraw your balance.' });
          return;
        }
        if (!wallet.canUseSkin(walletId, skinIndex)) skinIndex = 0; // a paid skin this wallet does not own: play with the default
        try {
          wallet.assertCanBuyIn(buyin);
          wallet.deductPlayer(walletId, buyin / wallet.CREDITS_PER_SOL);
        } catch (e) {
          const message = e.code === 'insufficient_balance'
            ? 'Not enough balance for that buy-in. Deposit more SOL first.'
            : (e.code === 'paused' || e.code === 'over_limit') ? e.message : 'Wallet error: ' + e.message;
          session.conn.send({ t: 'error', message });
          return;
        }
        walletByPlayer.set(playerId, { walletId, buyin });
        wallet.logLedger('buyin', { walletId, snake: playerId, credits: buyin });
        world = realWorld;
      }

      world.addPlayer({ id: playerId, name, buyin, skinIndex });
      session.world = world;
      session.playerId = playerId;
      session.joined = true;
      session.conn.send({
        t: 'welcome',
        id: playerId,
        cfg: {
          WORLD_RADIUS: world.radius, LEN_PER_DOLLAR: CFG.LEN_PER_DOLLAR, TICK_RATE: CFG.TICK_RATE,
          CASHOUT_HOLD_SEC: CFG.CASHOUT_HOLD_SEC, MIN_PLAY_SEC: CFG.MIN_PLAY_SEC, SPAWN_PROTECT_SEC: CFG.SPAWN_PROTECT_SEC,
        },
      });
      break;
    }
    case 'input': {
      if (!session.playerId) return;
      session.world.setInput(session.playerId, Number(msg.angle), !!msg.boosting);
      break;
    }
    case 'cashout': {
      if (!session.playerId) return;
      session.world.startCashout(session.playerId); // pays out only after the hold has lasted CASHOUT_HOLD_SEC on the server
      // NOTE: don't clear session.playerId here — drainEvents() still needs
      // to look this session up by playerId to deliver the cashout_result
      // message on the next tick. It clears playerId itself once sent.
      break;
    }
    case 'cashout_cancel': {
      if (session.playerId) session.world.cancelCashout(session.playerId);
      break;
    }
    case 'ping': {
      session.conn.send({ t: 'pong', ts: Number(msg.ts) || 0 }); // echo a number only, never arbitrary client data
      break;
    }
    default:
      break;
  }
}

/**
 * Player names are shown to everyone else, so they are cleaned here rather than trusted to every
 * place that displays them: no markup characters, no control characters, trimmed, limited length.
 */
function cleanName(raw) {
  const s = typeof raw === 'string' ? raw.replace(/[<>&"'`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, MAX_NAME_LEN) : '';
  return s || 'Player';
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Route per-player events (death/cashout results) generated during tick(). */
function drainEvents(world) {
  if (world.events.length === 0) return;
  for (const evt of world.events) {
    if (evt.type === 'kill') { // a player made a kill: tell them, nothing to settle
      const ks = findSessionByPlayerId(evt.targetId);
      if (ks) ks.conn.send({ t: 'kill', victim: evt.data.victim });
      continue;
    }
    // Settle the stake first, even if the socket is already gone.
    const stake = walletByPlayer.get(evt.targetId);
    if (stake) {
      const walletId = stake.walletId;
      walletByPlayer.delete(evt.targetId);
      if (evt.type === 'cashout_result') {
        try {
          // The house fee comes off the profit above what this player paid in. The client is told the split.
          const r = wallet.settleCashout(walletId, evt.data.amount, stake.buyin);
          evt.data.fee = r.feeCredits;
          evt.data.net = r.netCredits;
          // Any cash-out can be posted to the #wins channel (the admin minimum decides which): give the player an id for exactly this one.
          if (wins.enabled()) evt.data.winId = rememberWin(walletId, evt.data.name, stake.buyin, r.netCredits);
        } catch (e) {
          console.error('[wallet] FAILED to credit cash-out of ' + evt.data.amount + ' credits to ' + walletId + ':', e.message);
        }
      } else if (evt.type === 'death') {
        wallet.logLedger('death', { walletId, snake: evt.targetId, buyin: evt.data.buyin });
      }
    }

    const session = findSessionByPlayerId(evt.targetId);
    if (!session) continue;
    if (evt.type === 'death') {
      session.conn.send({ t: 'death', ...evt.data });
      session.playerId = null;
      session.idleSince = Date.now();
    } else if (evt.type === 'cashout_result') {
      session.conn.send({ t: 'cashout_result', ...evt.data });
      session.playerId = null;
      session.idleSince = Date.now();
    }
  }
  world.events.length = 0;
}

function findSessionByPlayerId(playerId) {
  for (const session of sessions.values()) {
    if (session.playerId === playerId) return session;
  }
  return null;
}

// Orbs farther than this from a player's head cannot be on their screen, so they are not sent. (Every snake's head is
// always sent: the page builds each body from the head's path, so a snake must not drop out and come back.)
const VIEW_RADIUS = 2700;

function broadcastSnapshot(world) {
  const snakesList = world.snapshotSnakes();
  const snakesJson = JSON.stringify(snakesList); // once for everyone
  const elapsed = Math.round(world.elapsed * 1000) / 1000;
  for (const session of sessions.values()) {
    if (!session.playerId || session.world !== world) continue; // un-joined sockets, and the other world's players, get nothing
    const me = world.snakes.get(session.playerId);
    if (me) session.view = { x: me.head.x, y: me.head.y }; // after a death the last view is kept
    const v = session.view || { x: 0, y: 0 };
    // The page builds each body from the path its head takes, so a snake it has not watched yet would show only a stub
    // (the rest invisible, yet deadly). Each snake's real body is sent once, the first time this player is sent that snake.
    if (!session.knownSnakes) session.knownSnakes = new Set();
    for (const sn of snakesList) {
      if (session.knownSnakes.has(sn.id)) continue;
      session.knownSnakes.add(sn.id);
      session.conn.send({ t: 'body', id: sn.id, pts: world.bodyOf(sn.id) });
    }
    if (session.knownSnakes.size > snakesList.length) { const live = new Set(snakesList.map((x) => x.id)); for (const id of session.knownSnakes) if (!live.has(id)) session.knownSnakes.delete(id); }
    // youId and the nearby orbs differ per client, so each client gets its own string around the shared snakes.
    session.conn.send('{"t":"snapshot","youId":' + JSON.stringify(session.playerId) + ',"snakes":' + snakesJson +
      ',"orbs":' + JSON.stringify(world.orbsNear(v.x, v.y, VIEW_RADIUS)) + ',"elapsed":' + elapsed + '}');
  }
}
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const world of worlds) {
    world.tick(dt);
    drainEvents(world);
    broadcastSnapshot(world);
  }
}, TICK_MS);

httpServer.listen(...(DEMO_MODE ? [PORT, '127.0.0.1'] : [PORT]), () => {
  console.log(`SnakePay multiplayer server listening on :${PORT}`);
  console.log(`Healthcheck: http://localhost:${PORT}/health`);
  if (DEMO_MODE) console.log('[demo] DEMO MODE: play money, ' + practiceWorld.botCount + ' bots, answering only on this computer. Open http://localhost:' + PORT);
  if (TRUST_CLOUDFLARE && !ORIGIN_SECRET) {
    console.warn('[security] TRUST_CLOUDFLARE is on but ORIGIN_SECRET is not set: anyone who reaches this server directly can forge their address and dodge the per-address limits. Set ORIGIN_SECRET.');
  }
  if (ORIGIN_SECRET) console.log('[security] ORIGIN_SECRET set: only requests carrying it (and /health) are served');
  wallet.setInPlayProvider(() => realWorld.totalValue());
  wallet.init();
  applyCashoutHold();
  if (practiceWorld.botCount > 0) {
    console.log('[game] NUM_BOTS applies to practice play only — the real-money world never has bots');
  }
});

function shutdown() { for (const w of worlds) w.stop(); wallet.shutdown(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
