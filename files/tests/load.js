// Load test: how many players can one map hold?  Run from the files/ folder:  node tests/load.js [sim|net] [counts...]
//
//   sim  runs the game world in this process with N snakes and times each tick, the snapshot and its size.
//        It shows the game's own cost and how much data each player is sent.
//   net  starts a real server (no wallet, so anyone can join) and connects N real WebSocket players in
//        worker processes. It shows whether snapshots still arrive on time, and the server's CPU use.
//
// This is a report, not a pass/fail test. The numbers are for THIS machine, which has more CPU than a small
// hosting plan, so read them as best case. The load generator shares the machine with the server.
const path = require('path');
const { spawn, fork, execFileSync } = require('child_process');
const { GameWorld, CFG } = require(path.join(__dirname, '..', 'gameServer.js'));

const mode = process.argv[2] === 'net' || process.argv[2] === 'sim' || process.argv[2] === 'worker' ? process.argv[2] : 'both';
const counts = process.argv.slice(3).map(Number).filter((n) => n > 0);
const pct = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0; };
const f1 = (n) => n.toFixed(1);
const mb = (bytes) => (bytes / 1048576).toFixed(1);

// ---------------------------------------------------------------- sim
function simulate(n, ticks) {
  const w = new GameWorld({ bots: 0 });
  let serial = 0;
  const live = new Set();
  const join = () => { const id = 'p' + (serial++); w.addPlayer({ id, name: id, buyin: 5, skinIndex: serial % 14 }); live.add(id); };
  for (let i = 0; i < n; i++) join();
  const tickMs = [], snapMs = [], sizes = [];
  for (let t = 0; t < ticks; t++) {
    for (const id of live) if (Math.random() < 0.08) w.setInput(id, Math.random() * Math.PI * 2, Math.random() < 0.15);
    const a = process.hrtime.bigint();
    w.tick(1 / CFG.TICK_RATE);
    const b = process.hrtime.bigint();
    const snap = w.snapshot();
    const json = JSON.stringify({ t: 'snapshot', snakes: snap.snakes, orbs: snap.orbs, elapsed: snap.elapsed });
    const c = process.hrtime.bigint();
    tickMs.push(Number(b - a) / 1e6); snapMs.push(Number(c - b) / 1e6); sizes.push(Buffer.byteLength(json));
    for (const e of w.events) if (e.type === 'death' || e.type === 'cashout_result') live.delete(e.targetId);
    w.events.length = 0;
    while (live.size < n) join(); // dead players come straight back, so the count stays at n
  }
  return { tickMs, snapMs, sizes };
}

function runSim(list) {
  console.log('\n=== sim: the game world alone, ' + CFG.TICK_RATE + ' ticks/s, one tick may take ' + f1(1000 / CFG.TICK_RATE) + ' ms ===');
  console.log('players | tick avg / p95 / max ms | snapshot build+encode ms | snapshot size KB | each player downloads | server uploads in total');
  for (const n of list) {
    const r = simulate(n, 300);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const size = avg(r.sizes);
    const perPlayer = size * CFG.TICK_RATE; // bytes/s
    console.log(String(n).padStart(7) + ' | ' + [f1(avg(r.tickMs)), f1(pct(r.tickMs, 0.95)), f1(Math.max(...r.tickMs))].join(' / ').padEnd(23) +
      ' | ' + f1(avg(r.snapMs)).padEnd(24) + ' | ' + f1(size / 1024).padEnd(16) + ' | ' + (mb(perPlayer) + ' MB/s').padEnd(21) + ' | ' + mb(perPlayer * n) + ' MB/s');
  }
}

// ---------------------------------------------------------------- net
function serverCpuSeconds(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + pid + ').TotalProcessorTime.TotalSeconds'], { encoding: 'utf8' });
    return Number(out.trim());
  } catch (e) { return null; }
}

