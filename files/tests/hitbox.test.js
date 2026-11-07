// Run from the files/ folder:  npm run test:hitbox
// Checks the body and hit boxes: a snake's body is exactly as long as its length says (so there is no invisible tail),
// boost orbs fall at the real tail, a head-on kills exactly one snake, and orbs never vanish.
const path = require('path');
const { GameWorld, CFG } = require(path.join(__dirname, '..', 'gameServer.js'));

let passed = 0, failed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log('  PASS  ' + name); } else { failed++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); } };
const DT = 1 / 30;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const newWorld = () => new GameWorld({ bots: 0 });
function spawn(w, id, buyin, x, y, angle) {
  const s = w.addPlayer({ id, name: id, buyin, skinIndex: 0 });
  s.protectedUntil = 0; s.head.x = x; s.head.y = y; s.points = [{ x, y }]; s.angle = angle; s.targetAngle = angle; s.distSincePoint = 0;
  return s;
}
const pathLength = (s) => { let d = dist(s.head, s.points[0]); for (let i = 1; i < s.points.length; i++) d += dist(s.points[i - 1], s.points[i]); return d; };

console.log('== the body is as long as the length says ==');
{
  const w = newWorld();
  const s = spawn(w, 'a', 50, 0, 0, 0);            // buy-in 50 -> length 400, 100 body points
  for (let i = 0; i < 200; i++) w.tick(DT);          // runs straight at normal speed
  let even = true; for (let i = 1; i < s.points.length; i++) if (Math.abs(dist(s.points[i - 1], s.points[i]) - CFG.POINT_SPACING) > 0.01) even = false;
  check('body points are exactly POINT_SPACING apart at normal speed', even);
  check('the body is as long as the snake\'s length (within one spacing)', Math.abs(pathLength(s) - s.length) <= CFG.POINT_SPACING * 2, [pathLength(s), s.length]);
  let worst = 0, drops = 0;
  for (let i = 0; i < 60; i++) {
    s.boosting = true; const before = w.orbs.length; w.tick(DT);
    if (w.orbs.length > before) { drops++; const o = w.orbs[w.orbs.length - 1], tail = s.points[s.points.length - 1]; worst = Math.max(worst, dist(o, tail)); }
  }
  check('boost orbs fall at the real tail, not far behind it', drops > 5 && worst <= 14, { drops, worst });
  even = true; for (let i = 1; i < s.points.length; i++) if (Math.abs(dist(s.points[i - 1], s.points[i]) - CFG.POINT_SPACING) > 0.01) even = false;
  check('and still exactly spaced after boosting (it used to stretch to 9+ units)', even);
  check('the body is still as long as the length says after boosting', Math.abs(pathLength(s) - s.length) <= CFG.POINT_SPACING * 2, [pathLength(s), s.length]);
  check('the body is still as long as the length says after boosting', Math.abs(pathLength(s) - s.length) <= CFG.POINT_SPACING * 2, [pathLength(s), s.length]);
}

console.log('\n== no invisible tail: you only die where the body really is ==');
{
  // A long straight snake moves right; a small snake crosses its line at a right angle, 60 units behind the tail tip
  // (clear of the body; the old stretched body used to reach back there) or 30 units inside the body.
  const trial = (inside) => {
    const w = newWorld();
    const a = spawn(w, 'a', 50, 0, 0, 0);
    for (let i = 0; i < 160; i++) w.tick(DT);
    const tail = a.points[a.points.length - 1];
    const ticksToCross = 12, tailMoves = CFG.NORMAL_SPEED * DT * ticksToCross;
    const x = tail.x + tailMoves + (inside ? 30 : -60);
    const b = spawn(w, 'b', 1, x, tail.y + CFG.NORMAL_SPEED * DT * ticksToCross, -Math.PI / 2);
    b.targetAngle = -Math.PI / 2;
    let died = false;
    for (let i = 0; i < 30 && !died; i++) { w.tick(DT); if (!w.snakes.has('b')) died = true; }
    return died;
  };
  check('a snake crossing 60 units behind the tail tip survives (it used to die on the invisible part)', trial(false) === false);
  check('a snake crossing through the real body still dies', trial(true) === true);
}
console.log('\n== the head stops on the edge it hits ==');
{
  let worst = 0, n = 0, deepest = 0;
  for (let k = 0; k < 40; k++) {
    const w = newWorld();
    const a = spawn(w, 'a', 50, 0, 0, 0);
    for (let i = 0; i < 160; i++) w.tick(DT);
    const mid = a.points[Math.floor(a.points.length / 2)];
    const b = spawn(w, 'b', 20, mid.x + (k % 5) * 3, mid.y - 140, Math.PI / 2);
    b.targetAngle = Math.PI / 2; b.boosting = k % 2 === 0;
    let hit = null; const ok = w._kill.bind(w);
    w._kill = (sn, kn, kid) => { if (sn.id === 'b') hit = { x: sn.head.x, y: sn.head.y, rb: Math.min(34, CFG.BASE_RADIUS + Math.sqrt(sn.length) * 0.62) }; return ok(sn, kn, kid); };
    for (let i = 0; i < 90 && !hit; i++) w.tick(DT);
    if (!hit) continue;
    const ra = Math.min(34, CFG.BASE_RADIUS + Math.sqrt(a.length) * 0.62);
    let best = 1e9; for (let i = 2; i < a.points.length; i++) best = Math.min(best, dist(hit, a.points[i]));
    n++; worst = Math.max(worst, Math.abs(best - (ra + hit.rb) * CFG.HIT_SCALE)); deepest = Math.max(deepest, (ra + hit.rb) - best);
  }
  check('the snake that hit is stopped exactly on the other snake\'s edge (within 0.5 unit)', n >= 30 && worst < 0.5, { n, worst: +worst.toFixed(3) });
}

