# SlitherCash Multiplayer Server

An authoritative game server for SlitherCash. It runs the same simulation
logic as before (movement, bot AI, collision, orb economy, buy-in/cash-out)
but headless, at a fixed 30Hz tick, and broadcasts state to every connected
player over WebSocket. `slithercash.html` is now wired up to actually use
this — connecting, steering, and cashing out all go through the server.

**This is one server.** `index.js` both serves the game page (`slithercash.html`)
and handles the WebSocket connection, on one port. There's nothing else to
run or deploy separately.

## Folder layout it expects

```
slithercash/
  slithercash.html
  server/
    index.js        <- run this
    gameServer.js
    wsProtocol.js
    ...
```

## Running it

```
cd server
node index.js
```

Then open **http://localhost:8787** in your browser — that's the whole
game, served by the same process that's running the multiplayer server.
Right now, since it's just you, you'll see your own snake plus the 50
built-in bots. Anyone else who connects to that same URL joins the same
world.

Healthcheck: `GET /health` → `{"ok":true,"players":N,"bots":N}`

## Files

- `wsProtocol.js` — dependency-free WebSocket server (handshake + framing)
- `gameServer.js` — the authoritative simulation (`GameWorld` class)
- `index.js` — ties them together: connection handling, tick loop, broadcast
- `test-client.js` — single-client smoke test (join, steer, read snapshots)
- `test-multi.js` — three concurrent clients, shared-world + cash-out check

## Wire protocol

All messages are JSON text frames.

**Client → Server**

| Message | Fields | Notes |
|---|---|---|
| `join` | `name, buyin, skinIndex` | Must be sent first. Server assigns you an id. |
| `input` | `angle, boosting` | Send ~15-20×/sec. `angle` is radians, absolute (not delta). |
| `cashout` | — | Ends your run, banks your current value. |
| `ping` | `ts` | Server echoes it back in `pong` for RTT measurement. |

**Server → Client**

| Message | Fields | Notes |
|---|---|---|
| `welcome` | `id, cfg` | Sent once, right after `join`. `cfg` has `WORLD_RADIUS`, `LEN_PER_DOLLAR`, `TICK_RATE`. |
| `snapshot` | `youId, snakes[], orbs[], elapsed` | Broadcast every tick (30/sec) to joined clients only. |
| `death` | `killerName, buyin, bestRank, coinsEaten` | Sent once, when you die. |
| `cashout_result` | `amount, buyin, bestRank, coinsEaten` | Sent once, after a successful `cashout`. |
| `pong` | `ts` | Reply to `ping`. |

`snapshot.snakes[]` entries: `{id, name, x, y, angle, length, boosting, skinIndex, colorSeed, isPlayer}`.

Note there's no `points` array in the snapshot — full body trails aren't sent
over the wire to keep payloads small. The client rebuilds each snake's
visual trail locally from its head position over time (same technique the
original local simulation used), and interpolates between snapshots
(arriving at 30Hz) to render smoothly at 60fps.

## How this was tested

Since this sandbox has loopback networking (`127.0.0.1`) even though it has
no outbound internet access, I could actually run the server and connect
real WebSocket clients to it — not just review the code by eye. Concretely:

1. `test-client.js` — one client joins, sends 120 input updates over 4
   seconds, and verifies it receives a `welcome`, a steady stream of
   snapshots at the expected rate, and that its own position/angle in the
   snapshot actually reflects its input.
2. `test-multi.js` — three independent clients (different names and
   buy-ins: $5, $20, $1) join concurrently, verifies all three see each
   other in the same world snapshot (proving shared authoritative state,
   not three separate simulations), then each calls `cashout` and the test
   verifies the dollar amount returned is correct for each one individually.

Running `test-multi.js` the first time actually caught a real bug: the
server was clearing its internal session-to-player mapping *before* it had
delivered the `cashout_result` message, so cash-outs silently never reached
the client. Fixed in `index.js` (see the comment on the `cashout` case) and
re-verified — both tests pass now.

After wiring `slithercash.html` up to actually use this protocol, I also ran
the real client code (extracted from the HTML file) against a real running
server with a mocked DOM/canvas but a genuine WebSocket connection — not a
simulation of the client, the actual code. It connects, joins, receives live
snapshots, renders (HUD/rank update correctly), and cashes out with the
correct dollar amount matching the wallet balance afterward.

You can re-run either test yourself:
```
node index.js &
node test-client.js
node test-multi.js
```

## Deployment (Railway / Render / Fly)

1. Push this `server/` directory to a GitHub repo (or a `server/` subfolder
   of your existing repo).
2. Create a new service pointing at it, start command `node index.js`.
3. Set the `PORT` env var if the platform requires a specific one (most
   inject `PORT` automatically and this code already reads `process.env.PORT`).
4. Once deployed, the platform gives you an HTTPS URL — your WebSocket URL
   is the same host with `wss://` instead of `https://`.
5. Point your domain's subdomain (e.g. `server.yourdomain.com`) at it via
   CNAME, per the earlier deployment discussion.
6. Since npm access will work on these platforms, consider swapping
   `wsProtocol.js` for the `ws` package at this point — add it to
   `package.json`, `npm install ws`, and re-point `attachWebSocketServer`
   accordingly. Not required, just worth knowing it's an option.

## Known limitations to fix before this handles real load

- **No interest management**: every client gets every snake and every orb,
  every tick. Fine for testing and for a few dozen players; once you have a
  genuinely large `WORLD_RADIUS` and player count, only send each client
  the entities near them.
- **No reconnect/session resume**: if a client's WebSocket drops, they lose
  their snake entirely (same as it dying). Reasonable for v1, but worth
  revisiting.
- **Single process, single room**: this handles one world. Scaling to many
  concurrent rooms means running multiple instances of this and adding a
  matchmaking/room-assignment layer in front.
- **No auth**: anyone who can reach the WebSocket endpoint can join with any
  name/buyin they claim. Fine while `buyin` is just a display number with no
  real money behind it — revisit before any real-value integration.
