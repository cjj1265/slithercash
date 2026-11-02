# SnakePay: guide for a code reviewer

This is for someone reviewing the money-handling code before real funds are put through it. It says what the system is, how money moves, what protects it, what is tested, and where I think the weak spots are. Line numbers are approximate and drift as the code changes; function names are the stable reference.

**Status:** runs on Solana **devnet** (play money) only. It has never run on mainnet. The server refuses to start the wallet on mainnet unless several conditions are met (see "Network guard").

## What it is

A browser snake game with a stake (the project's original name, SlitherCash, survives in file names and one key-derivation label). Players deposit SOL, buy in with part of their balance, play on a server-authoritative map, cash out, and withdraw. One Node process serves everything. There is no database; state is one JSON file plus an append-only ledger file.

| File | Role |
|---|---|
| `files/solanaWallet.js` | **All the money logic.** Balances, deposits, withdrawals, fee, limits, pause, solvency, alerts. Start here. |
| `files/index.js` | HTTP API (`/api/*`), admin (`/admin`), WebSocket game sessions. Wires the game to the wallet. |
| `files/gameServer.js` | Game simulation (`GameWorld`). Movement, collisions, orbs, death, cash-out value. |
| `files/wsProtocol.js` | A hand-written, hardened WebSocket server (no `ws` package): message size and rate limits, origin check, connection caps, heartbeat, slow-reader cutoff. |
| `files/slithercash.html` | The client. Displays state and asks the server to act; it is not trusted for amounts. |
| `files/admin.html` | Admin dashboard (token-protected). |
| `files/tests/` | Test suites and a simulated Solana RPC. |

## Units

- Balances are stored as **integer lamports**, never floats.
- 1 SOL = 100 game credits (`CREDITS_PER_SOL`). On **devnet** (play money) credits are shown as "$": a $5 buy-in is 0.05 SOL.
- On **mainnet** credits are an internal unit only: the page and server messages show real SOL (for example `◎0.050`) and never a dollar figure, because the server cannot know SOL's price. "1 SOL = $100" is a play-money rule, not a price. Practice play (no wallet connected) always shows play-money "$".
- Conversions are at the edges (`solToLamports`, `lamportsToCredits`); credits are floats inside the game simulation.

## How money moves

**1. Identity (login).** `createLoginChallenge` / `completeLogin` (`solanaWallet.js:250`, `:270`). The server issues a one-time message; the wallet signs it with ed25519; the server verifies with Node `crypto`. The `playerId` is `HMAC(masterKey, "player:" + publicKey)`, an unguessable bearer secret derived from the wallet, so the same wallet always gets the same balance back. Challenges are single-use and expire in 5 minutes. The `playerId` is the only credential for balance reads, buy-ins and withdrawals.

**2. Deposit.** Each player has their own deposit address: `Keypair.fromSeed(HMAC(masterKey, "deposit:" + playerId))`. The poller (`pollDeposits` `:776`, every 30s):
- finds registered addresses holding lamports (finalized commitment),
- `scanPlayerDeposits` (`:720`) fetches new signatures and reads each transaction; **the amount comes from the on-chain balance change, never from a request**,
- ignores deposits below 0.01 SOL, and ignores deposits dated before the player's registration (a wiped-store safeguard, see "Past incidents"),
- adds the credit and the signature to a persisted `processed` set in one `save()`,
- then `sweepToGameWallet` (`:689`) moves the funds into the game wallet. The sweep fee (5000 lamports) is paid out of the deposit.

The page can also ask for an on-demand check of **one** player's deposit (`POST /api/check-deposit`, `checkPlayerDepositNow`), which it does every 4s while the deposit window is open and for 3 minutes after. It takes the same `polling` lock as the poller, so a deposit can never be scanned by both at once (a double credit otherwise); if the poller is busy the caller just gets the current balance. It is rate limited to 20 a minute per player.

**3. Buy-in.** WebSocket `join` with a `walletId` (`index.js:368`). `assertCanBuyIn` (pause + $20 cap), then `deductPlayer` synchronously, then the player is placed in the **real-money world**. No `walletId` means free practice play in a separate world.

**4. Play.** `GameWorld` is authoritative; the client sends only steering and a boost flag. Two rules keep value conserved:
- boosting burns 1.4 length and drops an orb worth exactly that (`gameServer.js:186-190`);
- `_kill` (`:324`) drops the dead snake's **entire** length as orbs.

So the total value in a world (`totalValue`, `:98`) never increases. It can only decrease when the 700-orb cap trims old orbs.

**5. Cash-out.** `requestCashout` queues an event; `drainEvents` (`index.js:435`) calls `settleCashout` (`solanaWallet.js:340`), which credits the amount minus the **house fee**: `RAKE_PERCENT` (default 5) of the profit above the buy-in; nothing if cashing out at or below the buy-in. The credit does not depend on the socket still being open. Dropping the connection mid-game **forfeits** the stake.

**6. Withdrawal.** `withdraw` (`:599`). Everything up to and including the balance deduction is **synchronous**, so concurrent requests cannot overspend or reuse a key. Checks, in order: idempotency key, destination equals the wallet that signed in, minimum 0.001 SOL, balance, pause, per-request cap, per-player 24h cap, global 24h cap. Then:
- deduct and persist a `pending` record;
- `sendWithdrawal` (`:552`): check the game wallet can pay, build and sign the transaction, **persist the signature before broadcasting**, send, confirm;
- on a definite failure, refund; on an ambiguous one, `settleWithdrawal` (`:536`) asks the chain and refunds only if the transaction failed or its blockhash expired;
- `reconcileWithdrawals` (`:668`) finishes anything left half-done after a crash.

**7. House earnings** (`withdrawEarnings`, admin only). The fees from cash-outs stay in the game wallet as surplus; `store.rakeLamports` counts them and `store.earningsTakenLamports` counts what has been taken. The admin page can send them to **`OWNER_ADDRESS` only**, an address set in the server environment: a request carries only an amount and an idempotency key, never a destination, so a stolen admin token still cannot redirect the money. Rules, in order: only fees collected and not yet taken; the site must not be paused; the wallet must be solvent on a fresh look at the chain; afterwards it must still hold `EARNINGS_RESERVE_SOL` (default 0.005) more than it owes players; one at a time. It then uses the same crash-safe send as player withdrawals (`sendWithdrawal`: signature persisted before broadcast, refund only on proven failure), marked `kind: 'earnings'` so it is excluded from the player daily caps and from the "owed" side of the solvency check, and it raises a Discord alert when it completes.

## What protects it

- **Limits** (env-configurable): $20 max buy-in; 0.2 SOL per withdrawal; 0.5 SOL per player per 24h; 2 SOL per 24h across everyone.
- **Pause switch** (`setPaused`): stops buy-ins and withdrawals, never stops crediting deposits or cash-outs. Persisted; `WALLET_PAUSED=1` forces it.
- **Solvency check** (`computeSolvency` `:398`, `checkSolvency` `:430`, every poll): `holds = game wallet + credited-but-unswept deposits`; `owes = player balances + value in play in the real world + withdrawals in flight`; network fees absorbed by the game wallet are added back. Two failures in a row auto-pause and alert.
- **Separate worlds:** practice players and bots hold value nobody paid for, so they live in a different `GameWorld` and never share a map with real-money players.
- **WebSocket hardening** (`wsProtocol.js`, wired in `index.js`): 4 KB maximum message, enforced from the frame header so nothing larger is ever buffered; 60 messages per second per connection; strict RFC 6455 rules (reserved bits, masking, known opcodes, small unfragmented control frames; fragmented data messages are refused); an Origin check so other websites cannot open game connections for a visitor; caps of 500 connections in total and 10 per IP; a 20s heartbeat that drops silent connections; a cutoff for clients that stop reading; a 10s deadline to join a game and 30s idle limit outside one. Player names are cleaned server-side (no markup, control or invisible formatting characters) and shown by the client as text only.
- **Alerts** (`ALERT_WEBHOOK_URL`, Discord/Slack): pause/resume, insolvency, low game wallet, daily cap hit, unconfirmed withdrawal over 10 minutes, repeated RPC failure, mainnet start.
- **Network guard** (`verifyNetworkThenStart` `:848`): the wallet stays disabled until the RPC's genesis hash identifies the network. Mainnet additionally needs `ALLOW_MAINNET=1`, a dedicated `DEPOSIT_MASTER_SEED`, and an alert webhook. Unknown networks are refused.
- **Persistence:** `save()` writes a temp file then renames; a corrupt store makes startup fail rather than start empty. Every deposit, sweep, buy-in, cash-out, withdrawal and pause event is appended to `<data file>.ledger.jsonl` with signatures.
- **Admin:** `/admin` only exists with `ADMIN_TOKEN` (20+ chars); constant-time comparison; failed attempts rate limited; player ids (bearer secrets) are never shown.

## Tests

From `files/` (Node 18+, after `npm install`):

```
npm run test:economy   # value conservation in the game simulation (seconds)
npm run test:fee       # cash-out fee maths and the earnings withdrawal rules, 24 checks (seconds)
npm run test:ws        # WebSocket attack tests against wsProtocol.js with a raw TCP client (seconds)
npm run test:wallet    # end-to-end: 128 checks, a few minutes
```

`test:ws` sends exactly what a hostile client would: oversized and lying frame headers, floods, unmasked and fragmented frames, reserved bits, bad opcodes, wrong origins, too many connections, silent connections and a client that stops reading.

`test:wallet` runs the real server against a **simulated chain** (`tests/fake-chain-lib.js`: it parses and signature-checks the transactions the wallet builds and applies transfers with fees and rent rules). It covers auth and replay, dust, no double credit, restart persistence, the wiped-store regression, limits, pause (including persistence), admin auth and rate limiting, alerts, world separation, solvency and auto-pause, crash recovery and refunds, the network guard, and a real two-player head-on fight ending in a cash-out with a fee.

**Not covered:** a real chain. The devnet faucet is closed to scripts, so the simulated chain stands in. Before the house fee and network guard were added, the flow was exercised by hand on real devnet with Phantom (deposit, play, cash-out, withdraw, limits, pause, two players, restart). The fee and the later changes have not yet been watched on a real network, and the automated suite never touches a real RPC.

## Past incidents (all fixed; worth knowing the shape)

1. **Boost printed money.** Burned 1.4 length, dropped 3.2 length of orb 80% of the time.
2. **Buy-ins under $1 cashed out at $1.** A length floor of 8 was worth more than a small stake.
3. **Wiped store re-credited old deposits.** After a restart without a persistent disk, the first scan of a deposit address read its entire on-chain history. Fixed by ignoring deposits older than the registration time.
4. **Practice snakes could feed real players.** They shared a map. Fixed with separate worlds.
5. **Death silently kept ~47% of a stake.** Replaced by an explicit, disclosed fee on profit.
6. **Stored XSS through player names.** The leaderboard built HTML from other players' names, so a hostile name could run script in every player's page and read the wallet id from the requests it makes. Fixed twice over: names are cleaned on the server, and the client sets them as text only.
7. **Disconnected players stayed in the game.** Node's http server keeps upgraded sockets half-open, so a client that hung up without a WebSocket close frame never produced a `close` event: the snake stayed on the map and the connection was counted forever. Found by the new WebSocket tests and fixed in `wsProtocol.js`.

## Known gaps and risks (my honest list)

- **Never run on mainnet**, and the automated tests use a simulated chain.
- **Hot wallet.** `GAME_WALLET_SECRET` is an environment variable on the host. Whoever gets it can drain the game wallet; the app's withdrawal limits do not apply to someone holding the key. The only mitigation is keeping the balance small.
- **Single instance only.** State lives in process memory plus one file. Two instances would double-process deposits and withdrawals. Render must run exactly one.
- **Volumetric denial of service** is handled by putting Cloudflare in front, not by this code. The server supports it: `TRUST_CLOUDFLARE` reads the real visitor address, and `ORIGIN_SECRET` refuses anything that did not come through Cloudflare. If `ORIGIN_SECRET` is not set while `TRUST_CLOUDFLARE` is on, a startup warning says so, because the address header could then be forged. The `onrender.com` address stays reachable only with the secret. Fragmented WebSocket messages are refused by design.
- **No collusion or multi-account detection.** Friends can feed each other (it is only a transfer, and the fee applies to profit), and nothing stops one person running many wallets.
- **Dust.** Deposits under 0.01 SOL are not credited but are swept into the game wallet along with the next real deposit, so the house keeps them.
- **RPC trust.** Deposit amounts come from the RPC's answer. A malicious or buggy RPC could misreport. Finalized commitment narrows but does not remove this.
- **Float credits in the simulation.** Lamports are exact, but the game works in float credits; conversions round to the nearest lamport.
- **Bearer secret.** The `playerId` is a bearer token held in the page's memory. Cross-site scripting on the page would expose it. Withdrawals can only go to the signing wallet, which limits what a stolen id can do.
- **Legal and compliance** are out of scope here and are the owner's responsibility.

## Where I would like a second opinion

1. Any path where a credit applies twice or a debit is skipped: the deposit scan, `drainEvents`/`settleCashout`, and the refund paths.
2. Withdrawal crash safety: is "persist the signature before broadcast; refund only when the chain proves failure or expiry" sound? In particular `settleWithdrawal` treating `getBlockHeight() > lastValidBlockHeight` as proof the transaction can never land.
3. The login flow: challenge parsing, replay, the `playerId` derivation, and the ed25519 verification in `completeLogin`.
4. The solvency formula and the fee add-back, and whether two consecutive failures is the right trigger.
5. The game economy: can a player extract more than their stake plus other players' stakes (simultaneous kills, wall deaths, the orb cap, boost edge cases, anything in `_kill` and `_resolveHeadOnCollisions`)?
6. `wsProtocol.js`: `_parse` (header checks before buffering), `_shutdown` / `terminate` / the `end` handler (every path must end in exactly one `close` event, because stake forfeiture depends on it), and the origin and cap logic in `attachWebSocketServer`.
7. The admin surface (`index.js:225`, `:239`).
8. Race conditions between the async withdrawal flow, the poller and the game tick, given everything runs on one event loop.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GAME_WALLET_SECRET` | none | JSON array of the game wallet's 64-byte secret key. Without it the wallet is off. |
| `DEPOSIT_MASTER_SEED` | derived from the wallet secret | Long random string for deriving deposit addresses and player ids. Required on mainnet. |
| `SOLANA_RPC_URL` | devnet public RPC | The network is read from the RPC itself. |
| `WALLET_DATA_FILE` | `files/wallet-data.json` | Balances. Must be on a persistent disk on Render. |
| `ADMIN_TOKEN` | none | 20+ chars; enables `/admin`. |
| `ALERT_WEBHOOK_URL` | none | Discord or Slack webhook. Required on mainnet. |
| `ALLOW_MAINNET` | unset | Must be `1` to run on mainnet. |
| `RAKE_PERCENT` | `5` | House fee as a percent of cash-out profit (0 to 50). |
| `OWNER_ADDRESS` | none | The only address house earnings can be withdrawn to. Without it the admin button is disabled. |
| `EARNINGS_RESERVE_SOL` | `0.005` | The game wallet must still hold this much more than it owes players after an earnings withdrawal. |
| `MAX_WITHDRAW_SOL` | `0.2` | Per withdrawal. |
| `MAX_PLAYER_DAILY_WITHDRAW_SOL` | `0.5` | Per player, rolling 24h. |
| `MAX_DAILY_WITHDRAW_SOL` | `2` | All players, rolling 24h. |
| `MAX_BUYIN_CREDITS` | `20` | Largest stake in $. |
| `LOW_WALLET_SOL` | `0.2` | Alert when the game wallet drops below this. |
| `INSOLVENCY_TOLERANCE_SOL` | `0.02` | Shortfall allowed before auto-pause. |
| `WALLET_PAUSED` | unset | `1` forces the pause on. |
| `DEPOSIT_POLL_MS` | `30000` | Deposit poll interval. |
| `TRUST_PROXY` | unset | `1` to rate limit by `X-Forwarded-For` behind Render. |
| `TRUST_CLOUDFLARE` | unset | `1` to use Cloudflare's `CF-Connecting-IP` as the visitor address for rate limits and connection caps. Ignored unless set, because anyone could send the header. |
| `ORIGIN_SECRET` | none | A long random string that Cloudflare adds to every request as `X-Origin-Secret`. When set, every request without it (except `/health`) gets a 403, including game connections, so the server cannot be reached around Cloudflare and the visitor-address header cannot be forged. |
| `CORS_ORIGIN` | none | Allowed origins for `/api` (same-origin needs none). |
| `WITHDRAW_RATE_MAX` | `6` | Withdraw requests per player per minute. |
| `NUM_BOTS` | `0` | Bots in the **practice** world only. |
| `WS_ALLOWED_ORIGINS` | none | Extra origins allowed to open game connections (the site's own host is always allowed). |
| `WS_MAX_CONNECTIONS` | `500` | Total WebSocket connections. |
| `WS_MAX_PER_IP` | `10` | WebSocket connections per IP address. |
| `WS_MAX_MESSAGES_PER_SEC` | `60` | Messages per connection per second. |
| `WS_JOIN_TIMEOUT_MS` | `10000` | A new connection must join a game within this long. |
| `WS_IDLE_LOBBY_MS` | `30000` | A connection outside a game is dropped after this long. |
