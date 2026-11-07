// gameServer.js
//
// Server-authoritative simulation for SnakePay multiplayer.
//
// This intentionally mirrors the single-player client's simulation logic
// (movement, bot AI, collision, orb economy, death/cash-out) so behavior
// stays consistent between the modes you've already tuned. It does NOT do
// any rendering — it just advances world state and produces compact
// snapshots for broadcasting to clients.
//
// NOTE ON DUPLICATION: CFG below is intentionally a copy of the client's
// CFG object. Once this moves into a real build pipeline (bundler/module
// system), pull this into one shared config file imported by both the
// client and the server so they can never drift out of sync. For this
// first working version, keeping it a flat, readable copy is the priority.

const CFG = {
  WORLD_RADIUS: 3700,
  POINT_SPACING: 4,
  BASE_RADIUS: 6.5,
  MIN_LEN: 6,
  GROW_PER_ORB: 3.2,
  // Real players only by default. Set the NUM_BOTS env var on your host (e.g.
  // Render's dashboard) to a number > 0 if you ever want the world seeded
  // with AI-controlled snakes again — no code change needed either way.
  NUM_BOTS: Number(process.env.NUM_BOTS) || 0,
  ORB_CAP: 6000,      // a safety limit only: past it the oldest orbs are merged into others, never deleted
  ORB_CELL: 64,       // size of the squares orbs are filed under (eating and per-player snapshots)
  LEN_PER_DOLLAR: 8,
  DEFAULT_BUYIN: 5,
  // Must be >= 8 / LEN_PER_DOLLAR: startLenForBuyin() floors the starting length at 8,
  // so anything below $1 would start (and cash out) worth more than was paid in.
  MIN_BUYIN: 1,
  MAX_BUYIN: 500,
  SPAWN_CLEAR: 1000,   // a new snake looks for a start at least this far from every other snake (the best found is used if none is)
  NORMAL_SPEED: 145,
  BOOST_MULT: 1.9,
  TURN_RATE_BASE: 5.6,
  BOOST_DRAIN_INTERVAL: 0.11,
  // A head dies the moment its drawn circle touches the other snake's drawn body (the radii as drawn, added). A smaller
  // factor made players sink into a body before dying; the grid squares are wider than the biggest possible reach.
  HIT_SCALE: 1.0,
  GRID_CELL: 80,
  TICK_RATE: 30, // server ticks per second
  // A cash-out has to be held this long, staying on the map and killable the whole time, so nobody can
  // bail out the instant before dying. The server counts the time; the client only shows it.
  CASHOUT_HOLD_SEC: process.env.CASHOUT_HOLD_SECONDS !== undefined ? Number(process.env.CASHOUT_HOLD_SECONDS) : 5,
  CASHOUT_HOLD_LAPSE_SEC: 2, // the client re-sends the hold every second; silence this long cancels it
  // A new snake cannot be killed (and cannot kill) for this long, so nobody is eaten the instant they spawn.
  // Boosting ends it early. Both of these can be changed from the admin page.
  SPAWN_PROTECT_SEC: process.env.SPAWN_PROTECT_SECONDS !== undefined ? Number(process.env.SPAWN_PROTECT_SECONDS) : 3,
  // A snake must have been in the game this long before a cash-out hold is accepted.
  MIN_PLAY_SEC: process.env.MIN_PLAY_SECONDS !== undefined ? Number(process.env.MIN_PLAY_SECONDS) : 10,
};

const SKIN_COUNT = 9; // must match client's SKINS.length (and SKIN_TIERS in solanaWallet.js)
const BOOST_BURN = 1.4; // length a snake burns per boost tick

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function dist2(x1, y1, x2, y2) { const dx = x1 - x2, dy = y1 - y2; return dx * dx + dy * dy; }
function normAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
function toDollars(length) { return length / CFG.LEN_PER_DOLLAR; }
function startLenForBuyin(buyin) {
  const b = clamp(buyin, CFG.MIN_BUYIN, CFG.MAX_BUYIN);
  return Math.max(8, b * CFG.LEN_PER_DOLLAR);
}
function randomBotBuyin() {
  const r = Math.random();
  if (r < 0.30) return rand(2, 8);
  if (r < 0.60) return rand(8, 25);
  if (r < 0.85) return rand(25, 60);
  if (r < 0.97) return rand(60, 120);
  return rand(120, 250);
}

