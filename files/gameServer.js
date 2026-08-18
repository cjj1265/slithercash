// gameServer.js
//
// Server-authoritative simulation for SlitherCash multiplayer.
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
  NUM_BOTS: 50,
  ORB_CAP: 700,
  LEN_PER_DOLLAR: 8,
  DEFAULT_BUYIN: 5,
  MIN_BUYIN: 0.5,
  MAX_BUYIN: 500,
  NORMAL_SPEED: 145,
  BOOST_MULT: 1.9,
  TURN_RATE_BASE: 5.6,
  BOOST_DRAIN_INTERVAL: 0.11,
  GRID_CELL: 46,
  TICK_RATE: 30, // server ticks per second
};

const SKIN_COUNT = 14; // must match client's SKINS.length

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

function spawnOrb(x, y, value) {
  let px, py;
  if (x === undefined) {
    const r = Math.sqrt(Math.random()) * (CFG.WORLD_RADIUS - 60);
    const a = Math.random() * Math.PI * 2;
    px = Math.cos(a) * r; py = Math.sin(a) * r;
  } else { px = x; py = y; }
  return { x: px, y: py, value: value || (Math.random() < 0.12 ? 3 : 1) };
}

let idCounter = 1;

class GameWorld {
  constructor() {
    this.snakes = new Map(); // id -> snake
    this.orbs = [];
    this.grid = new Map();
    this.elapsed = 0;
    this.events = []; // { type, targetId, data } — drained by the server layer each tick
    for (let i = 0; i < CFG.NUM_BOTS; i++) this._spawnBot();
  }

