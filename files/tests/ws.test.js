// Attack tests for wsProtocol.js: a stand-alone WebSocket server with small limits, driven by a raw
// TCP client so it can send exactly the malformed frames a hostile client would.
// Run from the files/ folder:  npm run test:ws   (about 15 seconds)
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { attachWebSocketServer } = require('../wsProtocol');

let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return fn(); };

/* ---------- a server with deliberately small limits ---------- */
function startServer(opts, onConn) {
  return new Promise((resolve) => {
    const state = { conns: [], closed: 0 };
    const server = http.createServer((req, res) => res.end('ok'));
    const ws = attachWebSocketServer(server, (conn) => {
      state.conns.push(conn);
      conn.on('close', () => { state.closed++; });
      conn.on('error', () => {});
      conn.on('message', (m) => conn.send('echo:' + m));
      if (onConn) onConn(conn);
    }, opts);
    server.listen(0, '127.0.0.1', () => resolve({ server, ws, state, port: server.address().port }));
  });
}

/* ---------- a raw client ---------- */
function frame(opcode, payload, o) {
  o = o || {};
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const fin = o.fin !== false, masked = o.masked !== false;
  const first = (fin ? 0x80 : 0) | (o.rsv || 0) | opcode;
  const m = masked ? 0x80 : 0;
  let lenBytes;
  let b1;
  if (o.fakeLen !== undefined) { b1 = m | 127; lenBytes = Buffer.alloc(8); lenBytes.writeBigUInt64BE(BigInt(o.fakeLen)); }
  else if (payload.length < 126) { b1 = m | payload.length; lenBytes = Buffer.alloc(0); }
  else if (payload.length < 65536) { b1 = m | 126; lenBytes = Buffer.alloc(2); lenBytes.writeUInt16BE(payload.length); }
  else { b1 = m | 127; lenBytes = Buffer.alloc(8); lenBytes.writeBigUInt64BE(BigInt(payload.length)); }
  const mask = crypto.randomBytes(4);
  const body = o.fakeLen !== undefined ? Buffer.alloc(0) : (masked ? Buffer.from(payload.map((b, i) => b ^ mask[i & 3])) : payload);
  return Buffer.concat([Buffer.from([first, b1]), lenBytes, masked ? mask : Buffer.alloc(0), body]);
}
const text = (s, o) => frame(0x1, s, o);

const all = []; // every raw client, so a section can close them all and wait for the server to notice
async function cleanup(S) {
  while (all.length) all.pop().sock.destroy();
  return until(() => S.ws.connectionCount() === 0, 3000);
}

function connect(port, o) {
  o = o || {};
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const c = { sock, status: null, frames: [], closed: false, open: false, buf: Buffer.alloc(0) };
    all.push(c);
    let head = Buffer.alloc(0);
    const parse = (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      while (c.buf.length >= 2) {
        let len = c.buf[1] & 0x7f, off = 2;
        if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
        if (c.buf.length < off + len) return;
        c.frames.push({ opcode: c.buf[0] & 0x0f, payload: Buffer.from(c.buf.subarray(off, off + len)) });
        c.buf = c.buf.subarray(off + len);
      }
    };
    sock.on('connect', () => sock.write([
      'GET / HTTP/1.1', 'Host: 127.0.0.1:' + port, 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + (o.key || crypto.randomBytes(16).toString('base64')),
      'Sec-WebSocket-Version: ' + (o.version || '13'),
      o.origin ? 'Origin: ' + o.origin : null, '', '',
    ].filter((x) => x !== null).join('\r\n')));
    sock.on('data', (d) => {
      if (c.open) { parse(d); return; }
      head = Buffer.concat([head, d]);
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      c.status = parseInt(head.toString().split(' ')[1], 10);
      if (c.status === 101) { c.open = true; resolve(c); parse(head.subarray(i + 4)); } else resolve(c);
    });
    sock.on('close', () => { c.closed = true; if (c.status === null) resolve(c); });
    sock.on('error', () => {});
  });
}
const closeCode = (c) => { const f = c.frames.find((x) => x.opcode === 0x8); return f && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null; };
const textOf = (c) => c.frames.filter((f) => f.opcode === 0x1).map((f) => f.payload.toString());