const BOT_NAME_PARTS1 = ["Big","Lucky","Silk","Cold","High","Fast","Slick","Diamond","Royal","Iron","Neon","Velvet","Turbo","Ghost","Prime"];
const BOT_NAME_PARTS2 = ["Roller","Stacker","Hustler","Baron","Whale","Grinder","Shark","Bandit","Ace","Fox","Viper","Comet","Dealer","Chip","Runner"];
function randBotName() {
  return BOT_NAME_PARTS1[(Math.random() * BOT_NAME_PARTS1.length) | 0] + BOT_NAME_PARTS2[(Math.random() * BOT_NAME_PARTS2.length) | 0];
}

function radiusFor(snake) {
  return clamp(CFG.BASE_RADIUS + Math.sqrt(snake.length) * 0.62, CFG.BASE_RADIUS, 34);
}

function spawnOrb(x, y, value, radius) {
  let px, py;
  if (x === undefined) {
    const r = Math.sqrt(Math.random()) * ((radius || CFG.WORLD_RADIUS) - 60);
    const a = Math.random() * Math.PI * 2;
    px = Math.cos(a) * r; py = Math.sin(a) * r;
  } else { px = x; py = y; }
  return { x: px, y: py, value: value || (Math.random() < 0.12 ? 3 : 1) };
}

let idCounter = 1;

class GameWorld {
  /** opts.bots overrides CFG.NUM_BOTS — the real-money world must never contain bots, whose stakes nobody paid. */
  constructor(opts) {
    this.snakes = new Map(); // id -> snake
    this.orbs = [];
    this.grid = new Map();
    this.elapsed = 0;
    this.tickCount = 0;     // ticks run so far (the server sends an update every second tick)
    this.lastSnapTick = 0;  // the tick of the last update sent to players
    this.events = []; // { type, targetId, data } — drained by the server layer each tick
    // Options that only the local demo uses: a smaller arena, food that appears from nowhere, bigger bots.
    this.radius = (opts && opts.radius) || CFG.WORLD_RADIUS;
    this.ambientOrbs = (opts && opts.ambientOrbs) || 0;
    this.botScale = (opts && opts.botScale) || 1;
    this.pendingRadius = 0;
    this.orbGrid = new Map();   // orbs filed by square, rebuilt at the end of every tick
    this.botCount = opts && opts.bots !== undefined ? opts.bots : CFG.NUM_BOTS;
    for (let i = 0; i < this.botCount; i++) this._spawnBot();
  }

  _bots() { return Array.from(this.snakes.values()).filter((s) => !s.isPlayer); }
  _hasPlayers() { for (const s of this.snakes.values()) if (s.isPlayer) return true; return false; }

  /** Replace all bots with count fresh ones; scale multiplies how big they start (demo only). */
  setBots(count, scale) {
    this.botScale = scale > 0 ? scale : this.botScale;
    this.botCount = Math.max(0, Math.floor(count));
    for (const b of this._bots()) this.snakes.delete(b.id);
    for (let i = 0; i < this.botCount; i++) this._spawnBot();
  }

  /** Demo only: wipes the world back to a fresh start (every snake, player included, and every orb) with the given settings. */
  resetAll(opts) {
    this.snakes.clear(); this.orbs.length = 0; this.events.length = 0; this.grid.clear(); this.orbGrid.clear(); this._anyEaten = false;
    this.radius = (opts && opts.radius) || CFG.WORLD_RADIUS; this.pendingRadius = 0;
    this.botScale = (opts && opts.botScale) || 1;
    this.ambientOrbs = (opts && opts.ambientOrbs) || 0;
    this.botCount = opts && opts.bots !== undefined ? opts.bots : CFG.NUM_BOTS;
    for (let i = 0; i < this.botCount; i++) this._spawnBot();
  }

  /** A new arena size takes effect once nobody is playing in this world, so nobody is thrown out of the map. */
  setRadius(r) { this.pendingRadius = r; }

  _topUpOrbs() {
    const need = Math.min(this.ambientOrbs, CFG.ORB_CAP) - this.orbs.length;
    for (let i = 0; i < Math.min(need, 25); i++) this._dropOrb(spawnOrb(undefined, undefined, undefined, this.radius));
  }