  _makeSnake({ id, name, isPlayer, skinIndex, startLen }) {
    const a = rand(0, Math.PI * 2);
    const r = Math.sqrt(Math.random()) * (CFG.WORLD_RADIUS * (isPlayer ? 0.5 : 0.75));
    const ang = rand(0, Math.PI * 2);
    return {
      id, name, isPlayer, alive: true,
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

  _spawnBot() {
    const id = 'bot_' + (idCounter++);
    const startLen = startLenForBuyin(randomBotBuyin());
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
  }

  requestCashout(id) {
    const s = this.snakes.get(id);
    if (!s || !s.alive) return null;
    const amount = toDollars(s.length);
    this.events.push({ type: 'cashout_result', targetId: id, data: { amount, buyin: s.buyin, bestRank: s.bestRank, coinsEaten: s.coinsEaten } });
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

    snake.head.x += Math.cos(snake.angle) * speed * dt;
    snake.head.y += Math.sin(snake.angle) * speed * dt;

    snake.distSincePoint += speed * dt;
    if (snake.distSincePoint >= CFG.POINT_SPACING) {
      snake.distSincePoint = 0;
      snake.points.unshift({ x: snake.head.x, y: snake.head.y });
    }
    const targetCount = Math.max(4, Math.round(snake.length / CFG.POINT_SPACING));
    if (snake.points.length > targetCount) snake.points.length = targetCount;

    if (wantsBoost) {
      snake.boostTimer -= dt;
      if (snake.boostTimer <= 0) {
        snake.boostTimer = CFG.BOOST_DRAIN_INTERVAL;
        snake.length = Math.max(CFG.MIN_LEN, snake.length - 1.4);
        if (Math.random() < 0.8) {
          const tail = snake.points[snake.points.length - 1] || snake.head;
          this._dropOrb(spawnOrb(tail.x + rand(-4, 4), tail.y + rand(-4, 4), 1));
        }
      }
    }
  }

  _botAI(snake, dt) {
    const ai = snake.ai;
    const head = snake.head;

    const distFromCenter = Math.hypot(head.x, head.y);
    if (distFromCenter > CFG.WORLD_RADIUS - 260) {
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
      if (!s.alive) continue;
      const r = radiusFor(s);
      for (let i = 0; i < s.points.length; i += 2) {
        const p = s.points[i];
        const key = Math.floor(p.x / CFG.GRID_CELL) + ',' + Math.floor(p.y / CFG.GRID_CELL);
        let arr = this.grid.get(key);
        if (!arr) { arr = []; this.grid.set(key, arr); }
        // The first couple of trail points sit essentially on top of the head.
        // Flag them so head-on encounters aren't mistaken for body hits — otherwise
        // two snakes meeting face-to-face each "hit the other's body" and BOTH die.
        arr.push({ ownerId: s.id, x: p.x, y: p.y, r, isHead: i <= 2 });
      }
    }
  }

  /** Body collision only — head-region points are ignored here (see _checkHeadOn). */
  _checkCollision(snake) {
    const r = radiusFor(snake);
    const cx = Math.floor(snake.head.x / CFG.GRID_CELL);
    const cy = Math.floor(snake.head.y / CFG.GRID_CELL);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const arr = this.grid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const entry of arr) {
          if (entry.ownerId === snake.id) continue;
          if (entry.isHead) continue; // handled by _checkHeadOn
          const minDist = r * 0.72 + entry.r * 0.72;
          if (dist2(snake.head.x, snake.head.y, entry.x, entry.y) < minDist * minDist) return entry.ownerId;
        }
      }
    }
    return null;
  }

  /**
   * Head-to-head resolution, slither.io style: when two heads meet, the SMALLER
   * snake dies and the bigger one survives (and eats the drop). Only a near-exact
   * tie kills both. Returns an array of [snake, killerName] pairs to kill.
   */
  _resolveHeadOnCollisions() {
    const alive = Array.from(this.snakes.values()).filter(s => s.alive);
    const deaths = [];
    const doomed = new Set();
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        if (doomed.has(a.id) && doomed.has(b.id)) continue;
        const ra = radiusFor(a), rb = radiusFor(b);
        const minDist = ra * 0.72 + rb * 0.72;
        if (dist2(a.head.x, a.head.y, b.head.x, b.head.y) >= minDist * minDist) continue;

        const ratio = a.length / b.length;
        if (ratio > 1.05) {
          if (!doomed.has(b.id)) { doomed.add(b.id); deaths.push([b, a.name]); }
        } else if (ratio < 0.95) {
          if (!doomed.has(a.id)) { doomed.add(a.id); deaths.push([a, b.name]); }
        } else {
          // near-identical size: mutual destruction, same as slither.io
          if (!doomed.has(a.id)) { doomed.add(a.id); deaths.push([a, b.name]); }
          if (!doomed.has(b.id)) { doomed.add(b.id); deaths.push([b, a.name]); }
        }
      }
    }
    return deaths;
  }

  _checkOrbEating(snake) {
    const r = radiusFor(snake) + 5;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      if (dist2(snake.head.x, snake.head.y, o.x, o.y) < r * r) {
        snake.length += CFG.GROW_PER_ORB * o.value;
        snake.coinsEaten++;
        this.orbs.splice(i, 1);
      }
    }
  }

  _dropOrb(orb) {
    this.orbs.push(orb);
    if (this.orbs.length > CFG.ORB_CAP) this.orbs.splice(0, this.orbs.length - CFG.ORB_CAP);
  }

  _kill(snake, killerName) {
    snake.alive = false;
    for (let i = 0; i < snake.points.length; i += 3) {
      const p = snake.points[i];
      this.orbs.push(spawnOrb(p.x + rand(-8, 8), p.y + rand(-8, 8), 2));
    }
    if (this.orbs.length > CFG.ORB_CAP) this.orbs.splice(0, this.orbs.length - CFG.ORB_CAP);

    if (snake.isPlayer) {
      this.events.push({
        type: 'death',
        targetId: snake.id,
        data: { killerName: killerName || null, buyin: snake.buyin, bestRank: snake.bestRank, coinsEaten: snake.coinsEaten },
      });
      this.snakes.delete(snake.id);
    } else {
      this.snakes.delete(snake.id);
      setTimeout(() => { if (!this._stopped) this._spawnBot(); }, rand(1500, 3500));
    }
  }

  tick(dt) {
    this.elapsed += dt;

    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      if (!s.isPlayer) this._botAI(s, dt);
      this._updateMotion(s, dt);
    }

    this._buildGrid();

    // Head-to-head first, so a face-to-face meeting is judged by size rather
    // than both snakes registering a "body hit" on each other and both dying.
    for (const [victim, killerName] of this._resolveHeadOnCollisions()) {
      if (victim.alive) this._kill(victim, killerName);
    }

    for (const s of Array.from(this.snakes.values())) {
      if (!s.alive) continue;
      this._checkOrbEating(s);
      const distFromCenter = Math.hypot(s.head.x, s.head.y);
      if (distFromCenter > CFG.WORLD_RADIUS) { this._kill(s, null); continue; }
      const killerId = this._checkCollision(s);
      if (killerId !== null) {
        const killer = this.snakes.get(killerId);
        this._kill(s, killer ? killer.name : null);
      } else {
        const alive = Array.from(this.snakes.values()).filter(x => x.alive).sort((a, b) => b.length - a.length);
        const rank = alive.indexOf(s) + 1;
        if (rank > 0 && rank < s.bestRank) s.bestRank = rank;
      }
    }
  }

  stop() { this._stopped = true; }

  /** Compact snapshot for network broadcast — no per-snake point trails (clients rebuild trails locally from head motion). */
  snapshot() {
    const snakes = [];
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      snakes.push({
        id: s.id, name: s.name, x: round1(s.head.x), y: round1(s.head.y),
        angle: round3(s.angle), length: round1(s.length),
        boosting: s.boosting, skinIndex: s.skinIndex, colorSeed: round1(s.colorSeed),
        isPlayer: s.isPlayer,
      });
    }
    const orbs = this.orbs.map(o => ({ x: round1(o.x), y: round1(o.y), v: o.value }));
    return { snakes, orbs, elapsed: round3(this.elapsed) };
  }
}

function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = { GameWorld, CFG };