/* ---------- tests ---------- */
(async () => {
  const small = { maxPayload: 1024, maxMessagesPerSec: 20, maxPerIp: 3, pingIntervalMs: 60000, idleTimeoutMs: 60000,
    verifyOrigin: (req) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } } };
  const S = await startServer(small);

  console.log('\n== normal use keeps working ==');
  let c = await connect(S.port);
  check('handshake succeeds', c.status === 101, c.status);
  c.sock.write(text('hello'));
  check('a normal message is echoed', await until(() => textOf(c).includes('echo:hello'), 1000), textOf(c));
  c.sock.write(frame(0x9, 'abc'));
  check('ping is answered with the same payload', await until(() => c.frames.some((f) => f.opcode === 0xa && f.payload.toString() === 'abc'), 1000));
  c.sock.write(frame(0x8, Buffer.from([0x03, 0xe8])));
  check('close handshake is answered', await until(() => closeCode(c) === 1000, 1000), closeCode(c));
  c.sock.destroy();

  console.log('\n== size limits (judged from the frame header) ==');
  c = await connect(S.port);
  c.sock.write(text('x'.repeat(2000)));
  check('a 2000-byte message (limit 1024) -> close 1009', await until(() => closeCode(c) === 1009, 1000) && await until(() => c.closed, 1000), closeCode(c));
  c = await connect(S.port);
  c.sock.write(frame(0x1, '', { fakeLen: 2 ** 40 }));
  check('a header claiming a 1 TB message -> close 1009 at once, nothing buffered', await until(() => closeCode(c) === 1009, 800), closeCode(c));
  c = await connect(S.port);
  c.sock.write(text('x'.repeat(1024)));
  check('a message exactly at the limit is accepted', await until(() => textOf(c).length === 1, 1000), textOf(c).length);
  c.sock.destroy();

  console.log('\n== message rate limit (20 per second here) ==');
  c = await connect(S.port);
  c.sock.write(Buffer.concat(Array.from({ length: 60 }, () => text('a'))));
  check('a flood of 60 messages in one burst -> close 1008', await until(() => closeCode(c) === 1008, 1000), closeCode(c));
  c = await connect(S.port);
  for (let i = 0; i < 15; i++) { c.sock.write(text('b')); await sleep(10); }
  check('15 messages (under the limit) are fine', !c.closed && textOf(c).length === 15, [c.closed, textOf(c).length]);
  c.sock.destroy();

  console.log('\n== protocol violations ==');
  const violation = async (label, buf, want) => {
    const x = await connect(S.port);
    x.sock.write(buf);
    check(label + ' -> close ' + want, await until(() => closeCode(x) === want, 1000), closeCode(x));
    x.sock.destroy();
  };
  await violation('an unmasked client frame', text('hi', { masked: false }), 1002);
  await violation('a fragmented text message (FIN=0)', text('hi', { fin: false }), 1003);
  await violation('a continuation frame', frame(0x0, 'hi'), 1003);
  await violation('reserved bits set', text('hi', { rsv: 0x40 }), 1002);
  await violation('an unknown opcode', frame(0x3, 'hi'), 1002);
  await violation('an oversized control frame (200-byte ping)', frame(0x9, 'p'.repeat(200)), 1002);
  await violation('a fragmented control frame', frame(0x9, 'p', { fin: false }), 1002);

  await cleanup(S);
  console.log('\n== handshake ==');
  check('wrong protocol version -> 400', (await connect(S.port, { version: '8' })).status === 400);
  check('a key that is not 16 bytes -> 400', (await connect(S.port, { key: 'dG9vc2hvcnQ=' })).status === 400);
  check('a page from another site (Origin) -> 403', (await connect(S.port, { origin: 'http://evil.example' })).status === 403);
  c = await connect(S.port, { origin: 'http://127.0.0.1:' + S.port });
  check('a page from this same site -> accepted', c.status === 101, c.status);
  c.sock.destroy();
  c = await connect(S.port);
  check('no Origin header (not a browser) -> accepted', c.status === 101, c.status);
  await cleanup(S);

  console.log('\n== per-address connection cap (3 here) ==');
  const held = [];
  for (let i = 0; i < 3; i++) held.push(await connect(S.port));
  check('three connections from one address are fine', held.every((x) => x.status === 101), held.map((x) => x.status));
  const fourth = await connect(S.port);
  check('the fourth is refused -> 503', fourth.status === 503, fourth.status);
  held[0].sock.destroy();
  await sleep(200);
  const again = await connect(S.port);
  check('after one closes there is room again', again.status === 101, again.status);
  check('every connection above was cleaned up on the server', await cleanup(S), S.ws.connectionCount());
  S.ws.close(); S.server.close();

  console.log('\n== idle connections are dropped, live ones are kept ==');
  const T = await startServer({ pingIntervalMs: 200, idleTimeoutMs: 700 });
  const silent = await connect(T.port); // never answers pings
  const live = new WebSocket('ws://127.0.0.1:' + T.port); // a real client: answers pings automatically
  await new Promise((r) => { live.onopen = r; });
  await sleep(1800);
  check('the connection that never answers pings was dropped', silent.closed === true);
  check('the connection that answers pings is still open', live.readyState === 1, live.readyState);
  live.close(); silent.sock.destroy();
  T.ws.close(); T.server.close();

  console.log('\n== a client that stops reading is cut off ==');
  const U = await startServer({ maxWriteBuffer: 256 * 1024 }, (conn) => {
    const big = 'x'.repeat(60000);
    for (let i = 0; i < 400; i++) conn.send(big); // ~24 MB toward a client that never reads
  });
  const stalled = await connect(U.port);
  stalled.sock.pause();
  check('the server dropped the slow reader instead of buffering for it', await until(() => U.state.closed >= 1, 4000), U.state.closed);
  stalled.sock.destroy();
  U.ws.close(); U.server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('WS TEST CRASH:', e); process.exit(3); });
