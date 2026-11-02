// index.js — SlitherCash multiplayer server entry point.
//
// Run: node index.js
// Env: PORT (default 8787)
//      GAME_WALLET_SECRET, DEPOSIT_MASTER_SEED, SOLANA_RPC_URL, WALLET_DATA_FILE
//        — see solanaWallet.js. Without GAME_WALLET_SECRET the server runs in
//        practice mode only and the /api wallet routes answer 503.
//      CORS_ORIGIN (optional, comma-separated allowlist for the /api routes)
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

const world = new GameWorld();

/** connId -> { conn: WSConnection, playerId: string|null } */
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
      sendJson(res, 200, Object.assign({ playerId: r.playerId, address: r.address, rate: wallet.CREDITS_PER_SOL },
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
      });
      return;
    }

    if (route === 'GET /api/player-balance') {
      if (rateLimited('read', playerId, 60, 60000)) throw new wallet.WalletError('rate_limited', 'Too many requests', 429);
      sendJson(res, 200, balanceBody(wallet.getPlayerBalance(playerId)));
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
  for (const s of world.snakes.values()) if (s.isPlayer) n++;
  return n;
}
function countBots() {
  let n = 0;
  for (const s of world.snakes.values()) if (!s.isPlayer) n++;
  return n;
}

attachWebSocketServer(httpServer, (conn, req) => {
  const connId = 'c' + (connCounter++);
  sessions.set(connId, { conn, playerId: null });

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
      if (world.snakes.has(session.playerId)) {
        world.removePlayer(session.playerId);
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
      if (typeof msg.walletId === 'string') {
        walletId = msg.walletId;
        try {
          wallet.deductPlayer(walletId, buyin / wallet.CREDITS_PER_SOL);
        } catch (e) {
          const message = e.code === 'insufficient_balance'
            ? 'Not enough balance for that buy-in. Deposit more SOL first.'
            : 'Wallet error: ' + e.message;
          session.conn.send({ t: 'error', message });
          return;
        }
        walletByPlayer.set(playerId, walletId);
        wallet.logLedger('buyin', { walletId, snake: playerId, credits: buyin });
      }

      world.addPlayer({ id: playerId, name, buyin, skinIndex });
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
      world.setInput(session.playerId, Number(msg.angle), !!msg.boosting);
      break;
    }
    case 'cashout': {
      if (!session.playerId) return;
      world.requestCashout(session.playerId);
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
function drainEvents() {
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

function broadcastSnapshot() {
  const snap = world.snapshot();
  const base = JSON.stringify({ t: 'snapshot', snakes: snap.snakes, orbs: snap.orbs, elapsed: snap.elapsed });
  for (const session of sessions.values()) {
    if (!session.playerId) continue; // don't spam data to un-joined sockets
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
  world.tick(dt);
  drainEvents();
  broadcastSnapshot();
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`SlitherCash multiplayer server listening on :${PORT}`);
  console.log(`Healthcheck: http://localhost:${PORT}/health`);
  wallet.init();
});

process.on('SIGINT', () => { world.stop(); wallet.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { world.stop(); wallet.shutdown(); process.exit(0); });
