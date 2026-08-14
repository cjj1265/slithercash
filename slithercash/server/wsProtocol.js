// wsProtocol.js
//
// A minimal, dependency-free WebSocket server (RFC 6455) built directly on
// Node's built-in `http` and `crypto` modules.
//
// Why not just use the `ws` npm package? You should, in production — it's
// better tested and handles more edge cases. This exists because this
// sandbox has no outbound network access to npm's registry, so `npm install`
// isn't possible here. Writing the protocol by hand also means this file has
// zero dependencies, so it'll run on any bare Node host with no install step
// at all. Once you deploy to Railway/Render/Fly (which DO have internet
// access), swapping this for `ws` is a reasonable upgrade — this file's
// public API (`WSConnection`: .send/.on('message')/.on('close')/.close())
// is intentionally shaped to make that swap easy later.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKeyFor(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

/** Encode a text frame (server->client frames are never masked, per spec). */
function encodeTextFrame(payloadStr) {
  const payload = Buffer.from(payloadStr, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN=1, opcode=1 (text)
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame() {
  return Buffer.from([0x88, 0x00]);
}

function encodePongFrame() {
  return Buffer.from([0x8A, 0x00]);
}

/**
 * Wraps a raw TCP socket (post-handshake) as an event-emitting connection.
 * Emits: 'message' (string), 'close', 'error'
 */
class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this._buffer = Buffer.alloc(0);
    this._closed = false;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => this.emit('error', err));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._drainFrames();
  }

  _drainFrames() {
    // Loop in case multiple frames arrived in one TCP chunk.
    while (true) {
      const frame = this._tryParseFrame(this._buffer);
      if (!frame) return; // need more data
      this._buffer = this._buffer.subarray(frame.totalLength);
      this._handleFrame(frame);
    }
  }

  _tryParseFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null; // incomplete

    let payload = buf.subarray(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    }

    return { fin, opcode, payload, totalLength: offset + payloadLen };
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case 0x1: // text
        this.emit('message', frame.payload.toString('utf8'));
        break;
      case 0x2: // binary — unused by this protocol, ignore
        break;
      case 0x8: // close
        this._sendRaw(encodeCloseFrame());
        this.socket.end();
        break;
      case 0x9: // ping
        this._sendRaw(encodePongFrame());
        break;
      case 0xA: // pong
        break;
      default:
        break;
    }
  }

  _sendRaw(buf) {
    if (this._closed) return;
    try { this.socket.write(buf); } catch (e) { /* socket may already be gone */ }
  }

  send(obj) {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this._sendRaw(encodeTextFrame(str));
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._sendRaw(encodeCloseFrame());
    this.socket.end();
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    this.emit('close');
  }
}

/**
 * Attaches WebSocket upgrade handling to an existing http.Server.
 * @param {http.Server} httpServer
 * @param {(conn: WSConnection, request: http.IncomingMessage) => void} onConnection
 */
function attachWebSocketServer(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const acceptKey = acceptKeyFor(key);
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '', ''
    ].join('\r\n');
    socket.write(responseHeaders);

    const conn = new WSConnection(socket);
    if (head && head.length) conn._onData(head);
    onConnection(conn, req);
  });
}

module.exports = { attachWebSocketServer, WSConnection };
