// wsProtocol.js
//
// A minimal WebSocket server (RFC 6455) built directly on Node's built-in `http` and `crypto`
// modules, hardened for an internet-facing game. It enforces, per server:
//   - an Origin check at the handshake (only pages you allow can open a game connection),
//   - a cap on total connections and on connections per IP address,
//   - a strict handshake (GET upgrade, version 13, a real 16-byte key).
// and per connection:
//   - a maximum message size, enforced from the frame HEADER so a client can never make the
//     server buffer more than one small frame,
//   - a message rate limit,
//   - protocol rules: reserved bits clear, client frames masked, known opcodes only, control
//     frames small and unfragmented. Fragmented data messages are refused (the game's messages are
//     tiny and never fragmented),
//   - a heartbeat: the server pings and drops connections that go silent,
//   - a slow-consumer cutoff: a client that stops reading can't make the server buffer for it forever.
// Violations close the connection with the proper RFC 6455 close code (1002 protocol error,
// 1003 unsupported, 1008 policy, 1009 too big).
//
// Why not the `ws` package? You can swap it in later; this file's public API (`WSConnection`:
// .send / .on('message') / .on('close') / .close()) is intentionally shaped to make that easy.
// If you do, keep these same limits, which `ws` supports as options.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const DEFAULTS = {
  maxPayload: 4096,            // bytes in one message. Real game messages are well under 200.
  maxMessagesPerSec: 60,       // a real client sends ~20 steering updates a second
  maxWriteBuffer: 1024 * 1024, // bytes queued for a client that is not reading
  pingIntervalMs: 20000,
  idleTimeoutMs: 50000,        // no frame (not even a pong) for this long -> dropped
  maxConnections: 500,
  maxPerIp: 10,
  verifyOrigin: null,          // (req) => boolean
  getIp: null,                 // (req) => string
};

function acceptKeyFor(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

/** Encode one unmasked, final frame (server->client frames are never masked, per spec). */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function encodeClose(code, reason) {
  const text = Buffer.from(reason || '', 'utf8').subarray(0, 100);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(0x8, payload);
}

const err = (code, reason) => ({ error: { code, reason } });

/**
 * Wraps a raw TCP socket (post-handshake) as an event-emitting connection.
 * Emits: 'message' (string), 'close' (exactly once), 'error'
 */
class WSConnection extends EventEmitter {
  constructor(socket, opts, ip) {
    super();
    this.socket = socket;
    this.ip = ip;
    this.lastSeen = Date.now();
    this._opts = opts;
    this._buffer = Buffer.alloc(0);
    this._closed = false;        // no more sends, no more reads
    this._closeEmitted = false;
    this._windowStart = Date.now();
    this._windowCount = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    // Node's http server keeps sockets half-open (allowHalfOpen), so when the peer simply hangs up
    // ('end') nothing closes our side and 'close' never fires: a disconnected player would stay in the
    // game and the connection would be counted forever. Finish the close ourselves.
    socket.on('end', () => { this._closed = true; try { socket.end(); } catch (e) { /* ignore */ } });
    socket.on('close', () => this._onClose());
    socket.on('error', (e) => this.emit('error', e));
  }

  _onData(chunk) {
    if (this._closed) return;
    this._buffer = Buffer.concat([this._buffer, chunk]);
    // Loop in case several frames arrived in one TCP chunk.
    while (!this._closed) {
      const frame = this._parse(this._buffer);
      if (frame === null) return; // need more data
      if (frame.error) { this._shutdown(frame.error.code, frame.error.reason); return; }
      this._buffer = this._buffer.subarray(frame.totalLength);
      this._handleFrame(frame);
    }
    this._buffer = Buffer.alloc(0);
  }

  /** Returns null (need more bytes), { error: { code, reason } }, or a complete frame. */
  _parse(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;

    if (b0 & 0x70) return err(1002, 'reserved bits set');
    const known = opcode === 0x1 || opcode === 0x2 || opcode === 0x8 || opcode === 0x9 || opcode === 0xa;
    if (!known) return opcode === 0x0 ? err(1003, 'fragmented messages are not supported') : err(1002, 'unknown opcode');
    if (!fin && opcode < 0x8) return err(1003, 'fragmented messages are not supported');
    if ((b1 & 0x80) === 0) return err(1002, 'client frames must be masked');

    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this._opts.maxPayload)) return err(1009, 'message too big');
      len = Number(big);
      offset = 10;
    }
    if (opcode >= 0x8 && (!fin || len > 125)) return err(1002, 'bad control frame');
    // Judged from the header, before any payload is buffered.
    if (len > this._opts.maxPayload) return err(1009, 'message too big');

    if (buf.length < offset + 4 + len) return null; // incomplete (and bounded by maxPayload)
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    return { opcode, payload, totalLength: offset + len };
  }

  _overRate() {
    const now = Date.now();
    if (now - this._windowStart >= 1000) { this._windowStart = now; this._windowCount = 0; }
    this._windowCount++;
    return this._windowCount > this._opts.maxMessagesPerSec;
  }

  _handleFrame(frame) {
    this.lastSeen = Date.now();
    switch (frame.opcode) {
      case 0x1: // text
        if (this._overRate()) { this._shutdown(1008, 'too many messages'); return; }
        this.emit('message', frame.payload.toString('utf8'));
        break;
      case 0x2: // binary — unused by this protocol; it still counts toward the rate limit
        if (this._overRate()) this._shutdown(1008, 'too many messages');
        break;
      case 0x8: // close
        this._shutdown(1000, '');
        break;
      case 0x9: // ping -> pong with the same payload
        this._sendRaw(encodeFrame(0xa, frame.payload));
        break;
      default: // 0xA pong: lastSeen is all we needed
        break;
    }
  }

  _sendRaw(buf) {
    if (this._closed) return;
    try { this.socket.write(buf); } catch (e) { /* socket may already be gone */ }
  }

  send(obj) {
    if (this._closed) return;
    // A client that is not reading would otherwise make the server queue snapshots for it forever.
    if (this.socket.writableLength > this._opts.maxWriteBuffer) { this.terminate(); return; }
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this._sendRaw(encodeFrame(0x1, Buffer.from(str, 'utf8')));
  }

  ping() { this._sendRaw(encodeFrame(0x9, Buffer.alloc(0))); }

  /** Polite close: send a close frame, then end the socket (destroyed after 2s if the peer lingers). */
  _shutdown(code, reason) {
    if (this._closed) return;
    this._sendRaw(encodeClose(code, reason));
    this._closed = true;
    this._buffer = Buffer.alloc(0);
    try { this.socket.end(); } catch (e) { /* ignore */ }
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  close(code, reason) { this._shutdown(code || 1000, reason || ''); }

  /** Hard close for connections that are dead or abusive. */
  terminate() {
    this._closed = true;
    this._buffer = Buffer.alloc(0);
    this.socket.destroy();
  }

  _onClose() {
    this._closed = true;
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit('close');
  }
}

