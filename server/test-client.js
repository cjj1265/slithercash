// test-client.js — connects to a running server and exercises the protocol.
// Usage: node test-client.js [ws://localhost:8787] [durationSeconds]

const url = process.argv[2] || 'ws://127.0.0.1:8787';
const durationSec = Number(process.argv[3] || 4);

const ws = new WebSocket(url);
let youId = null;
let snapshotCount = 0;
let lastSnapshot = null;
let welcomeReceived = false;
let angle = 0;

ws.addEventListener('open', () => {
  console.log('[test-client] connected to', url);
  ws.send(JSON.stringify({ t: 'join', name: 'TestBot', buyin: 5, skinIndex: 0 }));
});

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (e) { console.log('[test-client] bad JSON:', ev.data); return; }

  if (msg.t === 'welcome') {
    welcomeReceived = true;
    youId = msg.id;
    console.log('[test-client] welcome, id =', youId, 'cfg =', msg.cfg);
  } else if (msg.t === 'snapshot') {
    snapshotCount++;
    lastSnapshot = msg;
    if (snapshotCount === 1 || snapshotCount % 20 === 0) {
      const me = msg.snakes.find(s => s.id === msg.youId);
      console.log(`[test-client] snapshot #${snapshotCount}: ${msg.snakes.length} snakes, ${msg.orbs.length} orbs, me=`,
        me ? { x: me.x, y: me.y, angle: me.angle, length: me.length } : 'NOT FOUND');
    }
    // Slowly rotate our steering input so the server sees real movement over time.
    angle += 0.05;
    ws.send(JSON.stringify({ t: 'input', angle, boosting: false }));
  } else if (msg.t === 'death') {
    console.log('[test-client] DIED:', msg);
  } else if (msg.t === 'cashout_result') {
    console.log('[test-client] CASHED OUT:', msg);
  } else if (msg.t === 'pong') {
    console.log('[test-client] pong rtt ms =', Date.now() - msg.ts);
  }
});

ws.addEventListener('close', () => {
  console.log('[test-client] connection closed');
});
ws.addEventListener('error', (e) => {
  console.log('[test-client] error:', e.message || e);
});

setTimeout(() => {
  console.log('[test-client] test window elapsed. summary:');
  console.log('  welcome received:', welcomeReceived);
  console.log('  snapshots received:', snapshotCount);
  if (lastSnapshot) {
    const me = lastSnapshot.snakes.find(s => s.id === youId);
    console.log('  final self state:', me);
    console.log('  total snakes in last snapshot:', lastSnapshot.snakes.length);
    console.log('  total orbs in last snapshot:', lastSnapshot.orbs.length);
  }
  const ok = welcomeReceived && snapshotCount > 5 && lastSnapshot && lastSnapshot.snakes.length > 1;
  console.log(ok ? '[test-client] RESULT: PASS' : '[test-client] RESULT: FAIL');
  ws.close();
  process.exit(ok ? 0 : 1);
}, durationSec * 1000);
