// Run from the files/ folder:  npm run test:netsoak      (SECONDS=60 PLAYERS=30 to change)
// A real-network soak: starts the demo server on a spare port and connects dozens of fake players over real
// WebSockets. They steer, boost, die, cash out, rejoin and now and then send rubbish. It checks that the
// server never crashes or prints errors, snapshots keep arriving at a steady rate, and nobody is stuck.
const path = require('path');
const { spawn } = require('child_process');

const SECONDS = Number(process.env.SECONDS) || 60, PLAYERS = Number(process.env.PLAYERS) || 30;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const problems = [];
const fail = (m) => { if (problems.length < 25) problems.push(m); };

const server = spawn(process.execPath, [path.join(__dirname, '..', 'demo.js')], { env: { ...process.env, PORT: String(PORT), WS_MAX_PER_IP: '500' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '', serverErr = '', exited = false;
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverErr += d; });
server.on('exit', (c) => { exited = true; if (!done) fail('the server exited early (code ' + c + ')'); });

const stats = { joins: 0, deaths: 0, cashouts: 0, kills: 0, snapshots: 0, errors: 0, closed: 0, maxGapMs: 0, bytes: 0 };
let done = false;
const rnd = (a, b) => a + Math.random() * (b - a);
const bots = [];

function makeBot(i) {
  const bot = { i, ws: null, alive: false, lastSnap: 0, snaps: 0, gaps: 0, you: null, joinedAt: 0, rtt: [], pingAt: 0 };
  const open = () => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/');
    bot.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'join', name: 'bot' + i, buyin: Math.round(rnd(5, 200)), skinIndex: i % 9 })); stats.joins++; bot.pingAt = Date.now(); ws.send(JSON.stringify({ t: 'ping', ts: bot.pingAt })); };
    ws.onmessage = (ev) => {
      stats.bytes += String(ev.data).length;
      let m; try { m = JSON.parse(ev.data); } catch (e) { fail('the server sent something that is not JSON'); return; }
      const now = Date.now();
      switch (m.t) {
        case 'welcome': bot.alive = true; bot.joinedAt = now; bot.lastSnap = 0; bot.cashing = 0; break;
        case 'snapshot': {
          stats.snapshots++; bot.snaps++;
          if (bot.lastSnap && bot.alive) { const gap = now - bot.lastSnap; if (gap > stats.maxGapMs) stats.maxGapMs = gap; if (gap > 500) bot.gaps++; }
          bot.lastSnap = now;
          if (!Array.isArray(m.s) || m.s.some((r) => !Array.isArray(r) || r.length < 6)) fail('a snapshot has no snakes or a malformed row'); if (m.o !== undefined && (!Array.isArray(m.o) || m.o.length % 3 !== 0)) fail('a snapshot has a malformed orb list');
          break;
        }
        case 'death': stats.deaths++; bot.alive = false; setTimeout(() => ws.readyState === 1 && ws.close(), 50); break;
        case 'cashout_result': stats.cashouts++; bot.alive = false; setTimeout(() => ws.readyState === 1 && ws.close(), 50); break;
        case 'kill': stats.kills++; break;
        case 'pong': bot.rtt.push(Date.now() - m.ts); break;
        case 'error': stats.errors++; break;
      }
    };
    ws.onclose = () => { stats.closed++; bot.alive = false; if (!done) setTimeout(open, rnd(200, 1500)); };
    ws.onerror = () => {};
  };
  open();
  bot.timer = setInterval(() => {
    const ws = bot.ws; if (!ws || ws.readyState !== 1) return;
    if (bot.alive) {
      ws.send(JSON.stringify({ t: 'input', angle: Math.sin(Date.now() / 1000 + bot.i) * 3, boosting: Math.random() < 0.2 }));
      if (Date.now() - bot.joinedAt > 11000 && Math.random() < 0.05) bot.cashing = Date.now() + 6500;
      if (bot.cashing && Date.now() < bot.cashing) ws.send(JSON.stringify({ t: 'cashout' }));
    }
    const r = Math.random();
    if (r < 0.01) ws.send('this is not json');
    else if (r < 0.02) ws.send(JSON.stringify({ t: 'input', angle: 'x', boosting: {} }));
    else if (r < 0.03) ws.send(JSON.stringify({ t: 'join', name: 'again', buyin: 1e9 }));
    else if (r < 0.035) ws.send(JSON.stringify({ t: 'nonsense', a: [1, 2, 3] }));
    else if (r < 0.04) ws.send(JSON.stringify({ t: 'input', angle: NaN, boosting: true }));
    else if (r < 0.05) { bot.pingAt = Date.now(); ws.send(JSON.stringify({ t: 'ping', ts: bot.pingAt })); }
  }, 50);
  return bot;
}