console.log('\n== a head-on kills exactly one snake ==');
{
  let both = 0, none = 0, oneA = 0, oneB = 0;
  for (let n = 0; n < 300; n++) {
    const w = newWorld();
    const same = n % 2 === 0;                                        // half the trials are same-size snakes (the coin flip)
    spawn(w, 'a', 20, -60, 0, 0); spawn(w, 'b', same ? 20 : 12, 60, 0, Math.PI);
    for (let i = 0; i < 40; i++) w.tick(DT);
    const a = w.snakes.has('a'), b = w.snakes.has('b');
    if (!a && !b) both++; else if (a && b) none++; else if (a) oneA++; else oneB++;
  }
  check('never both dead, never neither', both === 0 && none === 0, { both, none, oneA, oneB });
  check('both sides can win a tie (it is not always the same player)', oneA > 20 && oneB > 20, { oneA, oneB });
}

console.log('\n== orbs never vanish ==');
{
  const w = newWorld();
  const total = () => w.orbs.reduce((a, o) => a + o.value, 0);
  let put = 0;
  for (let i = 0; i < CFG.ORB_CAP + 2500; i++) { w._dropOrb({ x: (i % 90) * 10, y: Math.floor(i / 90) * 10, value: 1 }); put += 1; }
  w._enforceOrbCap(); // done once at the end of every tick
  check('past the limit the oldest orbs are merged into others', w.orbs.length <= CFG.ORB_CAP, w.orbs.length);
  check('and the value is exactly what was put in', Math.abs(total() - put) < 1e-6, [total(), put]);
  const v = newWorld();
  const big = spawn(v, 'big', 200, 0, 0, 0);
  for (let i = 0; i < 100; i++) v.tick(DT);
  v._kill(big, 'x');
  const dropped = v.orbs.length, val = v.orbs.reduce((a, o) => a + o.value, 0);
  for (let i = 0; i < 900; i++) v.tick(DT);                          // 30 seconds later
  check('a dead snake\'s orbs are still there 30 seconds later', v.orbs.length === dropped && Math.abs(v.orbs.reduce((a, o) => a + o.value, 0) - val) < 1e-6, [v.orbs.length, dropped]);
}

console.log('\n== orbs are found by square ==');
{
  const w = newWorld();
  const s = spawn(w, 'a', 5, 0, 0, 0);
  w.orbs.push({ x: 0, y: 0, value: 1 }, { x: 300, y: 300, value: 1 }, { x: -2500, y: 40, value: 1 });
  w._buildOrbGrid();
  check('orbsNear returns the orbs inside the radius and not the ones outside', w.orbsNear(0, 0, 450).length === 2 && w.orbsNear(0, 0, 100).length === 1 && w.orbsNear(-2500, 40, 50).length === 1);
  const before = s.length; w.tick(DT);
  check('an orb at the head is eaten, one far away is not', s.length > before && w.orbs.some((o) => o.x === 300));
}

console.log('\n== new snakes start away from everyone ==');
{
  const w = new GameWorld({ bots: 30, radius: 3700, botScale: 1 });
  for (let i = 0; i < 90; i++) w.tick(DT);
  let closest = 1e9;
  for (let k = 0; k < 25; k++) {
    const s = w.addPlayer({ id: 'n' + k, name: 'n' + k, buyin: 5, skinIndex: 0 });
    for (const o of w.snakes.values()) { if (o === s) continue; closest = Math.min(closest, dist(s.head, o.head)); for (let i = 0; i < o.points.length; i += 3) closest = Math.min(closest, dist(s.head, o.points[i])); }
    w.tick(DT);
  }
  check('25 new players each started at least 500 units from every other snake (30 bots on a full map)', closest >= 500, Math.round(closest));
}

console.log('\n== the cash-out ring and the short update rows ==');
{
  const w = newWorld();
  const a = spawn(w, 'a', 20, 0, 0, 0); a.bornAt = w.elapsed - 30;
  spawn(w, 'b', 5, 500, 500, 0);
  for (let i = 0; i < 30; i++) { w.startCashout('a'); w.tick(DT); }          // holds for one second of the 5 it takes
  const row = w.snapshotRows().find((r) => r[0] === 'a');
  check('a snake that is holding to cash out reports how far along it is (about 20% after 1 of 5 seconds)', row && row.length === 7 && row[6] >= 15 && row[6] <= 25, row);
  check('a snake that is not holding has no ring value', w.snapshotRows().find((r) => r[0] === 'b').length === 6);
  w.cancelCashout('a');
  check('letting go removes it', w.snapshotRows().find((r) => r[0] === 'a').length === 6);
  const full = JSON.stringify(w.snapshotSnakes()).length, short = JSON.stringify(w.snapshotRows()).length;
  check('the short rows are less than half the size of the old objects', short < full * 0.5, [short, full]);
  const flat = w.orbsNearFlat(0, 0, 4000);
  w._dropOrb({ x: 10, y: 20, value: 0.5 }); w._buildOrbGrid();
  const f2 = w.orbsNearFlat(0, 0, 100);
  check('orbs go out as a flat [x, y, value] list', f2.length % 3 === 0 && f2.includes(10) && f2.includes(20) && f2.includes(0.5) && Array.isArray(flat), f2);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
