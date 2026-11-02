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
