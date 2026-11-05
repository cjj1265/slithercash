// Run from the files/ folder:  npm run test:soak       (SEED=123 npm run test:soak repeats a run)
// A fast, network-free soak test: dozens of scripted players fight, boost, die and cash out for many game-minutes
// (in seconds of real time), and after every tick the world is checked for things that must never happen.
const path = require('path');
const { GameWorld, CFG } = require(path.join(__dirname, '..', 'gameServer.js'));

// a seeded random source, so a failing run can be repeated exactly
let seed = Number(process.env.SEED) || (Date.now() % 1000000);
Math.random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const START_SEED = seed;
const rnd = (a, b) => a + Math.random() * (b - a);

let failures = 0; const problems = [];
const fail = (what, detail) => { failures++; if (problems.length < 25) problems.push(what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); };

const DT = 1 / 30, MINUTES = Number(process.env.MINUTES) || 15, PLAYERS = Number(process.env.PLAYERS) || 40;
const TICKS = Math.round(MINUTES * 60 / DT);
const SP = CFG.POINT_SPACING;
const radiusFor = (s) => Math.min(34, Math.max(CFG.BASE_RADIUS, CFG.BASE_RADIUS + Math.sqrt(s.length) * 0.62));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const w = new GameWorld({ bots: 0, radius: 1500 }); // a small arena: lots of fights
let totalIn = 0, totalOut = 0, serial = 0;
const stats = { deaths: 0, cashouts: 0, kills: 0, wallDeaths: 0, headOns: 0, maxOrbs: 0, joins: 0 };

// every collision death is checked against the geometry at the moment it happens
const origKill = w._kill.bind(w);
w._kill = (snake, killerName, killerId) => {
  if (killerId !== undefined) {
    const k = w.snakes.get(killerId);
    if (!k) fail('a kill names a killer that is not in the world', killerName);
    else {
      const need = (radiusFor(snake) + radiusFor(k)) * CFG.HIT_SCALE;
      let best = dist(snake.head, k.head);
      for (let i = 2; i < k.points.length; i++) best = Math.min(best, dist(snake.head, k.points[i]));
      if (best > need + 1e-6) fail('a snake died without touching its killer', { by: killerName, nearest: +best.toFixed(2), needed: +need.toFixed(2) });
    }
  } else if (!killerName && Math.hypot(snake.head.x, snake.head.y) <= w.radius) {
    if (snake.forceKilled !== true) fail('a snake died at the wall while inside the arena', snake.head);
  }
  return origKill(snake, killerName, killerId);
};

// ---- the scripted players ----
const players = new Map(); // id -> { cashAt, nextTurn, boostUntil }
function join(delay) { pending.push({ at: tickNo + Math.round((delay || 0) / DT) }); }
const pending = [];
let tickNo = 0;
function spawnPlayer() {
  const id = 'p' + (++serial), buyin = Math.round(rnd(1, 120));
  const s = w.addPlayer({ id, name: id, buyin, skinIndex: serial % 9 });
  totalIn += s.buyin; stats.joins++;
  players.set(id, { cashAt: tickNo + Math.round(rnd(11, 40) / DT), nextTurn: 0, boostUntil: 0, mode: Math.random() < 0.5 ? 'hunter' : 'forager' });
}
for (let i = 0; i < PLAYERS; i++) spawnPlayer();

function steer(s, brain) {
  if (tickNo >= brain.nextTurn) {
    brain.nextTurn = tickNo + Math.round(rnd(0.3, 2) / DT);
    let target = null, bd = 450 * 450;
    if (brain.mode === 'hunter') {
      for (const o of w.snakes.values()) {
        if (o === s || o.length >= s.length) continue;
        const d = (o.head.x - s.head.x) ** 2 + (o.head.y - s.head.y) ** 2;
        if (d < bd) { bd = d; target = o.head; }
      }
    }
    if (!target) for (const o of w.orbs) { const d = (o.x - s.head.x) ** 2 + (o.y - s.head.y) ** 2; if (d < bd) { bd = d; target = o; } }
    const away = Math.hypot(s.head.x, s.head.y) > w.radius - 300;
    s.targetAngle = away ? Math.atan2(-s.head.y, -s.head.x) : target ? Math.atan2(target.y - s.head.y, target.x - s.head.x) : rnd(-Math.PI, Math.PI);
  }
  if (tickNo >= brain.boostUntil && Math.random() < 0.01) brain.boostUntil = tickNo + Math.round(rnd(0.5, 3) / DT);
  s.boosting = tickNo < brain.boostUntil;
}

