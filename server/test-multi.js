// test-multi.js — verifies multiple concurrent players share one world,
// and that the cash-out flow returns the right result.
const url = process.argv[2] || 'ws://127.0.0.1:8787';

function makeClient(name, buyin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const state = { name, snapshots: 0, youId: null, lastSnap: null, cashoutResult: null, everSeen: new Set() };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'join', name, buyin, skinIndex: 0 })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') state.youId = msg.id;
      if (msg.t === 'snapshot') {
        state.snapshots++;
        state.lastSnap = msg;
        for (const s of msg.snakes) if (s.isPlayer) state.everSeen.add(s.name);
        ws.send(JSON.stringify({ t: 'input', angle: state.snapshots * 0.03, boosting: false }));
        if (state.snapshots === 15) {
          ws.send(JSON.stringify({ t: 'cashout' }));
        }
      }
      if (msg.t === 'cashout_result') {
        state.cashoutResult = msg;
        ws.close();
      }
    });
    ws.addEventListener('close', () => resolve(state));
    ws.addEventListener('error', (e) => reject(e));
  });
}

(async () => {
  const hardTimeout = setTimeout(() => {
    console.log('RESULT: FAIL (hard timeout — something never resolved)');
    process.exit(1);
  }, 8000);

  const [a, b, c] = await Promise.all([
    makeClient('Alice', 5),
    makeClient('Bob', 20),
    makeClient('Carol', 1),
  ]);
  clearTimeout(hardTimeout);

  for (const s of [a, b, c]) {
    console.log(`--- ${s.name} ---`);
    console.log('  youId:', s.youId);
    console.log('  snapshots received:', s.snapshots);
    console.log('  players ever seen across all snapshots:', Array.from(s.everSeen));
    console.log('  cashout result:', s.cashoutResult);
  }

  const allJoined = [a, b, c].every(s => s.youId);
  const allSawEachOther = [a, b, c].every(s =>
    ['Alice', 'Bob', 'Carol'].every(n => s.everSeen.has(n))
  );
  const allCashedOut = [a, b, c].every(s => s.cashoutResult && s.cashoutResult.amount > 0);

  console.log('\nall joined:', allJoined);
  console.log('all clients saw all 3 players at some point:', allSawEachOther);
  console.log('all cashed out with a positive amount:', allCashedOut);
  console.log(allJoined && allSawEachOther && allCashedOut ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(allJoined && allSawEachOther && allCashedOut ? 0 : 1);
})();