/**
 * Attaches WebSocket upgrade handling to an existing http.Server.
 * @param {http.Server} httpServer
 * @param {(conn: WSConnection, request: http.IncomingMessage) => void} onConnection
 * @param {object} [options]  any key of DEFAULTS
 * @returns {{ connectionCount(): number, close(): void }}
 */
function attachWebSocketServer(httpServer, onConnection, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const connections = new Set();
  const perIp = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    // An error before the handshake finishes (a reset, say) must not take the process down.
    socket.on('error', () => {});
    const reject = (status, text) => {
      try { socket.end('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch (e) { /* ignore */ }
      setTimeout(() => socket.destroy(), 1000).unref();
    };

    const key = req.headers['sec-websocket-key'];
    if (!key
      || String(req.headers['upgrade'] || '').toLowerCase() !== 'websocket'
      || req.headers['sec-websocket-version'] !== '13'
      || Buffer.from(String(key), 'base64').length !== 16) {
      reject(400, 'Bad Request');
      return;
    }
    if (opts.verifyOrigin && !opts.verifyOrigin(req)) { reject(403, 'Forbidden'); return; }

    const ip = opts.getIp ? opts.getIp(req) : (req.socket.remoteAddress || 'unknown');
    if (connections.size >= opts.maxConnections || (perIp.get(ip) || 0) >= opts.maxPerIp) {
      reject(503, 'Service Unavailable');
      return;
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKeyFor(key)}`,
      '', ''
    ].join('\r\n'));

    const conn = new WSConnection(socket, opts, ip);
    connections.add(conn);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    conn.once('close', () => {
      connections.delete(conn);
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    });

    onConnection(conn, req);
    if (head && head.length) conn._onData(head); // after the handlers exist, so nothing is lost
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const c of connections) {
      if (now - c.lastSeen > opts.idleTimeoutMs) c.terminate();
      else c.ping();
    }
  }, opts.pingIntervalMs);
  heartbeat.unref();

  return {
    connectionCount: () => connections.size,
    close() { clearInterval(heartbeat); for (const c of connections) c.terminate(); },
  };
}

module.exports = { attachWebSocketServer, WSConnection, DEFAULTS };
