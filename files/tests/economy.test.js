// Run from the files/ folder:  npm run test:economy
// Checks that no in-game action creates money: value = snake length + orb value * GROW_PER_ORB.
const path = require('path');
const { GameWorld, CFG } = require(process.argv[2] || path.join(__dirname, '..', 'gameServer.js'));
const LEN_PER_DOLLAR = CFG.LEN_PER_DOLLAR;

// 1) boosting must conserve value (burned length comes back as orbs, nothing more)
{
  const w = new GameWorld();
  const s = w.addPlayer({ id: 'p', name: 'p', buyin: 50, skinIndex: 0 });
  s.boosting = true;
  const total = () => s.length + w.orbs.reduce((a, o) => a + o.value * CFG.GROW_PER_ORB, 0);
  const before = total();
  for (let i = 0; i < 200; i++) w.tick(1 / 30);
  const after = total();
  console.log('boost: value before ' + (before / LEN_PER_DOLLAR).toFixed(3) + '$  after ' + (after / LEN_PER_DOLLAR).toFixed(3) + '$  ->',
    after > before + 1e-6 ? 'CREATES MONEY (+' + ((after - before) / LEN_PER_DOLLAR).toFixed(3) + '$)' : 'ok');
}

// 2) join then immediately cash out must return exactly the buy-in, for every legal buy-in
// (Only legal buy-ins: index.js clamps to [MIN_BUYIN, MAX_BUYIN] before a player ever reaches the world.)
for (const buyin of [CFG.MIN_BUYIN, 2.5, 5, 123.45]) {
  const w = new GameWorld();
  w.addPlayer({ id: 'p', name: 'p', buyin, skinIndex: 0 });
  w.requestCashout('p');
  const out = w.events[0].data.amount;
  console.log('cash-out of buy-in $' + buyin + ' -> $' + out.toFixed(3) + '  ',
    out > buyin + 1e-9 ? 'CREATES MONEY (+$' + (out - buyin).toFixed(3) + ')' : 'ok');
}
// 2a) hold-to-cash-out: takes the full hold, can be cancelled, lapses without refreshes, and never pays a snake that died
{
  const run = (w, seconds, each) => { for (let i = 0; i < Math.round(seconds * 30); i++) { if (each) each(i); w.tick(1 / 30); } };
  // keeps the hold going, and steers toward the middle so a long run never ends at the wall
  const refresh = (w) => (i) => {
    if (i % 30 === 0) w.startCashout('p');
    const s = w.snakes.get('p'); if (s) w.setInput('p', Math.atan2(-s.head.y, -s.head.x), false);
  };
  const paid = (w) => w.events.some((e) => e.type === 'cashout_result');
  const fresh = () => { const w = new GameWorld({ bots: 0 }); w.addPlayer({ id: 'p', name: 'p', buyin: 5, skinIndex: 0 }); return w; };
  const results = [];
  const savedMinPlay = CFG.MIN_PLAY_SEC;
  CFG.MIN_PLAY_SEC = 0; // the minimum play time has its own test below

  let w = fresh(); run(w, CFG.CASHOUT_HOLD_SEC - 0.5, refresh(w)); results.push(['not paid before the hold is over', !paid(w) && w.snakes.has('p')]);
  run(w, 1, refresh(w)); results.push(['paid once the hold is over, for the whole stake', paid(w) && Math.abs(w.events[0].data.amount - 5) < 1e-9]);
  w = fresh(); run(w, CFG.CASHOUT_HOLD_SEC - 1, refresh(w)); w.cancelCashout('p'); run(w, CFG.CASHOUT_HOLD_SEC, null); results.push(['letting go cancels it', !paid(w)]);
  w = fresh(); w.startCashout('p'); run(w, CFG.CASHOUT_HOLD_SEC + 2, null); results.push(['a hold nobody refreshes lapses', !paid(w)]);
  w = fresh(); run(w, 2, refresh(w)); w._kill(w.snakes.get('p'), 'x'); run(w, CFG.CASHOUT_HOLD_SEC, refresh(w)); results.push(['a snake killed mid-hold is not paid', !paid(w)]);
  CFG.MIN_PLAY_SEC = savedMinPlay;

  // minimum play time: a hold started too early is ignored; once the snake has played long enough it is accepted
  w = fresh(); run(w, CFG.MIN_PLAY_SEC - 1, refresh(w)); results.push(['a cash-out hold before the minimum play time is ignored', w.snakes.get('p').cashoutHold == null && !paid(w)]);
  run(w, 3, refresh(w)); results.push(['after the minimum play time a hold is accepted', w.snakes.get('p').cashoutHold != null]);
  run(w, CFG.CASHOUT_HOLD_SEC + 1, refresh(w)); results.push(['and it pays out once held long enough', paid(w)]);

  // spawn protection: a new snake can neither be killed nor kill, boosting gives it up, and it ends on time
  const spot = (protectMe) => {
    const g = new GameWorld({ bots: 0 });
    const big = g.addPlayer({ id: 'big', name: 'big', buyin: 25, skinIndex: 0 });
    big.protectedUntil = 0;
    for (let i = 0; i < 40; i++) g.tick(1 / 30);                       // the big snake grows a body
    const small = g.addPlayer({ id: 'small', name: 'small', buyin: 1, skinIndex: 0 });
    if (!protectMe) { small.protectedUntil = 0; small.spawnGrace = false; }
    small.head.x = big.points[6].x; small.head.y = big.points[6].y;     // right on the big snake's body
    small.points = [{ x: small.head.x, y: small.head.y }];
    g.tick(1 / 30);
    return g;
  };
  results.push(['a protected snake survives running into a body', spot(true).snakes.has('small')]);
  results.push(['the same snake without protection dies', !spot(false).snakes.has('small')]);
  const head = (protectMe) => {
    const g = new GameWorld({ bots: 0 });
    const big = g.addPlayer({ id: 'big', name: 'big', buyin: 25, skinIndex: 0 }); big.protectedUntil = 0;
    const small = g.addPlayer({ id: 'small', name: 'small', buyin: 1, skinIndex: 0 }); if (!protectMe) { small.protectedUntil = 0; small.spawnGrace = false; }
    small.head.x = big.head.x; small.head.y = big.head.y;
    g.tick(1 / 30);
    return g;
  };
  results.push(['a protected snake survives a head-on meeting with a bigger one, and does not kill it', head(true).snakes.has('small') && head(true).snakes.has('big')]);
  const told = (g) => g.events.some((e) => e.type === 'kill' && e.targetId === 'big' && e.data.victim === 'small');
  results.push(['a player who kills with their body is told (for the kill sound)', told(spot(false))]);
  results.push(['a player who wins a head-on is told too', told(head(false))]);
  results.push(['nobody is told about a kill when the other snake was protected', !told(spot(true)) && !told(head(true))]);
  w = fresh(); w.setInput('p', 0, true); results.push(['boosting ends spawn protection', !w._isProtected(w.snakes.get('p'))]);
  w = fresh(); run(w, CFG.SPAWN_PROTECT_SEC + 0.2, null); results.push(['protection ends after the set time', !w._isProtected(w.snakes.get('p'))]);
  w = fresh(); results.push(['a fresh snake is protected', w._isProtected(w.snakes.get('p')) && w.snapshot().snakes[0].prot === 1]);

  let bad = 0;
  for (const [name, ok] of results) { if (!ok) bad++; console.log('hold-to-cash-out: ' + name + '  ' + (ok ? 'ok' : 'FAILED')); }
  if (bad) process.exitCode = 1;
}
// 2b) a death returns the WHOLE stake to the map as orbs: nothing disappears, nothing is created
{
  let worst = 0;
  for (const [buyin, ticks] of [[1, 0], [5, 0], [5, 40], [50, 90], [200, 200], [500, 400]]) {
    const w = new GameWorld({ bots: 0 });
    const s = w.addPlayer({ id: 'p', name: 'p', buyin, skinIndex: 0 });
    for (let t = 0; t < ticks; t++) { w.setInput('p', t * 0.07, false); w.tick(1 / 30); }
    const before = w.totalValue();
    w._kill(s, 'test');
    worst = Math.max(worst, Math.abs(w.totalValue() - before));
    w.events.length = 0;
  }
  console.log('death value change (buy-ins $1..$500, short and long bodies): largest difference $' + worst.toFixed(9) + '  ->', worst > 1e-6 ? 'VALUE CHANGED' : 'ok, nothing lost or created');
}