async function main() {
  for (let i = 0; i < 100 && !/listen|running|http/i.test(serverOut) && !exited; i++) await new Promise((r) => setTimeout(r, 100));
  if (exited) { console.log(serverOut + serverErr); process.exit(1); }
  // normal-sized bots (the demo default is huge bots that grow to tens of thousands of units, which is not what a real game looks like)
  await fetch('http://127.0.0.1:' + PORT + '/api/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bots: 40, botScale: 1 }) });
  for (let i = 0; i < PLAYERS; i++) bots.push(makeBot(i));
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  done = true;
  bots.forEach((b) => { clearInterval(b.timer); try { b.ws.close(); } catch (e) {} });
  await new Promise((r) => setTimeout(r, 500));
  // the server must still answer after all of that
  let alive = false;
  try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/online'); alive = r.ok; } catch (e) {}
  if (!alive) fail('the server does not answer after the soak');
  server.kill();

  const rtts = bots.flatMap((b) => b.rtt).sort((a, b) => a - b);
  const rate = stats.snapshots / PLAYERS / SECONDS;
  console.log('netsoak: ' + SECONDS + ' s, ' + PLAYERS + ' fake players, port ' + PORT);
  console.log('  joins ' + stats.joins + ', deaths ' + stats.deaths + ', cash-outs ' + stats.cashouts + ', kills ' + stats.kills + ', join errors ' + stats.errors + ', closed ' + stats.closed);
  console.log('  snapshots per player per second: ' + rate.toFixed(1) + ', longest gap ' + stats.maxGapMs + ' ms, ' + (stats.bytes / SECONDS / PLAYERS / 1024).toFixed(1) + ' KB/s per player');
  if (rtts.length) console.log('  ping round trip ms: p50 ' + rtts[Math.floor(rtts.length * 0.5)] + ', p99 ' + rtts[Math.floor(rtts.length * 0.99)] + ', max ' + rtts[rtts.length - 1]);
  if (rate < 5) fail('snapshots are arriving too rarely (' + rate.toFixed(1) + ' per second)');
  if (stats.maxGapMs > 1500) fail('a player went ' + stats.maxGapMs + ' ms without a snapshot');
  if (stats.deaths === 0) fail('nobody died, so the death flow was not exercised');
  if (stats.cashouts === 0) fail('nobody cashed out, so the cash-out flow was not exercised');
  if (/error|exception|unhandled|TypeError|RangeError/i.test(serverErr)) fail('the server printed errors:\n' + serverErr.split('\n').slice(0, 8).join('\n'));
  if (/TypeError|RangeError|Unhandled/i.test(serverOut)) fail('the server logged errors:\n' + serverOut.split('\n').filter((l) => /Error|Unhandled/.test(l)).slice(0, 8).join('\n'));
  if (problems.length) { console.log('\n' + problems.length + ' problem(s):'); problems.forEach((p) => console.log('  FAIL  ' + p)); process.exit(1); }
  console.log('\nno problems found');
  process.exit(0);
}
main();