  /** Total value in play, in credits: every live snake's length plus every orb. An upper bound on what can still be paid out. */
  totalValue() {
    let length = 0;
    for (const s of this.snakes.values()) if (s.alive) length += s.length;
    for (const o of this.orbs) length += o.value * CFG.GROW_PER_ORB;
    return toDollars(length);
  }

  _makeSnake({ id, name, isPlayer, skinIndex, startLen }) {
    // As far from every other snake as a few dozen tries can find, so a new snake never starts near anyone.
    const spot = this._pickSpawn(isPlayer);
    const a = Math.atan2(spot.y, spot.x), r = Math.hypot(spot.x, spot.y);
    const ang = Math.atan2(-spot.y, -spot.x) + rand(-0.9, 0.9); // roughly towards the middle, away from the wall
    return {
      id, name, isPlayer, alive: true, bornAt: this.elapsed,
      protectedUntil: isPlayer ? this.elapsed + CFG.SPAWN_PROTECT_SEC : 0,
      spawnGrace: isPlayer, // protection is kept up after it runs out for as long as the snake is still inside another's body
      skinIndex: skinIndex % SKIN_COUNT,
      colorSeed: rand(0, 999),
      head: { x: Math.cos(a) * r, y: Math.sin(a) * r },
      angle: ang, targetAngle: ang,
      points: [{ x: Math.cos(a) * r, y: Math.sin(a) * r }],
      distSincePoint: 0,
      length: startLen,
      buyin: toDollars(startLen),
      coinsEaten: 0,
      boosting: false,
      boostTimer: 0,
      bestRank: 999,
      ai: { wanderTimer: rand(0.5, 2), targetOrb: null },
    };
  }

