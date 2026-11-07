// Run from the files/ folder:  npm run test:demo
// Checks the local demo mode: the world options (bots, food, arena), the controls, and that it can never run with a wallet,
// on a host, or be reached from another computer.
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const { GameWorld } = require(path.join(__dirname, '..', 'gameServer.js'));

let passed = 0, failed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log('  PASS  ' + name); } else { failed++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILES = path.join(__dirname, '..');

function request(port, method, p, body, host) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: host || '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, timeout: 4000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message })); req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (data) req.write(data); req.end();
  });
}
const baseEnv = () => { const e = Object.assign({}, process.env); for (const k of ['GAME_WALLET_SECRET', 'DEPOSIT_MASTER_SEED', 'ORIGIN_SECRET', 'ADMIN_TOKEN', 'RENDER', 'ALLOW_MAINNET', 'WINS_WEBHOOK_URL', 'DEMO_MODE', 'NUM_BOTS']) delete e[k]; return e; };
function start(port, extra) {
  const child = spawn(process.execPath, ['index.js'], { cwd: FILES, env: Object.assign(baseEnv(), { PORT: String(port) }, extra || {}) });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))) };
}
async function ready(port) { for (let i = 0; i < 60; i++) { const r = await request(port, 'GET', '/health'); if (r.status === 200) return true; await sleep(150); } return false; }

(async () => {
  console.log('== the world options ==');
  const w = new GameWorld({ bots: 12, radius: 1500, ambientOrbs: 120, botScale: 3 });
  check('the world starts with the bots it was asked for', w._bots().length === 12);
  for (let i = 0; i < 40; i++) w.tick(1 / 30);
  check('ambient food is kept topped up', w.orbs.length >= 110, w.orbs.length);
  check('food and snakes stay inside the smaller arena', w.orbs.every((o) => Math.hypot(o.x, o.y) <= 1500) && w._bots().every((b) => Math.hypot(b.head.x, b.head.y) <= 1500));
  const avgLen = (g) => { const b = g._bots(); return b.reduce((a, s) => a + s.length, 0) / Math.max(1, b.length); };
  const bigAvg = (() => { let t = 0; for (let i = 0; i < 20; i++) t += avgLen(new GameWorld({ bots: 30, botScale: 5 })); return t / 20; })();
  const smallAvg = (() => { let t = 0; for (let i = 0; i < 20; i++) t += avgLen(new GameWorld({ bots: 30, botScale: 1 })); return t / 20; })();
  check('a bigger bot size makes bigger snakes', bigAvg > smallAvg * 1.8, [bigAvg, smallAvg]);
  w.setBots(4, 3);
  check('setBots replaces the bots with the new count', w._bots().length === 4 && w.botCount === 4);
  const victim = w._bots()[0]; w._kill(victim, 'test'); await sleep(4200);
  check('a dead bot is replaced only up to the set count', w._bots().length === 4, w._bots().length);
  { const r = new GameWorld({ bots: 3, radius: 1500, ambientOrbs: 100, botScale: 2 }); r.addPlayer({ id: 'p', name: 'p', buyin: 5, skinIndex: 0 }); r.tick(1 / 30); r.resetAll({ bots: 5, radius: 1800, botScale: 3 });
    check('resetAll clears the player and every orb, and starts the new bots', !r.snakes.has('p') && r.orbs.length === 0 && r._bots().length === 5 && r.radius === 1800 && r.botScale === 3); }
  w.setBots(0); await sleep(100);
  check('zero bots means none', w._bots().length === 0);
  const w2 = new GameWorld({ bots: 0, radius: 1500 });
  w2.addPlayer({ id: 'p', name: 'p', buyin: 5, skinIndex: 0 });
  w2.setRadius(2500); w2.tick(1 / 30);
  check('a new arena size waits while someone is playing', w2.radius === 1500 && w2.pendingRadius === 2500);
  w2.removePlayer('p'); w2.tick(1 / 30);
  check('and applies once the arena is empty', w2.radius === 2500 && w2.pendingRadius === 0);

  console.log('\n== the demo server ==');
  const d = start(8931, { DEMO_MODE: '1' });
  check('demo mode starts', await ready(8931), d.out());
  const cfg = await request(8931, 'GET', '/api/config');
  check('the page is told it is a demo', cfg.json && cfg.json.demo === true && cfg.json.enabled === false, cfg);
  const st = await request(8931, 'GET', '/api/demo');
  check('it starts with 40 bots by default', st.status === 200 && st.json.bots === 40 && st.json.botScale === 3, st);
  const hb = (await request(8931, 'GET', '/health')).json.bots;
  check('/health shows the bots (a few may already have died fighting)', hb >= 30 && hb <= 40, hb);
  const set = await request(8931, 'POST', '/api/demo', { bots: 7, botScale: 5, radius: 3000 });
  check('the controls change the bots', set.status === 200 && set.json.bots === 7 && set.json.botScale === 5 && set.json.radius === 3000, set);
  const hb2 = (await request(8931, 'GET', '/health')).json.bots;
  check('and /health follows', hb2 >= 3 && hb2 <= 7, hb2);
  const clampd = await request(8931, 'POST', '/api/demo', { bots: 9999, botScale: 99, radius: 5 });
  check('absurd values are clamped', clampd.json.bots === 80 && clampd.json.botScale === 6 && clampd.json.radius === 1200, clampd);
  const rst = await request(8931, 'POST', '/api/demo', { reset: true });
  check('reset puts the bots, size and arena back to the defaults', rst.status === 200 && rst.json.reset === true && rst.json.bots === 40 && rst.json.botScale === 3 && rst.json.radius === 1800, rst);
  // anyone can use any skin: join with the last (legendary) skin and no wallet
  const skin = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:8931'); let id = null; const t = setTimeout(() => resolve(null), 6000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: 'demo', buyin: 5, skinIndex: 8 }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === 'welcome') id = m.id; if (m.t === 'body' && id && m.id === id) { clearTimeout(t); ws.close(); resolve(m.skinIndex); } };
  });
  check('any skin can be used in the demo (no wallet needed)', skin === 8, skin);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) check('it only answers on this computer, not on the network', (await request(8931, 'GET', '/health', null, lan.address)).error !== undefined);
  d.child.kill();

  console.log('\n== it refuses to run where it should not ==');
  const onHost = start(8932, { DEMO_MODE: '1', RENDER: 'true' });
  check('refuses on a host (RENDER is set)', (await Promise.race([onHost.exited, sleep(5000).then(() => 'still running')])) === 1, onHost.out());
  onHost.child.kill();
  const withWallet = start(8933, { DEMO_MODE: '1', GAME_WALLET_SECRET: '[1,2,3]' });
  check('refuses when a wallet is configured', (await Promise.race([withWallet.exited, sleep(5000).then(() => 'still running')])) === 1, withWallet.out());
  withWallet.child.kill();

  console.log('\n== the normal server has none of it ==');
  const n = start(8934, {});
  check('normal server starts', await ready(8934), n.out());
  check('it does not say demo', (await request(8934, 'GET', '/api/config')).json.demo === false);
  check('the demo controls do not exist', (await request(8934, 'GET', '/api/demo')).status === 404 && (await request(8934, 'POST', '/api/demo', { bots: 5 })).status === 404);
  n.child.kill();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