// 3) totalValue() — the number the solvency check relies on — never goes UP in a real-money world,
//    however snakes steer, boost, collide, die or cash out. (It may go down: orbs trimmed by the cap.)
{
  let worst = 0, ticks = 0, deaths = 0;
  for (let round = 0; round < 6; round++) {
    const w = new GameWorld({ bots: 0 });
    const ids = ['a', 'b', 'c', 'd'];
    ids.forEach((id, i) => w.addPlayer({ id, name: id, buyin: 20 + i * 15, skinIndex: 0 }));
    // pack them close together so collisions and kills actually happen
    ids.forEach((id, i) => { const s = w.snakes.get(id); s.head.x = i * 18; s.head.y = (i % 2) * 18; s.points = [{ x: s.head.x, y: s.head.y }]; });
    let prev = w.totalValue();
    const start = prev;
    for (let t = 0; t < 900; t++) {
      for (const id of ids) w.setInput(id, Math.random() * Math.PI * 2, Math.random() < 0.5);
      w.tick(1 / 30);
      const now = w.totalValue();
      worst = Math.max(worst, now - prev);
      prev = now;
      ticks++;
      for (const e of w.events) if (e.type === 'death') deaths++;
      w.events.length = 0;
    }
    if (prev > start + 1e-6) worst = Math.max(worst, prev - start);
  }
  console.log('totalValue over ' + ticks + ' ticks, ' + deaths + ' deaths: largest single-tick increase $' + worst.toFixed(6) + '  ->',
    worst > 1e-6 ? 'VALUE CREATED' : 'ok');
}
process.exit(0);
