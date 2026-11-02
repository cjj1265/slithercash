// index.js — SlitherCash multiplayer server entry point.
//
// Run: node index.js
// Env: PORT (default 8787)
//      GAME_WALLET_SECRET, DEPOSIT_MASTER_SEED, SOLANA_RPC_URL, WALLET_DATA_FILE
//        — see solanaWallet.js. Without GAME_WALLET_SECRET the server runs in
//        practice mode only and the /api wallet routes answer 503.
//      CORS_ORIGIN (optional, comma-separated allowlist for the /api routes)
//      ADMIN_TOKEN (20+ chars; enables /admin), ALERT_WEBHOOK_URL (Discord/Slack alerts),
//      WALLET_PAUSED=1 (start paused), MAX_WITHDRAW_SOL, MAX_PLAYER_DAILY_WITHDRAW_SOL,
//      MAX_DAILY_WITHDRAW_SOL, MAX_BUYIN_CREDITS, LOW_WALLET_SOL — see solanaWallet.js
//      TRUST_PROXY=1 (optional, rate-limit by X-Forwarded-For behind Render/Railway)
//
// Protocol (JSON text frames over WebSocket):
//
//   Client -> Server
//     { t:"join",   name, buyin, skinIndex, walletId? }   // must be sent first.
//                    // With a walletId (the playerId from /api/login) the buy-in
//                    // is deducted from that server-side balance and a cash-out
//                    // is credited back to it. Without one it's free practice play.
//     { t:"input",  angle, boosting }          // steering, send ~20x/sec
//     { t:"cashout" }
//     { t:"ping",   ts }
//
//   Server -> Client
//     { t:"welcome",        id, cfg:{WORLD_RADIUS, LEN_PER_DOLLAR, TICK_RATE} }
//     { t:"snapshot",       youId, snakes:[...], orbs:[...], elapsed }
//     { t:"death",          killerName, buyin, bestRank, coinsEaten }
//     { t:"cashout_result", amount, buyin, bestRank, coinsEaten }
//     { t:"pong",           ts }
//     { t:"error",          message }

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { attachWebSocketServer } = require('./wsProtocol');
const { GameWorld, CFG } = require('./gameServer');
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
const realWorld = new GameWorld({ bots: 0 });
const practiceWorld = new GameWorld();
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

/* ============================== wallet API ============================== */

const CORS_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
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

