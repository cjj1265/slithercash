// End-to-end test of the SlitherCash wallet against a simulated chain (throwaway keys only).
// Run from the files/ folder:  npm run test:wallet   (takes a few minutes: it waits out real polling intervals)
// Covers: auth, deposits, play, withdrawals, persistence, wiped-store regression, withdrawal limits,
// buy-in cap, pause switch, admin API, alerts, world separation, solvency auto-pause.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const FILES = path.join(__dirname, '..'); // the folder holding index.js
const { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const HERE = __dirname;
const SP = path.join(require('os').tmpdir(), 'slithercash-tests'); // scratch files (chain state, wallet data) live outside the repo
fs.mkdirSync(SP, { recursive: true });
process.env.FAKE_CHAIN_FILE = path.join(SP, 'e2e-chain.json');
const fake = require('./fake-chain-lib.js');
const conn = new fake.FakeConnection();

const DATA = path.join(SP, 'e2e-wallet-data.json');
const PORT = 8799;
const HOOK_PORT = 8898;
const BASE = 'http://localhost:' + PORT;
const MASTER = 'e2e-master-seed-0123456789abcdef';
const ADMIN = 'e2e-admin-token-0123456789abcdef';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (l) => l / LAMPORTS_PER_SOL;
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9);

// ---- webhook receiver (stands in for Discord/Slack) ----
const alerts = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { try { alerts.push(JSON.parse(body).content); } catch (e) {} res.writeHead(204); res.end(); });
});
const alertSeen = async (needle, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 8000)) { if (alerts.some((a) => a.includes(needle))) return true; await sleep(300); }
  return false;
};

// ---- server process control ----
let child = null;
function startServer(gameKp, dataFile, extraEnv) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PORT: String(PORT), GAME_WALLET_SECRET: JSON.stringify(Array.from(gameKp.secretKey)),
      DEPOSIT_MASTER_SEED: MASTER, WALLET_DATA_FILE: dataFile, DEPOSIT_POLL_MS: '4000', WITHDRAW_RATE_MAX: '100',
      ALERT_WEBHOOK_URL: 'http://localhost:' + HOOK_PORT + '/hook',
    }, extraEnv || {});
    child = spawn(process.execPath, ['-r', path.join(HERE, 'fake-preload.js'), 'index.js'], { cwd: FILES, env });
    let out = '';
    const ready = () => { if (/game wallet balance|could not read game wallet|REFUSING TO START/.test(out)) resolve(); };
    child.stdout.on('data', (d) => { out += d; ready(); });
    child.stderr.on('data', (d) => { out += d; ready(); if (!/punycode|trace-deprecation|\[ALERT\]|REFUSING|MAINNET/.test(String(d))) process.stdout.write('  [server err] ' + d); });
    child.on('exit', (c) => { if (c) reject(new Error('server exited ' + c + '\n' + out)); });
    setTimeout(() => reject(new Error('server start timeout\n' + out)), 30000);
  });
}
async function stopServer() {
  if (!child) return;
  const c = child; child = null;
  c.kill();
  await sleep(600);
}
process.on('exit', () => { if (child) child.kill(); });

// ---- http helpers ----
async function http_(method, p, body, headers) {
  const res = await fetch(BASE + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
const admin = (method, p, body, token) => http_(method, p, body, { Authorization: 'Bearer ' + (token === undefined ? ADMIN : token) });

function signMessage(kp, msg) {
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(msg), key).toString('base64');
}
async function login(kp) {
  const pk = kp.publicKey.toBase58();
  const ch = await http_('GET', '/api/login-challenge?publicKey=' + pk);
  const signature = signMessage(kp, ch.json.message);
  const r = await http_('POST', '/api/login', { publicKey: pk, message: ch.json.message, signature });
  return { ch: ch.json, signature, res: r };
}
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(2000); }
  console.log('  (timed out waiting for ' + label + ')');
  return null;
}
async function transfer(from, to, lamports) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: from.publicKey, blockhash, lastValidBlockHeight })
    .add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(to), lamports }));
  tx.sign(from);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}
const balanceOf = async (pid) => (await http_('GET', '/api/player-balance', null, { 'X-Player-Id': pid })).json;
const depositAndWait = async (kp, pid, addr, solAmount, expectTotal) => {
  await transfer(kp, addr, Math.round(solAmount * LAMPORTS_PER_SOL));
  return waitFor(async () => { const b = await balanceOf(pid); return near(b.sol, expectTotal) ? b : null; }, 90000, 'deposit credit to ' + expectTotal);
};