async function workerMain() {
  // argv: worker <port> <count> <seconds>; reports back to the parent when asked
  const [port, count, seconds] = [Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])];
  const gaps = [], stats = { joined: 0, failed: 0, bytes: 0, snaps: 0 };
  const socks = [];
  let measuring = false;
  await Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    let last = 0;
    const timer = setTimeout(() => { stats.failed++; resolve(); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: 'L' + i, buyin: 5, skinIndex: i % 14 }));
    ws.onmessage = (ev) => {
      const data = ev.data;
      if (typeof data === 'string' && data.startsWith('{"t":"welcome"')) { stats.joined++; clearTimeout(timer); resolve(); return; }
      if (typeof data === 'string' && data.startsWith('{"t":"error"')) { stats.failed++; clearTimeout(timer); resolve(); return; }
      if (!measuring) return;
      stats.bytes += data.length; stats.snaps++;
      const now = performance.now();
      if (last) gaps.push(now - last);
      last = now;
    };
    ws.onerror = () => {};
    socks.push(ws);
  })));
  const steer = setInterval(() => { for (const ws of socks) if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'input', angle: Math.random() * 6.28, boosting: Math.random() < 0.15 })); }, 150);
  process.send({ ready: true, joined: stats.joined, failed: stats.failed });
  process.on('message', (m) => {
    if (m === 'start') { measuring = true; setTimeout(() => { measuring = false; clearInterval(steer); socks.forEach((s) => s.close()); process.send({ done: true, stats, gaps }); setTimeout(() => process.exit(0), 200); }, seconds * 1000); }
  });
}

async function runNet(list) {
  console.log('\n=== net: a real server with N real WebSocket players (' + 10 + ' s measured per row) ===');
  console.log('players | joined | snapshots/s per player (wanted ' + CFG.TICK_RATE + ') | gap between snapshots avg / p95 / max ms | server CPU | received in total');
  for (const n of list) {
    const port = 8700 + Math.floor(Math.random() * 200);
    const env = Object.assign({}, process.env, { PORT: String(port), WS_MAX_CONNECTIONS: '5000', WS_MAX_PER_IP: '5000', NUM_BOTS: '0' });
    for (const k of ['GAME_WALLET_SECRET', 'DEPOSIT_MASTER_SEED', 'ORIGIN_SECRET', 'TRUST_CLOUDFLARE', 'ALLOW_MAINNET', 'SOLANA_NETWORK']) delete env[k];
    const server = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    const perWorker = 50, nWorkers = Math.ceil(n / perWorker);
    const workers = Array.from({ length: nWorkers }, (_, i) => {
      const count = Math.min(perWorker, n - i * perWorker);
      const child = fork(__filename, ['worker', String(port), String(count), '10'], { silent: true });
      return { child, ready: new Promise((res) => child.on('message', (m) => { if (m.ready) res(m); })), done: new Promise((res) => child.on('message', (m) => { if (m.done) res(m); })) };
    });
    const readies = await Promise.all(workers.map((w) => w.ready));
    const joined = readies.reduce((a, r) => a + r.joined, 0);
    await new Promise((r) => setTimeout(r, 1500)); // let the crowd settle
    const cpu0 = serverCpuSeconds(server.pid), t0 = Date.now();
    workers.forEach((w) => w.child.send('start'));
    const dones = await Promise.all(workers.map((w) => w.done));
    const cpu1 = serverCpuSeconds(server.pid), secs = (Date.now() - t0) / 1000;
    const gaps = [].concat(...dones.map((d) => d.gaps));
    const snaps = dones.reduce((a, d) => a + d.stats.snaps, 0), bytes = dones.reduce((a, d) => a + d.stats.bytes, 0);
    const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    console.log(String(n).padStart(7) + ' | ' + String(joined).padEnd(6) + ' | ' + f1(snaps / Math.max(1, joined) / secs).padEnd(40) + ' | ' +
      [f1(avg), f1(pct(gaps, 0.95)), f1(gaps.length ? Math.max(...gaps) : 0)].join(' / ').padEnd(40) + ' | ' +
      (cpu0 !== null && cpu1 !== null ? Math.round((cpu1 - cpu0) / secs * 100) + '% of one core' : 'n/a').padEnd(14) + ' | ' + mb(bytes / secs) + ' MB/s');
    server.kill();
    await new Promise((r) => setTimeout(r, 800));
  }
}

(async () => {
  if (mode === 'worker') return workerMain();
  if (mode === 'sim' || mode === 'both') runSim(counts.length ? counts : [10, 25, 50, 100, 200, 300, 500]);
  if (mode === 'net' || mode === 'both') await runNet(counts.length ? counts : [25, 50, 100, 200]);
  process.exit(0);
})();