function clientIp(req) {
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
 *   POST /api/withdraw { playerAddress, solAmount, playerId, idempotencyKey }
 * playerId may also be sent as an X-Player-Id header, which keeps it out of URLs and access logs.
 */
async function handleApi(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    const url = new URL(req.url, 'http://localhost');
    const route = req.method + ' ' + url.pathname;
    const known = ['GET /api/login-challenge', 'POST /api/login', 'GET /api/player-deposit-address', 'GET /api/player-balance', 'POST /api/withdraw'];
    if (!known.includes(route)) { sendJson(res, 404, { error: 'Not found.' }); return; }
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
      sendJson(res, 200, Object.assign({ playerId: r.playerId, address: r.address, rate: wallet.CREDITS_PER_SOL, limits: wallet.getPublicLimits(), paused: wallet.isPaused() },
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

/**
 *   GET  /admin                    -> the admin page
 *   GET  /admin/api/status         -> balances, solvency, limits, unsettled withdrawals, recent ledger
 *   POST /admin/api/pause { paused, reason? } -> stop / resume buy-ins and withdrawals
 *   POST /admin/api/test-alert     -> sends a test message to ALERT_WEBHOOK_URL
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
      status.world = { realPlayers: realWorld.snakes.size, inPlayCredits: realWorld.totalValue(), practicePlayers: practiceWorld.snakes.size };
      sendJson(res, 200, status);
    } else if (route === 'POST /admin/api/pause') {
      const body = await readJson(req, 2048);
      sendJson(res, 200, wallet.setPaused(!!body.paused, body.reason, 'admin'));
    } else if (route === 'POST /admin/api/test-alert') {
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

const httpServer = http.createServer((req, res) => {
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

attachWebSocketServer(httpServer, (conn, req) => {
  const connId = 'c' + (connCounter++);
  sessions.set(connId, { conn, playerId: null, world: null });

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    handleMessage(connId, msg);
  });

  conn.on('close', () => {
    const session = sessions.get(connId);
    if (session && session.playerId) {
      // Dropping out mid-game forfeits the stake (it stays in play as orbs). If the
      // snake is already gone — cash-out or death queued this tick — leave the wallet
      // mapping for drainEvents() to settle.
      if (session.world.snakes.has(session.playerId)) {
        session.world.removePlayer(session.playerId);
        if (walletByPlayer.has(session.playerId)) {
          wallet.logLedger('forfeit_disconnect', { walletId: walletByPlayer.get(session.playerId), snake: session.playerId });
          walletByPlayer.delete(session.playerId);
        }
      }
    }
    sessions.delete(connId);
  });

  conn.on('error', () => {
    // 'close' will also fire; nothing extra needed here.
  });
});

function handleMessage(connId, msg) {
  const session = sessions.get(connId);
  if (!session || !msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'join': {
      if (session.playerId) return; // already joined
      const name = typeof msg.name === 'string' ? msg.name.slice(0, MAX_NAME_LEN) : 'Player';
      const buyin = clampNum(msg.buyin, CFG.MIN_BUYIN, CFG.MAX_BUYIN, CFG.DEFAULT_BUYIN);
      const skinIndex = Number.isInteger(msg.skinIndex) ? msg.skinIndex : 0;
      const playerId = connId; // reuse the connection id as the snake id — simple and unique

      // Real-balance play: the buy-in comes out of the server-side balance, never
      // from anything the client claims. No walletId means free practice play.
      let walletId = null;
      let world = practiceWorld;
      if (typeof msg.walletId === 'string') {
        walletId = msg.walletId;
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
        walletByPlayer.set(playerId, walletId);
        wallet.logLedger('buyin', { walletId, snake: playerId, credits: buyin });
        world = realWorld;
      }

      world.addPlayer({ id: playerId, name, buyin, skinIndex });
      session.world = world;
      session.playerId = playerId;
      session.conn.send({
        t: 'welcome',
        id: playerId,
        cfg: { WORLD_RADIUS: CFG.WORLD_RADIUS, LEN_PER_DOLLAR: CFG.LEN_PER_DOLLAR, TICK_RATE: CFG.TICK_RATE },
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
      session.world.requestCashout(session.playerId);
      // NOTE: don't clear session.playerId here — drainEvents() still needs
      // to look this session up by playerId to deliver the cashout_result
      // message on the next tick. It clears playerId itself once sent.
      break;
    }
    case 'ping': {
      session.conn.send({ t: 'pong', ts: msg.ts });
      break;
    }
    default:
      break;
  }
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
    // Settle the stake first, even if the socket is already gone.
    const walletId = walletByPlayer.get(evt.targetId);
    if (walletId) {
      walletByPlayer.delete(evt.targetId);
      if (evt.type === 'cashout_result') {
        try {
          wallet.creditPlayer(walletId, evt.data.amount / wallet.CREDITS_PER_SOL);
          wallet.logLedger('cashout', { walletId, snake: evt.targetId, buyin: evt.data.buyin, credits: evt.data.amount });
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
    } else if (evt.type === 'cashout_result') {
      session.conn.send({ t: 'cashout_result', ...evt.data });
      session.playerId = null;
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

function broadcastSnapshot(world) {
  const snap = world.snapshot();
  const base = JSON.stringify({ t: 'snapshot', snakes: snap.snakes, orbs: snap.orbs, elapsed: snap.elapsed });
  for (const session of sessions.values()) {
    if (!session.playerId || session.world !== world) continue; // un-joined sockets, and the other world's players, get nothing
    // youId differs per client, so we can't reuse the exact same string for everyone.
    session.conn.send(insertYouId(base, session.playerId));
  }
}

// Cheap way to personalize the youId field without re-serializing the whole
// (potentially large) snapshot per connection.
function insertYouId(baseJson, youId) {
  return baseJson.replace('{"t":"snapshot",', `{"t":"snapshot","youId":${JSON.stringify(youId)},`);
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

httpServer.listen(PORT, () => {
  console.log(`SlitherCash multiplayer server listening on :${PORT}`);
  console.log(`Healthcheck: http://localhost:${PORT}/health`);
  wallet.setInPlayProvider(() => realWorld.totalValue());
  wallet.init();
  if (wallet.isEnabled() && practiceWorld.botCount > 0) {
    console.log('[wallet] NUM_BOTS applies to practice play only — the real-money world never has bots');
  }
});

function shutdown() { for (const w of worlds) w.stop(); wallet.shutdown(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