// ---- websocket helpers ----
function wsOpen(walletId, buyin, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + PORT);
    const state = { ws, msgs: [], snaps: [], id: null };
    const timer = setTimeout(() => resolve(state), 6000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: name || 'e2e', buyin, skinIndex: 0, walletId }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'snapshot') { state.snaps.push(m); return; }
      state.msgs.push(m);
      if (m.t === 'welcome') { state.id = m.id; clearTimeout(timer); resolve(state); }
      if (m.t === 'error') { clearTimeout(timer); resolve(state); }
    };
  });
}
function wsCashout(state) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 6000);
    const prev = state.ws.onmessage;
    state.ws.onmessage = (ev) => { prev(ev); const m = JSON.parse(ev.data); if (m.t === 'cashout_result') { clearTimeout(t); resolve(m); } };
    state.ws.send(JSON.stringify({ t: 'cashout' }));
  });
}
const errOf = (state) => (state.msgs.find((m) => m.t === 'error') || {}).message || null;

(async () => {
  for (const f of [DATA, DATA + '.ledger.jsonl', DATA + '.tmp', process.env.FAKE_CHAIN_FILE]) fs.rmSync(f, { force: true });
  await new Promise((r) => hook.listen(HOOK_PORT, r));

  const game = Keypair.generate(), A = Keypair.generate(), B = Keypair.generate();
  fake.airdrop(game.publicKey.toBase58(), 1 * LAMPORTS_PER_SOL);
  fake.airdrop(A.publicKey.toBase58(), 1 * LAMPORTS_PER_SOL);
  fake.airdrop(B.publicKey.toBase58(), 1 * LAMPORTS_PER_SOL);

  const LIMIT_ENV = { ADMIN_TOKEN: ADMIN, MAX_WITHDRAW_SOL: '0.04', MAX_PLAYER_DAILY_WITHDRAW_SOL: '0.07', MAX_DAILY_WITHDRAW_SOL: '0.12', WS_JOIN_TIMEOUT_MS: '1500' };

  console.log('\n== startup, auth, admin auth ==');
  await startServer(game, DATA, LIMIT_ENV);
  check('/health still works', (await http_('GET', '/health')).json.ok === true);
  const cfg = await http_('GET', '/api/config');
  check('/api/config reports the verified network', cfg.status === 200 && cfg.json.enabled === true && cfg.json.network === 'devnet', cfg.json);
  check('balance without playerId -> 401', (await http_('GET', '/api/player-balance')).status === 401);
  check('balance with unregistered playerId -> 401', (await http_('GET', '/api/player-balance?playerId=' + 'ab'.repeat(32))).status === 401);

  const badCh = await http_('GET', '/api/login-challenge?publicKey=' + A.publicKey.toBase58());
  const wrongSig = await http_('POST', '/api/login', { publicKey: A.publicKey.toBase58(), message: badCh.json.message, signature: signMessage(Keypair.generate(), badCh.json.message) });
  check('login with someone else\'s signature -> 401', wrongSig.status === 401);
  const LA = await login(A);
  check('login ok, returns limits', LA.res.status === 200 && /^[a-f0-9]{64}$/.test(LA.res.json.playerId) && LA.res.json.limits.maxWithdrawSol === 0.04 && LA.res.json.limits.maxBuyin === 20, LA.res.json);
  check('replayed challenge rejected', (await http_('POST', '/api/login', { publicKey: A.publicKey.toBase58(), message: LA.ch.message, signature: LA.signature })).status === 401);
  const pidA = LA.res.json.playerId;
  const HA = { 'X-Player-Id': pidA };
  const addrA = (await http_('GET', '/api/player-deposit-address', null, HA)).json.address;
  check('deposit address matches login', addrA === LA.res.json.address);

  check('admin page served', (await fetch(BASE + '/admin')).status === 200);
  check('admin API without token -> 401', (await http_('GET', '/admin/api/status')).status === 401);
  check('admin API with wrong token -> 401', (await admin('GET', '/admin/api/status', null, 'x'.repeat(40))).status === 401);
  const st0 = await admin('GET', '/admin/api/status');
  check('admin status ok', st0.status === 200 && st0.json.pause.paused === false && st0.json.solvency.ok === true && st0.json.gameWallet.address === game.publicKey.toBase58(), st0.json.error || st0.json.solvency);
  check('admin status has no bearer ids', !JSON.stringify(st0.json).includes(pidA));
  const S0 = st0.json.solvency.surplusSol;
  console.log('  baseline surplus (the house\'s own capital): ' + S0 + ' SOL');
  const noOwner = await admin('POST', '/admin/api/withdraw-earnings', { solAmount: 0.01, idempotencyKey: 'e2e-earn-nowner1' });
  check('earnings withdrawal is refused when OWNER_ADDRESS is not set', noOwner.status === 400 && noOwner.json.code === 'owner_not_configured', noOwner);
  check('earnings withdrawal needs the admin token', (await http_('POST', '/admin/api/withdraw-earnings', { solAmount: 0.01, idempotencyKey: 'e2e-earn-noauth1' })).status === 401);
  for (let i = 0; i < 12; i++) await admin('GET', '/admin/api/status', null, 'y'.repeat(30));
  check('repeated bad admin tokens get rate limited', (await admin('GET', '/admin/api/status', null, 'z'.repeat(30))).status === 429);

  console.log('\n== websocket hardening on the real server ==');
  const handshake = (origin) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, headers: Object.assign({
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' }, origin ? { Origin: origin } : {}) });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
  check('a page on another site cannot open a game connection (403)', (await handshake('http://evil.example')) === 403);
  check('this site\'s own page can', (await handshake('http://127.0.0.1:' + PORT)) === 101);
  check('a non-browser client (no Origin) can', (await handshake()) === 101);

  const evil = await wsOpen(undefined, 5, '<img src=x onerror=alert(1)>');
  await sleep(600);
  const evilSnap = evil.snaps[evil.snaps.length - 1];
  const evilName = evilSnap && evilSnap.snakes.find((s) => s.id === evil.id).name;
  check('markup in a player name is stripped by the server', evil.id && evilName && !/[<>"'&]/.test(evilName) && evilName.length <= 16, evilName);
  evil.ws.close();
  const junk = await wsOpen(undefined, 5, '\u0000\u0007‮  ');
  await sleep(300);
  const junkSnap = junk.snaps[junk.snaps.length - 1];
  check('a name made only of control characters becomes the default', junkSnap && junkSnap.snakes.find((s) => s.id === junk.id).name === 'Player');
  junk.ws.close();

  const waitClose = (ws, ms) => new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); ws.onclose = (e) => { clearTimeout(t); resolve(e.code); }; });
  const lurker = new WebSocket('ws://127.0.0.1:' + PORT); // connects, never joins
  await new Promise((r) => { lurker.onopen = r; });
  const lurkCode = await waitClose(lurker, 4000);
  check('a connection that never joins is dropped (join timeout 1.5s here)', lurkCode === 1008, lurkCode);

  const flooder = await wsOpen(undefined, 5);
  const floodClosed = waitClose(flooder.ws, 3000);
  for (let i = 0; i < 400; i++) flooder.ws.send(JSON.stringify({ t: 'input', angle: 1, boosting: false }));
  check('flooding messages gets the connection closed (1008)', (await floodClosed) === 1008);

  const big = await wsOpen(undefined, 5);
  const bigClosed = waitClose(big.ws, 3000);
  big.ws.send('x'.repeat(10000));
  check('an oversized message gets the connection closed (1009)', (await bigClosed) === 1009);

  const rawJunk = await wsOpen(undefined, 5);
  rawJunk.ws.send('not json at all'); rawJunk.ws.send('{"t":"input","angle":"banana","boosting":{"x":1}}'); rawJunk.ws.send('{"t":{"a":1}}'); rawJunk.ws.send('null');
  await sleep(500);
  check('malformed and junk messages are ignored without crashing anything', rawJunk.ws.readyState === 1 && (await http_('GET', '/health')).json.ok === true);
  rawJunk.ws.close();

  // An abrupt hang-up (TCP close with no WebSocket close frame) must remove the player from the game.
  await sleep(700); // let the previous tests' sockets finish closing so the baseline is steady
  const playersBefore = (await http_('GET', '/health')).json.players;
  const maskedText = (str) => { const p = Buffer.from(str); const m = crypto.randomBytes(4); return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, Buffer.from(p.map((b, i) => b ^ m[i & 3]))]); };
  await new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1');
    let sent = false;
    sock.on('connect', () => sock.write(['GET / HTTP/1.1', 'Host: 127.0.0.1:' + PORT, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version: 13', '', ''].join('\r\n')));
    sock.on('data', async () => {
      if (sent) return;
      sent = true;
      sock.write(maskedText(JSON.stringify({ t: 'join', name: 'raw', buyin: 5, skinIndex: 0 })));
      for (let i = 0; i < 40 && (await http_('GET', '/health')).json.players <= playersBefore; i++) await sleep(50);
      sock.destroy(); // vanish
      resolve();
    });
    sock.on('error', () => {});
  });
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { gone = (await http_('GET', '/health')).json.players <= playersBefore; if (!gone) await sleep(100); }
  check('a client that vanishes without saying goodbye is removed from the game', gone);

  console.log('\n== deposits and solvency ==');
  await transfer(A, addrA, 0.005 * LAMPORTS_PER_SOL); // dust
  const credited = await depositAndWait(A, pidA, addrA, 0.05, 0.05);
  check('deposit credited exactly 0.05 SOL (dust ignored)', !!credited, credited);
  await sleep(6000);
  const st1 = (await admin('GET', '/admin/api/status')).json;
  // The 0.005 dust deposit was swept into the game wallet but never credited, so the house keeps it.
  check('solvent after deposit + sweep; surplus grew by exactly the dust', st1.solvency.ok && near(st1.solvency.surplusSol, S0 + 0.005, 0.0001), st1.solvency);
  check('fees tracked', st1.solvency.feesPaidSol > 0, st1.solvency);
  const S1 = st1.solvency.surplusSol;

  console.log('\n== game: buy-in cap, world separation, cash-out ==');
  const over = await wsOpen(pidA, 25); // cap is $20
  check('buy-in above the $20 cap rejected with a clear message', /maximum buy-in/i.test(errOf(over) || '') && (errOf(over) || '').includes('$20'), over.msgs);
  over.ws.close();
  check('rejected buy-in left balance alone', near((await balanceOf(pidA)).sol, 0.05));
  const unknown = await wsOpen('ff'.repeat(32), 5);
  check('unknown walletId cannot join with a stake', !!errOf(unknown));
  unknown.ws.close();

  const real = await wsOpen(pidA, 5);
  const practice = await wsOpen(undefined, 5);
  await sleep(1500);
  check('real-money player joined', !!real.id, real.msgs);
  const lastReal = real.snaps[real.snaps.length - 1], lastPractice = practice.snaps[practice.snaps.length - 1];
  check('real world contains only the real player', lastReal && lastReal.snakes.length === 1 && lastReal.snakes[0].id === real.id, lastReal && lastReal.snakes.map((s) => s.id));
  check('practice world is separate (does not see the real player)', lastPractice && lastPractice.snakes.length === 1 && lastPractice.snakes[0].id === practice.id, lastPractice && lastPractice.snakes.map((s) => s.id));
  const mid = (await admin('GET', '/admin/api/status')).json;
  check('open stake counted as in play, surplus unchanged', near(mid.solvency.inPlaySol, 0.05, 0.001) && mid.solvency.ok && near(mid.solvency.surplusSol, S1, 0.0001), mid.solvency);
  check('stake deducted while playing', near((await balanceOf(pidA)).sol, 0));
  const co = await wsCashout(real);
  check('cashed out for exactly the buy-in, no house fee on a break-even cash-out', co && near(co.amount, 5, 1e-6) && co.fee === 0 && near(co.net, 5, 1e-6), co);
  const stE = (await admin('GET', '/admin/api/status')).json;
  check('admin shows the fee setting and no fees collected yet', stE.earnings && stE.earnings.rakePercent === 5 && stE.earnings.feesCollectedSol === 0, stE.earnings);
  real.ws.close(); practice.ws.close();
  check('balance restored after cash-out', near((await balanceOf(pidA)).sol, 0.05));

  console.log('\n== withdrawals and limits (per request 0.04, per player/day 0.07, all players/day 0.10) ==');
  const key = 'e2e-key-' + crypto.randomBytes(6).toString('hex');
  const body = { playerAddress: A.publicKey.toBase58(), solAmount: 0.02, playerId: pidA, idempotencyKey: key };
  const before = await conn.getBalance(A.publicKey);
  const [w1, w2] = await Promise.all([http_('POST', '/api/withdraw', body), http_('POST', '/api/withdraw', body)]);
  check('withdraw completed', w1.status === 200 && w1.json.ok === true && !!w1.json.signature, w1);
  check('concurrent duplicate returns the same signature', w2.json.signature === w1.json.signature);
  check('later duplicate does not pay again', (await http_('POST', '/api/withdraw', body)).json.signature === w1.json.signature);
  check('paid exactly 0.02 on-chain, balance deducted once', (await conn.getBalance(A.publicKey)) - before === 0.02 * LAMPORTS_PER_SOL && near((await balanceOf(pidA)).sol, 0.03));
  const other = Keypair.generate().publicKey.toBase58();
  check('different address -> 403', (await http_('POST', '/api/withdraw', Object.assign({}, body, { playerAddress: other, idempotencyKey: 'e2e-key-mismatch1' }))).status === 403);
  check('more than balance -> 402', (await http_('POST', '/api/withdraw', Object.assign({}, body, { solAmount: 5, idempotencyKey: 'e2e-key-toomuch1' }))).status === 402);
  check('no idempotencyKey -> 400', (await http_('POST', '/api/withdraw', { playerAddress: body.playerAddress, solAmount: 0.01, playerId: pidA })).status === 400);
  check('below minimum -> 400', (await http_('POST', '/api/withdraw', Object.assign({}, body, { solAmount: 0.0001, idempotencyKey: 'e2e-key-tiny0001' }))).status === 400);
  check('same key, different amount -> 409', (await http_('POST', '/api/withdraw', Object.assign({}, body, { solAmount: 0.01 }))).status === 409);
  check('negative amount -> 400', (await http_('POST', '/api/withdraw', Object.assign({}, body, { solAmount: -1, idempotencyKey: 'e2e-key-negative1' }))).status === 400);

  const more = await depositAndWait(A, pidA, addrA, 0.1, 0.13);
  check('second deposit credited (balance 0.13)', !!more, more);
  const lim1 = await http_('POST', '/api/withdraw', Object.assign({}, body, { solAmount: 0.05, idempotencyKey: 'e2e-key-overreq01' }));
  check('over the per-request limit -> 403', lim1.status === 403 && lim1.json.code === 'over_limit' && /maximum per withdrawal/i.test(lim1.json.error), lim1);
  const w3 = await http_('POST', '/api/withdraw', Object.assign({}, body, { solAmount: 0.04, idempotencyKey: 'e2e-key-ok-004' }));
  check('withdrawal at the per-request limit allowed', w3.status === 200 && w3.json.ok, w3);
  const lim2 = await http_('POST', '/api/withdraw', Object.assign({}, body, { solAmount: 0.02, idempotencyKey: 'e2e-key-overday01' }));
  check('over the per-player daily limit -> 403', lim2.status === 403 && /daily withdrawal limit/i.test(lim2.json.error), lim2);
  check('refused withdrawals did not touch the balance', near((await balanceOf(pidA)).sol, 0.09), await balanceOf(pidA));

  const LB = await login(B);
  const pidB = LB.res.json.playerId, HB = { 'X-Player-Id': pidB };
  const addrB = (await http_('GET', '/api/player-deposit-address', null, HB)).json.address;
  check('second player funded (0.1 SOL)', !!(await depositAndWait(B, pidB, addrB, 0.1, 0.1)));
  const bw1 = await http_('POST', '/api/withdraw', { playerAddress: B.publicKey.toBase58(), solAmount: 0.04, playerId: pidB, idempotencyKey: 'e2e-bkey-0001' });
  check('player B withdraws 0.04 (everyone together now at 0.10 of the 0.12 cap)', bw1.status === 200, bw1);
  const bw2 = await http_('POST', '/api/withdraw', { playerAddress: B.publicKey.toBase58(), solAmount: 0.03, playerId: pidB, idempotencyKey: 'e2e-bkey-0002' });
  check('global daily cap refuses further withdrawals -> 503', bw2.status === 503 && bw2.json.code === 'over_limit', bw2);
  check('global cap sent an alert', await alertSeen('Global daily withdrawal cap'), alerts);
  check('refused withdrawal left B\'s balance alone', near((await balanceOf(pidB)).sol, 0.06));

  console.log('\n== pause switch ==');
  const stake = await wsOpen(pidA, 5);
  check('A has an open stake', !!stake.id, stake.msgs);
  const p1 = await admin('POST', '/admin/api/pause', { paused: true, reason: 'e2e test' });
  check('admin can pause', p1.status === 200 && p1.json.paused === true, p1);
  check('pause alert sent', await alertSeen('PAUSED'), alerts);
  const pw = await http_('POST', '/api/withdraw', { playerAddress: A.publicKey.toBase58(), solAmount: 0.01, playerId: pidA, idempotencyKey: 'e2e-key-paused001' });
  check('withdrawals refused while paused -> 503', pw.status === 503 && pw.json.code === 'paused', pw);
  const pj = await wsOpen(pidB, 5);
  check('real-money buy-ins refused while paused', /paused/i.test(errOf(pj) || ''), pj.msgs);
  pj.ws.close();
  const prj = await wsOpen(undefined, 5);
  check('practice play still works while paused', !!prj.id);
  prj.ws.close();
  check('balance API reports paused', (await balanceOf(pidA)).paused === true);
  const pco = await wsCashout(stake);
  stake.ws.close();
  check('cash-outs are still credited while paused', pco && near((await balanceOf(pidA)).sol, 0.09), await balanceOf(pidA));
  const pst = (await admin('GET', '/admin/api/status')).json;
  check('admin shows the pause and its reason', pst.pause.paused && pst.pause.reason === 'e2e test' && pst.pause.by === 'admin', pst.pause);

  await stopServer();
  await startServer(game, DATA, LIMIT_ENV);
  check('pause survives a restart', (await balanceOf(pidA)).paused === true);
  const res1 = await admin('POST', '/admin/api/pause', { paused: false });
  check('admin can resume', res1.status === 200 && res1.json.paused === false);
  check('resume alert sent', await alertSeen('Resumed'), alerts);
  check('withdrawals work again after resume', (await http_('POST', '/api/withdraw', { playerAddress: A.publicKey.toBase58(), solAmount: 0.01, playerId: pidA, idempotencyKey: 'e2e-key-resumed01' })).status === 200);
  const ta = await admin('POST', '/admin/api/test-alert');
  check('test alert reaches the webhook', ta.json.configured === true && (await alertSeen('Test alert')), alerts);
  const fin = (await admin('GET', '/admin/api/status')).json;
  check('still solvent after all of that, surplus unchanged', fin.solvency.ok && near(fin.solvency.surplusSol, S1, 0.0001), fin.solvency);

  console.log('\n== persistence ==');
  await stopServer();
  await startServer(game, DATA, LIMIT_ENV);
  await sleep(10000);
  check('balances survive restart, nothing re-credited', near((await balanceOf(pidA)).sol, 0.08) && near((await balanceOf(pidB)).sol, 0.06), [await balanceOf(pidA), await balanceOf(pidB)]);
  const ledger = fs.readFileSync(DATA + '.ledger.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const types = ledger.map((l) => l.type);
  check('ledger covers deposit, dust, sweep, buyin, cashout, withdraw, pause', ['deposit', 'deposit_rejected_dust', 'sweep', 'buyin', 'cashout', 'withdraw_ok', 'paused', 'resumed'].every((t) => types.includes(t)), types);

  console.log('\n== lost records must not re-credit old deposits ==');
  await stopServer();
  await sleep(35000);
  for (const f of [DATA, DATA + '.ledger.jsonl']) fs.rmSync(f, { force: true });
  await startServer(game, DATA, LIMIT_ENV);
  const LA2 = await login(A);
  check('same playerId after a wipe, balance starts at zero', LA2.res.json.playerId === pidA && near((await balanceOf(pidA)).sol, 0));
  await transfer(A, addrA, 0.03 * LAMPORTS_PER_SOL);
  await waitFor(async () => (await balanceOf(pidA)).sol > 0, 90000, 'post-wipe deposit');
  await sleep(9000);
  check('only the new 0.03 SOL is credited, old history ignored', near((await balanceOf(pidA)).sol, 0.03), await balanceOf(pidA));
  check('old deposits logged as ignored', fs.readFileSync(DATA + '.ledger.jsonl', 'utf8').includes('deposit_ignored_before_registration'));

  console.log('\n== refunds and crash recovery (unfunded house, auto-pause switched off) ==');
  await stopServer();
  const poor = Keypair.generate();
  const DATA2 = path.join(SP, 'e2e-wallet-data2.json');
  for (const f of [DATA2, DATA2 + '.ledger.jsonl']) fs.rmSync(f, { force: true });
  await startServer(poor, DATA2, { INSOLVENCY_TOLERANCE_SOL: '1000' });
  const pid2 = (await login(A)).res.json.playerId;
  await stopServer();
  const store = JSON.parse(fs.readFileSync(DATA2, 'utf8'));
  store.players[pid2].lamports = 50000000;
  const fakeSig = require('bs58').encode(crypto.randomBytes(64));
  store.withdrawals[pid2 + ':orphan-sending'] = { playerId: pid2, key: 'orphan-sending', to: A.publicKey.toBase58(), lamports: 10000000, status: 'sending', signature: fakeSig, lastValidBlockHeight: 1, error: null, createdAt: Date.now() };
  store.withdrawals[pid2 + ':orphan-pending'] = { playerId: pid2, key: 'orphan-pending', to: A.publicKey.toBase58(), lamports: 7000000, status: 'pending', signature: null, lastValidBlockHeight: null, error: null, createdAt: Date.now() };
  fs.writeFileSync(DATA2, JSON.stringify(store));
  await startServer(poor, DATA2, { INSOLVENCY_TOLERANCE_SOL: '1000' });
  const H2 = { 'X-Player-Id': pid2 };
  check('orphaned withdrawals refunded on startup', !!(await waitFor(async () => near((await http_('GET', '/api/player-balance', null, H2)).json.sol, 0.067), 60000, 'orphan refunds')));
  const poorW = await http_('POST', '/api/withdraw', { playerAddress: A.publicKey.toBase58(), solAmount: 0.02, playerId: pid2, idempotencyKey: 'e2e-poor-house1' });
  check('house cannot pay -> refunded (502)', poorW.status === 502 && poorW.json.status === 'refunded', poorW);
  check('refund restored the full balance', near((await http_('GET', '/api/player-balance', null, H2)).json.sol, 0.067));
  check('admin API is off without ADMIN_TOKEN (404)', (await http_('GET', '/admin/api/status')).status === 404 && (await fetch(BASE + '/admin')).status === 404);

  console.log('\n== insolvency auto-pause ==');
  await stopServer();
  alerts.length = 0;
  await startServer(poor, DATA2, {}); // default tolerance: the unfunded house now owes more than it holds
  const paused = await waitFor(async () => (await http_('GET', '/api/player-balance', null, H2)).json.paused === true, 40000, 'auto-pause');
  check('server pauses itself when the game wallet cannot cover what it owes', !!paused);
  check('insolvency alert sent', await alertSeen('INSOLVENT'), alerts);
  const apw = await http_('POST', '/api/withdraw', { playerAddress: A.publicKey.toBase58(), solAmount: 0.02, playerId: pid2, idempotencyKey: 'e2e-after-pause1' });
  check('withdrawals refused after the auto-pause', apw.status === 503, apw);
  const stp = JSON.parse(fs.readFileSync(DATA2, 'utf8'));
  check('auto-pause reason recorded and persisted', stp.paused && /Auto-pause/.test(stp.paused.reason) && stp.paused.by === 'auto', stp.paused);

  console.log('\n== house fee, end to end: two real players fight head-on and the winner cashes out ==');
  await stopServer();
  const feeData = path.join(SP, 'e2e-wallet-data-fee.json');
  for (const f of [feeData, feeData + '.ledger.jsonl']) fs.rmSync(f, { force: true });
  const ownerKp = Keypair.generate();
  await startServer(game, feeData, { ADMIN_TOKEN: ADMIN, OWNER_ADDRESS: ownerKp.publicKey.toBase58() });
  const KC = Keypair.generate(), KD = Keypair.generate();
  fake.airdrop(KC.publicKey.toBase58(), LAMPORTS_PER_SOL); fake.airdrop(KD.publicKey.toBase58(), LAMPORTS_PER_SOL);
  const LC = await login(KC), LD = await login(KD);
  const pidC = LC.res.json.playerId, pidD = LD.res.json.playerId;
  await depositAndWait(KC, pidC, LC.res.json.address, 0.1, 0.1);
  await depositAndWait(KD, pidD, LD.res.json.address, 0.1, 0.1);
  await sleep(6000);
  const feeS0 = (await admin('GET', '/admin/api/status')).json.solvency.surplusSol;
  const c = await wsOpen(pidC, 5), d = await wsOpen(pidD, 8);
  check('both fighters joined the real-money world', !!c.id && !!d.id, [c.msgs, d.msgs]);

  const lastOf = (st) => st.snaps[st.snaps.length - 1];
  const send = (st, angle) => st.ws.send(JSON.stringify({ t: 'input', angle, boosting: false }));
  let cDied = false;
  for (let t0 = Date.now(); Date.now() - t0 < 60000 && !cDied; ) {
    const sc = lastOf(c), sd = lastOf(d);
    const mc = sc && sc.snakes.find((s) => s.id === c.id), md = sd && sd.snakes.find((s) => s.id === d.id);
    cDied = c.msgs.some((m) => m.t === 'death');
    if (mc && md) { send(c, Math.atan2(md.y - mc.y, md.x - mc.x)); send(d, Math.atan2(mc.y - md.y, mc.x - md.x)); }
    await sleep(80);
  }
  check('the smaller snake died in the head-on fight', cDied);
  check('the loser was told, and forfeited the stake', cDied && near((await balanceOf(pidC)).sol, 0.05), await balanceOf(pidC));

  if (cDied) {
    for (let i = 0; i < 90; i++) { // the winner sweeps up the orbs the loser dropped
      const sd = lastOf(d), md = sd && sd.snakes.find((s) => s.id === d.id);
      const orbs = sd ? sd.orbs.filter((o) => o.v > 0) : [];
      if (md && orbs.length) {
        orbs.sort((p, q) => Math.hypot(p.x - md.x, p.y - md.y) - Math.hypot(q.x - md.x, q.y - md.y));
        send(d, Math.atan2(orbs[0].y - md.y, orbs[0].x - md.x));
      }
      await sleep(100);
    }
    const win = await wsCashout(d);
    check('the winner cashed out above the buy-in', win && win.amount > 8.0001, win);
    if (win && win.amount > 8.0001) {
      const wantFee = 0.05 * (win.amount - 8);
      check('house fee is exactly 5% of the profit', near(win.fee, wantFee, 1e-6) && near(win.net, win.amount - wantFee, 1e-6), { amount: win.amount, fee: win.fee, net: win.net, wantFee });
      check('winner\'s balance = what was left + net payout', near((await balanceOf(pidD)).credits, 2 + win.net, 1e-4), await balanceOf(pidD));
      const fa = (await admin('GET', '/admin/api/status')).json;
      check('admin counts the fee as house earnings', near(fa.earnings.feesCollectedSol * 100, win.fee, 1e-4), fa.earnings);
      check('fee shows up as extra surplus, solvency still covered', fa.solvency.ok && near(fa.solvency.surplusSol - feeS0, win.fee / 100, 1e-5), [fa.solvency.surplusSol, feeS0, win.fee]);
      const ledgerFee = fs.readFileSync(feeData + '.ledger.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'cashout');
      check('ledger records the fee on the cash-out', ledgerFee.length === 1 && near(ledgerFee[0].feeCredits, win.fee, 1e-6), ledgerFee);
      check('admin shows the fees as available to take, and where they would go', fa.earnings.ownerAddress === ownerKp.publicKey.toBase58() && near(fa.earnings.availableSol * 100, win.fee, 1e-4) && fa.earnings.maxNowSol <= fa.earnings.availableSol, fa.earnings);
      // The destination is never part of the request: whatever a caller says, only OWNER_ADDRESS is possible.
      const tooMuch = await admin('POST', '/admin/api/withdraw-earnings', { solAmount: fa.earnings.availableSol + 5, idempotencyKey: 'e2e-earn-toomuch1', to: 'AttackerAddress', playerAddress: 'AttackerAddress' });
      check('asking for more than the collected fees is refused', tooMuch.status === 400 && tooMuch.json.code === 'over_earnings', tooMuch);
      const ownerBalance = await conn.getBalance(ownerKp.publicKey);
      check('nothing was sent to anyone', ownerBalance === 0);
    }
  }
  c.ws.close(); d.ws.close();

  console.log('\n== on-demand deposit check (the page asks for it while the deposit window is open) ==');
  await stopServer();
  const odData = path.join(SP, 'e2e-wallet-data-ondemand.json');
  for (const f of [odData, odData + '.ledger.jsonl']) fs.rmSync(f, { force: true });
  await startServer(game, odData, { DEPOSIT_POLL_MS: '600000' }); // the background poller effectively never runs
  const KE = Keypair.generate();
  fake.airdrop(KE.publicKey.toBase58(), LAMPORTS_PER_SOL);
  const LE = await login(KE);
  const pidE = LE.res.json.playerId, HE = { 'X-Player-Id': pidE };
  await sleep(3500); // the one startup poll has come and gone
  await transfer(KE, LE.res.json.address, 0.03 * LAMPORTS_PER_SOL);
  await sleep(1500);
  check('without the on-demand check the deposit is not seen yet (poller idle)', near((await balanceOf(pidE)).sol, 0));
  const od = await http_('POST', '/api/check-deposit', {}, HE);
  check('check-deposit finds and credits the deposit at once', od.status === 200 && near(od.json.sol, 0.03), od);
  check('the deposit address was swept into the game wallet', (await conn.getBalance(new PublicKey(LE.res.json.address))) === 0);
  const od2 = await http_('POST', '/api/check-deposit', {}, HE);
  check('asking again does not credit it twice', near(od2.json.sol, 0.03), od2.json);
  check('check-deposit needs a valid player (401 without one)', (await http_('POST', '/api/check-deposit', {})).status === 401);
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await http_('POST', '/api/check-deposit', {}, HE)).status === 429) limited++;
  check('check-deposit is rate limited per player (20 a minute)', limited >= 1, limited);
  check('the credit is recorded in the ledger once', fs.readFileSync(odData + '.ledger.jsonl', 'utf8').split('\n').filter((l) => l.includes('"type":"deposit"')).length === 1);

  console.log('\n== network guard: the wallet only starts on a network it has verified and is allowed to use ==');
  await stopServer();
  const guardData = path.join(SP, 'e2e-wallet-data-guard.json');
  fs.rmSync(guardData, { force: true });
  const disabledOn = async (label, extra, wantNetwork) => {
    await startServer(game, guardData, extra);
    const c = (await http_('GET', '/api/config')).json;
    const ch = await http_('GET', '/api/login-challenge?publicKey=' + A.publicKey.toBase58());
    check(label, c.enabled === false && c.network === wantNetwork && ch.status === 503, [c, ch.status]);
    await stopServer();
  };
  await disabledOn('mainnet without ALLOW_MAINNET -> wallet refuses to start', { FAKE_GENESIS: 'mainnet' }, 'mainnet-beta');
  await disabledOn('mainnet with ALLOW_MAINNET but no dedicated master seed -> refuses', { FAKE_GENESIS: 'mainnet', ALLOW_MAINNET: '1', DEPOSIT_MASTER_SEED: '' }, 'mainnet-beta');
  await disabledOn('mainnet with ALLOW_MAINNET but no alert webhook -> refuses', { FAKE_GENESIS: 'mainnet', ALLOW_MAINNET: '1', ALERT_WEBHOOK_URL: '' }, 'mainnet-beta');
  await disabledOn('an unrecognised network -> refuses', { FAKE_GENESIS: 'unknown' }, 'unknown');
  alerts.length = 0;
  await startServer(game, guardData, { FAKE_GENESIS: 'mainnet', ALLOW_MAINNET: '1' });
  const cm = (await http_('GET', '/api/config')).json;
  check('mainnet with every requirement met -> starts, reports mainnet-beta', cm.enabled === true && cm.network === 'mainnet-beta', cm);
  check('config reports the internal credits-per-SOL scale', cm.creditsPerSol === 100, cm);
  const LM = await login(A);
  const capJoin = await wsOpen(LM.res.json.playerId, 25);
  const capMsg = errOf(capJoin) || '';
  check('on mainnet a limit message is in SOL, never a dollar figure', capMsg.includes('◎0.200') && !capMsg.includes('$'), capMsg);
  capJoin.ws.close();
  check('mainnet start sends a loud alert', await alertSeen('MAINNET'), alerts);
  const am = await admin('GET', '/admin/api/status', null, 'x'.repeat(10));
  check('(admin still locked on this instance without a token)', am.status === 404 || am.status === 401);
  await stopServer();

  hook.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch(async (e) => { console.error('E2E CRASH:', e); await stopServer(); hook.close(); process.exitCode = 3; });