// ---- the checks that run on every tick ----
function cheapChecks() {
  const seen = new Set();
  for (const s of w.snakes.values()) {
    if (seen.has(s.id)) fail('duplicate snake id', s.id); seen.add(s.id);
    if (!Number.isFinite(s.head.x) || !Number.isFinite(s.head.y) || !Number.isFinite(s.angle) || !Number.isFinite(s.length)) { fail('a snake has a non-finite value', { id: s.id, head: s.head, len: s.length }); continue; }
    if (s.length < CFG.MIN_LEN - 1e-9) fail('a snake is shorter than the minimum', s.length);
    if (Math.hypot(s.head.x, s.head.y) > w.radius + 60) fail('a snake is far outside the arena and still alive', s.head);
    if (s.points.length > Math.ceil(s.length / SP) + 2) fail('a snake has more body points than its length allows', { points: s.points.length, length: s.length });
    // the body can never be longer than the length (an invisible tail); it may be shorter only right after growing
    let len = dist(s.head, s.points[0]);
    for (let i = 1; i < s.points.length; i++) len += dist(s.points[i - 1], s.points[i]);
    if (len > s.length + SP * 3) fail('a snake body is longer than its length (invisible tail)', { body: +len.toFixed(1), length: +s.length.toFixed(1) });
  }
  if (w.orbs.length > stats.maxOrbs) stats.maxOrbs = w.orbs.length;
  if (w.orbs.length > CFG.ORB_CAP + 5) fail('more orbs than the limit', w.orbs.length);
  for (const o of w.orbs) if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !(o.value > 0)) { fail('a bad orb', o); break; }
}
// money: everything paid in is either still in the world or was paid out
function moneyCheck() {
  const inPlay = w.totalValue();
  if (Math.abs(inPlay + totalOut - totalIn) > 1e-3) fail('money is not conserved', { inPlay: +inPlay.toFixed(4), out: +totalOut.toFixed(4), in: +totalIn.toFixed(4), diff: +(inPlay + totalOut - totalIn).toFixed(6) });
}
// nobody may be sitting inside a body they should have died on (a missed collision)
function missedCollisionCheck() {
  for (const a of w.snakes.values()) {
    if (w._isProtected(a)) continue;
    const ra = radiusFor(a);
    for (const b of w.snakes.values()) {
      if (a === b || w._isProtected(b)) continue;
      const need = (ra + radiusFor(b)) * CFG.HIT_SCALE - 1.5; // a little slack for the move made since the check
      for (let i = 2; i < b.points.length; i++) {
        if (dist(a.head, b.points[i]) < need) { fail('a head is inside another snake\'s body and did not die', { a: a.id, b: b.id, d: +dist(a.head, b.points[i]).toFixed(2), need: +need.toFixed(2) }); return; }
      }
    }
  }
}

const tickMs = [];
const started = Date.now();
for (tickNo = 1; tickNo <= TICKS; tickNo++) {
  for (const [id, brain] of players) {
    const s = w.snakes.get(id); if (!s) continue;
    steer(s, brain);
    if (tickNo >= brain.cashAt && tickNo % 30 === 0) w.startCashout(id); // hold it, refreshed every second
  }
  while (pending.length && pending[0].at <= tickNo) { pending.shift(); spawnPlayer(); }

  const t0 = process.hrtime.bigint();
  w.tick(DT);
  tickMs.push(Number(process.hrtime.bigint() - t0) / 1e6);

  const diedNow = new Set(w.events.filter((e) => e.type === 'death' || e.type === 'cashout_result').map((e) => e.targetId)); // a killer may die the same tick
  for (const e of w.events) {
    if (e.type === 'cashout_result') { stats.cashouts++; totalOut += e.data.amount; players.delete(e.targetId); join(rnd(0.5, 3)); if (w.snakes.has(e.targetId)) fail('a cashed-out snake is still in the world', e.targetId); }
    else if (e.type === 'death') { stats.deaths++; players.delete(e.targetId); join(rnd(0.5, 3)); if (w.snakes.has(e.targetId)) fail('a dead snake is still in the world', e.targetId); if (!e.data.killerName) stats.wallDeaths++; }
    else if (e.type === 'kill') { stats.kills++; if (!w.snakes.has(e.targetId) && !diedNow.has(e.targetId)) fail('a kill message for a snake that is gone (and did not die this tick)', e.targetId); }
    else fail('an unknown event type', e.type);
  }
  w.events.length = 0;

  cheapChecks();
  if (tickNo % 30 === 0) moneyCheck();
  if (tickNo % 10 === 0) missedCollisionCheck();
}

tickMs.sort((a, b) => a - b);
const pct = (p) => tickMs[Math.min(tickMs.length - 1, Math.floor(tickMs.length * p))];
console.log('soak: ' + MINUTES + ' game-minutes, ' + PLAYERS + ' players, seed ' + START_SEED + ', ' + ((Date.now() - started) / 1000).toFixed(1) + ' s of real time');
console.log('  joins ' + stats.joins + ', cash-outs ' + stats.cashouts + ', deaths ' + stats.deaths + ' (wall ' + stats.wallDeaths + '), kills ' + stats.kills + ', most orbs at once ' + stats.maxOrbs);
console.log('  tick time ms: p50 ' + pct(0.5).toFixed(2) + ', p95 ' + pct(0.95).toFixed(2) + ', p99 ' + pct(0.99).toFixed(2) + ', max ' + tickMs[tickMs.length - 1].toFixed(2) + ' (budget ' + (DT * 1000).toFixed(1) + ')');
if (pct(0.99) > 20) fail('the server is too slow at the 99th percentile', pct(0.99));
if (stats.kills === 0 || stats.cashouts === 0) fail('the test did not exercise kills and cash-outs', stats);
if (failures) { console.log('\n' + failures + ' problem' + (failures === 1 ? '' : 's') + ':'); problems.forEach((p) => console.log('  FAIL  ' + p)); console.log('\nrepeat with:  SEED=' + START_SEED + ' npm run test:soak'); process.exit(1); }
console.log('\nno problems found');