  /**
   * A starting spot far from everybody else. A few dozen random spots are tried and the one with the most room around
   * it (distance to the nearest head or body of any snake) wins; the search stops early once a spot has CFG.SPAWN_CLEAR.
   */
  _pickSpawn(isPlayer) {
    const R = this.radius * (isPlayer ? 0.8 : 0.75);
    const pts = [];
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      pts.push(s.head.x, s.head.y);
      for (let i = 0; i < s.points.length; i += 6) pts.push(s.points[i].x, s.points[i].y);
    }
    let best = null, bestD = -1;
    for (let k = 0; k < 150; k++) {
      const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * R;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      let d = Infinity;
      for (let j = 0; j < pts.length; j += 2) { const dd = dist2(x, y, pts[j], pts[j + 1]); if (dd < d) { d = dd; if (d < bestD * bestD) break; } }
      const dist = Math.sqrt(d);
      if (dist > bestD) { bestD = dist; best = { x, y }; }
      if (bestD >= CFG.SPAWN_CLEAR) break;
    }
    return best;
  }

  _spawnBot() {
    const id = 'bot_' + (idCounter++);
    const startLen = startLenForBuyin(randomBotBuyin() * this.botScale);
    const s = this._makeSnake({ id, name: randBotName(), isPlayer: false, skinIndex: (Math.random() * SKIN_COUNT) | 0, startLen });
    this.snakes.set(id, s);
  }

  addPlayer({ id, name, buyin, skinIndex }) {
    const startLen = startLenForBuyin(buyin || CFG.DEFAULT_BUYIN);
    const s = this._makeSnake({ id, name: (name || 'Player').slice(0, 16), isPlayer: true, skinIndex: skinIndex || 0, startLen });
    this.snakes.set(id, s);
    return s;
  }

  removePlayer(id) {
    this.snakes.delete(id);
  }

  setInput(id, angle, boosting) {
    const s = this.snakes.get(id);
    if (!s || !s.alive) return;
    if (typeof angle === 'number' && isFinite(angle)) s.targetAngle = angle;
    s.boosting = !!boosting;
    if (s.boosting && this._isProtected(s)) s.protectedUntil = 0; // boosting gives up the protection
  }

  _isProtected(s) { return s.protectedUntil > this.elapsed; }

  /** How far through the hold-to-cash-out a snake is, 0 to 100 (0 when it is not holding). Everyone sees this as a ring around the head. */
  cashoutPercent(s) {
    if (s.cashoutHold === undefined || s.cashoutHold === null || !(s.cashoutHold > 0)) return 0;
    return Math.max(1, Math.min(100, Math.round(100 * s.cashoutHold / CFG.CASHOUT_HOLD_SEC)));
  }

  playerCount() { let n = 0; for (const s of this.snakes.values()) if (s.isPlayer) n++; return n; }

  /** Starts (or refreshes) the hold-to-cash-out. The payout happens in tick() once the hold has lasted long enough. */
  startCashout(id) {
    const s = this.snakes.get(id);
    if (!s || !s.alive) return;
    if (this.elapsed - s.bornAt < CFG.MIN_PLAY_SEC) return; // too soon: a snake has to play a while first
    if (s.cashoutHold === undefined || s.cashoutHold === null) s.cashoutHold = 0;
    s.cashoutHoldSeen = this.elapsed;
  }

  cancelCashout(id) {
    const s = this.snakes.get(id);
    if (s) s.cashoutHold = null;
  }

  requestCashout(id) {
    const s = this.snakes.get(id);
    if (!s || !s.alive) return null;
    const amount = toDollars(s.length);
    this.events.push({ type: 'cashout_result', targetId: id, data: { amount, buyin: s.buyin, bestRank: s.bestRank, coinsEaten: s.coinsEaten, name: s.name } });
    this.snakes.delete(id);
    return amount;
  }

  _updateMotion(snake, dt) {
    const radius = radiusFor(snake);
    const maxTurn = CFG.TURN_RATE_BASE / (1 + radius * 0.045);
    const diff = normAngle(snake.targetAngle - snake.angle);
    const step = clamp(diff, -maxTurn * dt, maxTurn * dt);
    snake.angle = normAngle(snake.angle + step);

    const wantsBoost = snake.boosting && snake.length > CFG.MIN_LEN + 4;
    const speed = CFG.NORMAL_SPEED * (wantsBoost ? CFG.BOOST_MULT : 1);

    const px = snake.head.x, py = snake.head.y;
    snake.prevX = px; snake.prevY = py; // where the head was before this move (a hit is placed exactly on the edge, see _backUpToContact)
    snake.head.x += Math.cos(snake.angle) * speed * dt;
    snake.head.y += Math.sin(snake.angle) * speed * dt;

    // The body is a trail of points exactly POINT_SPACING apart along the path the head took (several points per
    // tick when boosting). It used to add one point per tick, which spaced them speed*dt apart: a body up to twice
    // as long as the one drawn, with an invisible tail you could die on and boost orbs falling far behind you.
    const travel = speed * dt, SP = CFG.POINT_SPACING;
    let toNext = SP - snake.distSincePoint;   // how far along this move the next point goes
    while (travel > 0 && toNext <= travel) {
      const f = toNext / travel;
      snake.points.unshift({ x: px + (snake.head.x - px) * f, y: py + (snake.head.y - py) * f });
      toNext += SP;
    }
    snake.distSincePoint = SP - (toNext - travel); // distance from the newest point to the head
    // head + (targetCount - 1) points: the same body the page draws
    const keep = Math.max(3, Math.round(snake.length / SP) - 1);
    if (snake.points.length > keep) snake.points.length = keep;

    if (wantsBoost) {
      snake.boostTimer -= dt;
      if (snake.boostTimer <= 0) {
        snake.boostTimer = CFG.BOOST_DRAIN_INTERVAL;
        snake.length = Math.max(CFG.MIN_LEN, snake.length - BOOST_BURN);
        // The orb is worth exactly the length that was burned (an orb of value v adds
        // GROW_PER_ORB * v length), so boosting moves value around but never creates it.
        const tail = snake.points[snake.points.length - 1] || snake.head;
        this._dropOrb(spawnOrb(tail.x + rand(-4, 4), tail.y + rand(-4, 4), BOOST_BURN / CFG.GROW_PER_ORB));
      }
    }
  }

  _botAI(snake, dt) {
    const ai = snake.ai;
    const head = snake.head;

    const distFromCenter = Math.hypot(head.x, head.y);
    if (distFromCenter > this.radius - 260) {
      snake.targetAngle = Math.atan2(-head.y, -head.x);
      ai.wanderTimer = 0.4;
      return;
    }

    let threat = null, threatDist = 240 * 240;
    for (const other of this.snakes.values()) {
      if (other === snake || !other.alive) continue;
      if (radiusFor(other) <= radiusFor(snake) * 1.05) continue;
      const d2 = dist2(head.x, head.y, other.head.x, other.head.y);
      if (d2 < threatDist) { threatDist = d2; threat = other; }
    }
    if (threat) {
      snake.targetAngle = Math.atan2(head.y - threat.head.y, head.x - threat.head.x);
      ai.wanderTimer = 0.3;
      snake.boosting = Math.random() < 0.02;
      return;
    }

    ai.wanderTimer -= dt;
    if (ai.wanderTimer <= 0 || !ai.targetOrb) {
      ai.wanderTimer = rand(0.6, 1.4);
      let best = null, bestD = 480 * 480;
      const sampleStep = Math.max(1, Math.floor(this.orbs.length / 60));
      for (let i = 0; i < this.orbs.length; i += sampleStep) {
        const o = this.orbs[i];
        const d2 = dist2(head.x, head.y, o.x, o.y);
        if (d2 < bestD) { bestD = d2; best = o; }
      }
      ai.targetOrb = best;
      if (!best) snake.targetAngle = snake.angle + rand(-0.9, 0.9);
    }
    if (ai.targetOrb) snake.targetAngle = Math.atan2(ai.targetOrb.y - head.y, ai.targetOrb.x - head.x);
    snake.boosting = false;
  }

  _buildGrid() {
    this.grid.clear();
    for (const s of this.snakes.values()) {
      if (!s.alive || this._isProtected(s)) continue; // a protected snake's body cannot hurt anyone
      const r = radiusFor(s);
      for (let i = 0; i < s.points.length; i++) { // every point (4 units apart), so the edge of the body is exact
        const p = s.points[i];
        const key = Math.floor(p.x / CFG.GRID_CELL) + ',' + Math.floor(p.y / CFG.GRID_CELL);
        let arr = this.grid.get(key);
        if (!arr) { arr = []; this.grid.set(key, arr); }
        // The first couple of trail points sit essentially on top of the head.
        // Flag them so head-on encounters aren't mistaken for body hits — otherwise
        // two snakes meeting face-to-face each "hit the other's body" and BOTH die.
        arr.push({ ownerId: s.id, x: p.x, y: p.y, r, isHead: i <= 1 });
      }
    }
  }

  /** Body collision only — head-region points are ignored here (see _checkHeadOn). */
  _checkCollision(snake) {
    return this._hitAt(snake, snake.head.x, snake.head.y, radiusFor(snake));
  }

  /** The id of the snake whose body a head of radius `r` at (x, y) would be touching, or null. */
  _hitAt(snake, x, y, r) {
    const cx = Math.floor(x / CFG.GRID_CELL), cy = Math.floor(y / CFG.GRID_CELL);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const arr = this.grid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const entry of arr) {
          if (entry.ownerId === snake.id) continue;
          if (entry.isHead) continue; // handled by _resolveHeadOnCollisions
          // The grid was built at the start of the tick: a snake that has died since (killed head-on, say) is gone, and
          // running into where it was must not kill you, or blame the wall.
          const owner = this.snakes.get(entry.ownerId);
          if (!owner || !owner.alive) continue;
          const minDist = (r + entry.r) * CFG.HIT_SCALE;
          if (dist2(x, y, entry.x, entry.y) < minDist * minDist) return entry.ownerId;
        }
      }
    }
    return null;
  }
  /**
   * A snake moves a few units each tick, so the tick it hits something it has usually gone a little way INTO it. The
   * head is put back on the exact spot where its edge first touched (found by halving the step), so it stops on the edge
   * like in slither.io, and that spot is what the player's screen freezes on.
   */
  _backUpToContact(snake, touching) {
    const ax = snake.prevX, ay = snake.prevY, bx = snake.head.x, by = snake.head.y;
    if (ax === undefined || touching(ax, ay)) return; // already touching before this move (just spawned)
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (touching(ax + (bx - ax) * mid, ay + (by - ay) * mid)) hi = mid; else lo = mid;
    }
    snake.head.x = ax + (bx - ax) * hi; snake.head.y = ay + (by - ay) * hi; // hi: just inside, so the hit still counts as a touch
  }

  /** A snake's body points (head end first) as one flat list of numbers, sent once to each player who has not seen the snake yet. */
  bodyOf(id) {
    const s = this.snakes.get(id), out = [];
    if (s) {
      // every second point (8 units apart), whole numbers: the page joins them with straight lines and re-spaces them, which is
      // indistinguishable on screen and a third of the size (a very long snake is thousands of points)
      for (let i = 0; i < s.points.length; i += 2) out.push(Math.round(s.points[i].x), Math.round(s.points[i].y));
      const last = s.points[s.points.length - 1];
      if (s.points.length % 2 === 0 && last) out.push(Math.round(last.x), Math.round(last.y));
    }
    return out;
  }

  /**
   * Head-to-head resolution, classic snake-game style: when two heads meet, the SMALLER
   * snake dies and the bigger one survives (and eats the drop); a near-tie is a coin flip.
   * Never both. Returns an array of [snake, killerName, killerId] to kill.
   */
  _resolveHeadOnCollisions() {
    const alive = Array.from(this.snakes.values()).filter(s => s.alive);
    const deaths = [];
    const doomed = new Set();
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        if (this._isProtected(a) || this._isProtected(b)) continue; // protected snakes pass through everyone
        if (doomed.has(a.id) && doomed.has(b.id)) continue;
        const ra = radiusFor(a), rb = radiusFor(b);
        const minDist = (ra + rb) * CFG.HIT_SCALE;
        if (dist2(a.head.x, a.head.y, b.head.x, b.head.y) >= minDist * minDist) continue;

        // Exactly one snake dies: the smaller one. When they are about the same size (within 5%) it is a coin flip,
        // so a head-on never kills both and never favours the same player.
        const ratio = a.length / b.length;
        const aWins = ratio > 1.05 ? true : ratio < 0.95 ? false : Math.random() < 0.5;
        const [loser, winner] = aWins ? [b, a] : [a, b];
        if (!doomed.has(loser.id)) { doomed.add(loser.id); deaths.push([loser, winner.name, winner.id]); }
      }
    }
    return deaths;
  }

  _buildOrbGrid() {
    this.orbGrid.clear();
    const C = CFG.ORB_CELL;
    for (const o of this.orbs) {
      const key = Math.floor(o.x / C) + ',' + Math.floor(o.y / C);
      const arr = this.orbGrid.get(key);
      if (arr) arr.push(o); else this.orbGrid.set(key, [o]);
    }
  }

  /** Eats the orbs touching the head. Only the squares around the head are looked at, and an eaten orb is marked and swept out at the end of the tick. */
  _checkOrbEating(snake) {
    const r = radiusFor(snake) + 5, C = CFG.ORB_CELL;
    const cx = Math.floor(snake.head.x / C), cy = Math.floor(snake.head.y / C), reach = Math.ceil(r / C);
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      for (let gy = cy - reach; gy <= cy + reach; gy++) {
        const arr = this.orbGrid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const o of arr) {
          if (o.eaten) continue;
          if (dist2(snake.head.x, snake.head.y, o.x, o.y) < r * r) {
            snake.length += CFG.GROW_PER_ORB * o.value;
            snake.coinsEaten++;
            o.eaten = true; this._anyEaten = true;
          }
        }
      }
    }
  }

  /**
   * Every orb goes through here. Past the safety limit the OLDEST orbs are merged into other orbs: their value moves
   * on, so no orb (and no money) ever disappears. (The old limit of 700 deleted the oldest, which is why a dead
   * snake's orbs vanished a few seconds later on a busy map.)
   */
  _dropOrb(orb) { this.orbs.push(orb); }

  /**
   * Called once at the end of a tick, after eaten orbs are swept out (merging while some are still marked eaten would
   * count their value twice). Past the limit the oldest orbs are merged into others, so no value is lost.
   */
  _enforceOrbCap() {
    if (this.orbs.length <= CFG.ORB_CAP) return;
    const merged = this.orbs.splice(0, this.orbs.length - CFG.ORB_CAP + 300);
    for (const m of merged) this.orbs[(Math.random() * this.orbs.length) | 0].value += m.value;
  }

  _kill(snake, killerName, killerId) {
    snake.alive = false;
    // The whole stake goes back on the map: the orbs together are worth exactly the snake's length
    // (an orb of value v adds GROW_PER_ORB * v length). Nothing vanishes with a death, so the only
    // house income is the explicit fee taken at cash-out, and a loser's money reaches the winners.
    const dropAt = [];
    for (let i = 0; i < snake.points.length; i += 3) dropAt.push(snake.points[i]);
    if (dropAt.length === 0) dropAt.push(snake.head);
    const perOrb = snake.length / CFG.GROW_PER_ORB / dropAt.length;
    for (const p of dropAt) this._dropOrb(spawnOrb(p.x + rand(-8, 8), p.y + rand(-8, 8), perOrb));

    // The killer (if a player) is told, so the page can play its kill sound.
    if (killerId !== undefined && killerId !== snake.id) {
      const k = this.snakes.get(killerId);
      if (k && k.isPlayer) this.events.push({ type: 'kill', targetId: killerId, data: { victim: snake.name } });
    }

    if (snake.isPlayer) {
      this.events.push({
        type: 'death',
        targetId: snake.id,
        data: { killerName: killerName || null, buyin: snake.buyin, bestRank: snake.bestRank, coinsEaten: snake.coinsEaten, x: round1(snake.head.x), y: round1(snake.head.y), angle: round3(snake.angle) },
      });
      this.snakes.delete(snake.id);
    } else {
      this.snakes.delete(snake.id);
      setTimeout(() => { if (!this._stopped && this._bots().length < this.botCount) this._spawnBot(); }, rand(1500, 3500));
    }
  }

  tick(dt) {
    this.elapsed += dt;
    this.tickCount++;
    if (this.pendingRadius && !this._hasPlayers()) { // a new arena size, applied between games
      this.radius = this.pendingRadius; this.pendingRadius = 0; this.orbs.length = 0; this.setBots(this.botCount, this.botScale);
    }
    if (this.ambientOrbs) this._topUpOrbs();

    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      if (!s.isPlayer) this._botAI(s, dt);
      this._updateMotion(s, dt);
    }

    this._buildGrid();

    // Head-to-head first, so a face-to-face meeting is judged by size rather
    // than both snakes registering a "body hit" on each other and both dying.
    for (const [victim, killerName, killerId] of this._resolveHeadOnCollisions()) {
      // In a three-way meeting the winner of one head-on can itself lose another; the victim still gets the winner's name, but a snake that is gone cannot be credited with a kill.
      if (victim.alive) {
        const k = this.snakes.get(killerId);
        if (k) { const md = (radiusFor(victim) + radiusFor(k)) * CFG.HIT_SCALE; this._backUpToContact(victim, (x, y) => dist2(x, y, k.head.x, k.head.y) < md * md); }
        this._kill(victim, killerName, k && k.alive ? killerId : undefined);
      }
    }

    // Ranks by length, worked out once per tick (not once per snake).
    const ranked = Array.from(this.snakes.values()).filter(x => x.alive).sort((a, b) => b.length - a.length);
    const rankOf = new Map(); ranked.forEach((x, i) => rankOf.set(x.id, i + 1));
    for (const s of Array.from(this.snakes.values())) {
      if (!s.alive) continue;
      this._checkOrbEating(s);
      const distFromCenter = Math.hypot(s.head.x, s.head.y);
      if (distFromCenter > this.radius) { this._kill(s, null); continue; }
      let killerId = this._isProtected(s) ? null : this._checkCollision(s);
      if (s.spawnGrace && !this._isProtected(s)) {
        if (killerId !== null) { s.protectedUntil = this.elapsed + 0.3; killerId = null; } // still inside someone: not yet
        else s.spawnGrace = false;
      }
      if (killerId !== null) {
        const rs = radiusFor(s);
        this._backUpToContact(s, (x, y) => this._hitAt(s, x, y, rs) !== null);
        const touched = this._hitAt(s, s.head.x, s.head.y, rs); // the snake whose edge it actually stopped on (the first one it reached)
        if (touched !== null) killerId = touched;
        const killer = this.snakes.get(killerId);
        this._kill(s, killer ? killer.name : null, killer ? killer.id : undefined);
      } else {
        const rank = rankOf.get(s.id) || 0;
        if (rank > 0 && rank < s.bestRank) s.bestRank = rank;
      }
    }

    if (this._anyEaten) { this.orbs = this.orbs.filter(o => !o.eaten); this._anyEaten = false; }
    this._enforceOrbCap();
    this._buildOrbGrid();

    // Holds are settled last, so a snake that died this tick never gets paid.
    for (const s of Array.from(this.snakes.values())) {
      if (!s.alive || s.cashoutHold === undefined || s.cashoutHold === null) continue;
      if (this.elapsed - s.cashoutHoldSeen > CFG.CASHOUT_HOLD_LAPSE_SEC) { s.cashoutHold = null; continue; }
      s.cashoutHold += dt;
      if (s.cashoutHold >= CFG.CASHOUT_HOLD_SEC) this.requestCashout(s.id);
    }
  }

  stop() { this._stopped = true; }

  /** Compact snapshot for network broadcast — no per-snake point trails (clients rebuild trails locally from head motion). */
  /** Every live snake's head and basics (the body is rebuilt by the page from the head's path). */
  snapshotSnakes() {
    const snakes = [];
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const entry = {
        id: s.id, name: s.name, x: round1(s.head.x), y: round1(s.head.y),
        angle: round3(s.angle), length: round1(s.length),
        boosting: s.boosting, skinIndex: s.skinIndex, colorSeed: round1(s.colorSeed),
        isPlayer: s.isPlayer,
      };
      if (this._isProtected(s)) entry.prot = 1; // only present while protected, to keep snapshots small
      const co = this.cashoutPercent(s); if (co) entry.co = co;
      snakes.push(entry);
    }
    return snakes;
  }

  /**
   * The same snakes as snapshotSnakes, as short rows for the network: [id, x, y, angle, length, flags, cashOutPercent?].
   * flags: 1 = boosting, 2 = spawn-protected. The things that never change (name, skin, colour seed) are sent once, not here.
   */
  snapshotRows() {
    const rows = [];
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const row = [s.id, round1(s.head.x), round1(s.head.y), round3(s.angle), round1(s.length), (s.boosting ? 1 : 0) | (this._isProtected(s) ? 2 : 0)];
      const co = this.cashoutPercent(s); if (co) row.push(co);
      rows.push(row);
    }
    return rows;
  }

  /** What never changes about a snake, sent to a player once (together with its body) the first time they see it. */
  staticOf(id) {
    const s = this.snakes.get(id);
    return s ? { name: s.name, skinIndex: s.skinIndex, colorSeed: round1(s.colorSeed), isPlayer: s.isPlayer } : null;
  }

  /** The orbs near a point as one flat list [x, y, value, x, y, value, ...] (whole-number positions): about a third of the size of objects. */
  orbsNearFlat(x, y, radius) {
    const out = [], C = CFG.ORB_CELL, r2 = radius * radius;
    const x0 = Math.floor((x - radius) / C), x1 = Math.floor((x + radius) / C), y0 = Math.floor((y - radius) / C), y1 = Math.floor((y + radius) / C);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const arr = this.orbGrid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const o of arr) if (!o.eaten && dist2(x, y, o.x, o.y) <= r2) out.push(Math.round(o.x), Math.round(o.y), Math.round(o.value * 100) / 100);
      }
    }
    return out;
  }

  /** The orbs within `radius` of a point, for one player's snapshot (the rest are too far to see). */
  orbsNear(x, y, radius) {
    const out = [], C = CFG.ORB_CELL, r2 = radius * radius;
    const x0 = Math.floor((x - radius) / C), x1 = Math.floor((x + radius) / C), y0 = Math.floor((y - radius) / C), y1 = Math.floor((y + radius) / C);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const arr = this.orbGrid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const o of arr) if (!o.eaten && dist2(x, y, o.x, o.y) <= r2) out.push({ x: round1(o.x), y: round1(o.y), v: round3(o.value) });
      }
    }
    return out;
  }

  /** Everything (every snake and every orb): used by the tests and anything that wants the whole picture. */
  snapshot() {
    const orbs = this.orbs.map(o => ({ x: round1(o.x), y: round1(o.y), v: round3(o.value) }));
    return { snakes: this.snapshotSnakes(), orbs, elapsed: round3(this.elapsed) };
  }
}

function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = { GameWorld, CFG, SKIN_COUNT };
