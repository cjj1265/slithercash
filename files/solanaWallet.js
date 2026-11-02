// solanaWallet.js
//
// Devnet deposit / withdraw plumbing for SlitherCash.
//
// Money model
//   * 1 SOL = 100 game credits ("$" in the UI), so a $5 buy-in is 0.05 SOL.
//   * Balances are stored server-side as integer lamports (never floats) in a
//     JSON file on disk. The server is the only authority on them — nothing
//     in here ever takes an amount from a client except for withdrawals,
//     which are checked against the stored balance.
//
// Deposits
//   * Every player gets their own deposit address, derived from a master seed
//     plus their playerId, so a transfer can be attributed with no memo.
//   * Because deposits land on those per-player addresses (not on the game
//     wallet itself), the poller watches the per-player addresses, reads the
//     real amount from the on-chain transaction, credits it once (processed
//     signatures are persisted), then sweeps the funds into the game wallet
//     so withdrawals can be paid from one place.
//
// Identity
//   * A playerId is only handed out after the caller proves they own a Solana
//     wallet by signing a one-time challenge (createLoginChallenge /
//     completeLogin). It is derived from the wallet's public key with a server
//     secret, so it is unguessable and the same wallet always gets the same
//     balance back. Withdrawals can only go to that same wallet.
//
// Env (secrets only ever come from here):
//   GAME_WALLET_SECRET   JSON array of the game wallet's 64-byte secret key (required)
//   DEPOSIT_MASTER_SEED  long random string used to derive deposit addresses
//                        (strongly recommended; falls back to a key derived from
//                        GAME_WALLET_SECRET, in which case rotating the game
//                        wallet changes every deposit address)
//   SOLANA_RPC_URL       default https://api.devnet.solana.com
//   WALLET_DATA_FILE     where balances live. On Render this MUST point at a
//                        persistent disk mount (e.g. /var/data/wallet-data.json) —
//                        the default folder is wiped on every deploy.
//   DEPOSIT_POLL_MS      default 30000

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, SendTransactionError, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const DATA_FILE = process.env.WALLET_DATA_FILE || path.join(__dirname, 'wallet-data.json');
const LEDGER_FILE = DATA_FILE + '.ledger.jsonl';
const POLL_MS = Number(process.env.DEPOSIT_POLL_MS) || 30000;

const CREDITS_PER_SOL = 100;
const MIN_DEPOSIT_LAMPORTS = 10000000;   // 0.01 SOL — anything smaller is logged and not credited
const MIN_WITHDRAW_LAMPORTS = 1000000;   // 0.001 SOL — also keeps a brand-new destination above rent-exemption
const TX_FEE_LAMPORTS = 5000;            // base fee for a one-signature transfer
const HOUSE_RESERVE_LAMPORTS = 1000000;  // the game wallet must keep this much after a payout
const HISTORY_GRACE_SEC = 30;            // clock-skew allowance when comparing block time to registration time
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 5000;

class WalletError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

/* ============================== state ============================== */

let enabled = false;
let connection = null;
let game = null;          // Keypair of the game wallet
let masterKey = null;     // Buffer used to derive deposit keypairs and playerIds
let pollTimer = null;
let polling = false;

// Persisted. players[playerId] = { owner, address, lamports, lastSig, needsSweep, createdAt }
// withdrawals[`${playerId}:${idempotencyKey}`] = { ..., status: pending|sending|completed|refunded }
let store = { version: 1, players: {}, processedSignatures: [], withdrawals: {} };
const processed = new Set();            // every signature already credited or deliberately skipped
const inflight = new Set();             // withdrawal keys currently being driven by withdraw()
const challenges = new Map();           // nonce -> { publicKey, message, expires }

/* ============================== persistence / logging ============================== */

function loadStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) return;
  // A parse failure throws on purpose: carrying on with an empty store and then
  // saving would overwrite every player's balance.
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  store = {
    version: 1,
    players: parsed.players || {},
    processedSignatures: parsed.processedSignatures || [],
    withdrawals: parsed.withdrawals || {},
  };
  for (const sig of store.processedSignatures) processed.add(sig);
}

function save() {
  store.processedSignatures = Array.from(processed);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA_FILE); // atomic swap, so a crash never leaves a half-written file
}

function ledger(type, fields) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), type }, fields));
  console.log('[ledger] ' + line);
  try { fs.appendFileSync(LEDGER_FILE, line + '\n'); }
  catch (e) { console.error('[wallet] could not append to ledger file:', e.message); }
}

/* ============================== conversions / helpers ============================== */

function solToLamports(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n < 0) throw new WalletError('bad_amount', 'Invalid amount');
  const lamports = Math.round(n * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(lamports)) throw new WalletError('bad_amount', 'Invalid amount');
  return lamports;
}
function lamportsToSol(lamports) { return lamports / LAMPORTS_PER_SOL; }
function lamportsToCredits(lamports) { return lamportsToSol(lamports) * CREDITS_PER_SOL; }

const PLAYER_ID_RE = /^[a-f0-9]{64}$/;

function requireEnabled() {
  if (!enabled) throw new WalletError('wallet_disabled', 'Solana wallet is not configured on this server', 503);
}
function requirePlayer(playerId) {
  requireEnabled();
  const p = typeof playerId === 'string' && PLAYER_ID_RE.test(playerId) ? store.players[playerId] : null;
  if (!p) throw new WalletError('unknown_player', 'Unknown player — connect your wallet first', 401);
  return p;
}

function hmac(label, value) {
  return crypto.createHmac('sha256', masterKey).update(label + ':' + value).digest();
}
function deriveDepositKeypair(playerId) {
  return Keypair.fromSeed(hmac('deposit', playerId));
}
function playerIdForWallet(publicKeyBase58) {
  return hmac('player', publicKeyBase58).toString('hex');
}
function balanceOf(player) {
  return { lamports: player.lamports, sol: lamportsToSol(player.lamports), credits: lamportsToCredits(player.lamports) };
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of bytes) { if (byte === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/* ============================== login (proof of wallet ownership) ============================== */

function createLoginChallenge(publicKeyBase58) {
  requireEnabled();
  let pk;
  try { pk = new PublicKey(String(publicKeyBase58)).toBase58(); }
  catch (e) { throw new WalletError('bad_address', 'Invalid wallet address'); }

  const now = Date.now();
  if (challenges.size >= MAX_CHALLENGES) {
    for (const [nonce, c] of challenges) if (c.expires < now) challenges.delete(nonce);
    if (challenges.size >= MAX_CHALLENGES) throw new WalletError('busy', 'Too many pending logins, try again shortly', 429);
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = 'SlitherCash devnet login\nWallet: ' + pk + '\nNonce: ' + nonce + '\nIssued: ' + new Date(now).toISOString();
  challenges.set(nonce, { publicKey: pk, message, expires: now + CHALLENGE_TTL_MS });
  return { message, nonce };
}

// ed25519 public key (32 raw bytes) wrapped in the fixed SPKI header Node expects.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function completeLogin(publicKeyBase58, message, signatureBase64) {
  requireEnabled();
  const badLogin = () => new WalletError('bad_signature', 'Wallet signature could not be verified', 401);
  if (typeof message !== 'string' || typeof signatureBase64 !== 'string') throw badLogin();

  const m = /Nonce: ([a-f0-9]{32})/.exec(message);
  const challenge = m ? challenges.get(m[1]) : null;
  if (!challenge) throw badLogin();
  challenges.delete(m[1]); // single use, whatever happens next
  if (challenge.expires < Date.now() || challenge.message !== message) throw badLogin();

  let pk;
  try { pk = new PublicKey(String(publicKeyBase58)); } catch (e) { throw badLogin(); }
  if (pk.toBase58() !== challenge.publicKey) throw badLogin();

  const sig = Buffer.from(signatureBase64, 'base64');
  if (sig.length !== 64) throw badLogin();
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pk.toBytes())]), format: 'der', type: 'spki' });
    ok = crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch (e) { ok = false; }
  if (!ok) throw badLogin();

  const owner = pk.toBase58();
  const playerId = playerIdForWallet(owner);
  if (!store.players[playerId]) {
    store.players[playerId] = {
      owner,
      address: deriveDepositKeypair(playerId).publicKey.toBase58(),
      lamports: 0,
      lastSig: null,
      needsSweep: false,
      createdAt: Date.now(),
    };
    save();
    ledger('player_registered', { owner, address: store.players[playerId].address });
  }
  return { playerId, owner, address: store.players[playerId].address };
}

function isKnownPlayer(playerId) {
  return enabled && typeof playerId === 'string' && PLAYER_ID_RE.test(playerId) && !!store.players[playerId];
}

/* ============================== balances ============================== */

function getPlayerDepositAddress(playerId) {
  return requirePlayer(playerId).address;
}

function getPlayerBalance(playerId) {
  return balanceOf(requirePlayer(playerId));
}

/** Add SOL to a player's stored balance (game winnings, etc). Deposits go through the poller. */
function creditPlayer(playerId, sol) {
  const player = requirePlayer(playerId);
  const lamports = solToLamports(sol);
  if (lamports === 0) return balanceOf(player);
  player.lamports += lamports;
  save();
  return balanceOf(player);
}

/** Remove SOL from a player's stored balance. Throws insufficient_balance rather than going negative. */
function deductPlayer(playerId, sol) {
  const player = requirePlayer(playerId);
  const lamports = solToLamports(sol);
  if (lamports > player.lamports) throw new WalletError('insufficient_balance', 'Not enough balance', 402);
  if (lamports === 0) return balanceOf(player);
  player.lamports -= lamports;
  save();
  return balanceOf(player);
}

async function getGameBalance() {
  requireEnabled();
  const lamports = await connection.getBalance(game.publicKey, 'confirmed');
  return { address: game.publicKey.toBase58(), lamports, sol: lamportsToSol(lamports) };
}

/* ============================== withdrawals ============================== */

function withdrawalResult(rec, player) {
  return {
    status: rec.status,
    signature: rec.signature || null,
    lamports: rec.lamports,
    sol: lamportsToSol(rec.lamports),
    error: rec.error || null,
    balance: balanceOf(player),
  };
}

function completeWithdrawal(rec) {
  if (rec.status !== 'sending') return;
  rec.status = 'completed';
  rec.updatedAt = Date.now();
  save();
  ledger('withdraw_ok', { playerId: rec.playerId, to: rec.to, lamports: rec.lamports, signature: rec.signature });
}

function refundWithdrawal(rec, reason) {
  if (rec.status !== 'pending' && rec.status !== 'sending') return;
  const player = store.players[rec.playerId];
  player.lamports += rec.lamports;
  rec.status = 'refunded';
  rec.error = String(reason).slice(0, 200);
  rec.updatedAt = Date.now();
  save();
  ledger('withdraw_refund', { playerId: rec.playerId, to: rec.to, lamports: rec.lamports, signature: rec.signature, reason: rec.error });
}

/**
 * Decide what really happened to a signed withdrawal by asking the chain.
 * Only refunds once the transaction is known to have failed, or its blockhash
 * has expired so it can never land — otherwise the player could be paid twice.
 */
async function settleWithdrawal(rec) {
  try {
    const res = await connection.getSignatureStatuses([rec.signature], { searchTransactionHistory: true });
    const st = res.value[0];
    if (st) {
      if (st.err) { refundWithdrawal(rec, 'Transaction failed on-chain'); return; }
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') { completeWithdrawal(rec); return; }
      return; // seen but not confirmed yet
    }
    const height = await connection.getBlockHeight('confirmed');
    if (height > rec.lastValidBlockHeight) refundWithdrawal(rec, 'Transaction expired before landing');
  } catch (e) {
    console.error('[wallet] could not settle withdrawal ' + rec.signature + ':', e.message);
  }
}

async function sendWithdrawal(rec) {
  let tx;
  try {
    const houseLamports = await connection.getBalance(game.publicKey, 'confirmed');
    if (houseLamports < rec.lamports + TX_FEE_LAMPORTS + HOUSE_RESERVE_LAMPORTS) {
      refundWithdrawal(rec, 'The game wallet is low on funds right now, try again later');
      return;
    }
    const latest = await connection.getLatestBlockhash('confirmed');
    tx = new Transaction({ feePayer: game.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight })
      .add(SystemProgram.transfer({ fromPubkey: game.publicKey, toPubkey: new PublicKey(rec.to), lamports: rec.lamports }));
    tx.sign(game);
    // Persist the signature BEFORE broadcasting so a crash mid-send can be
    // reconciled against the chain instead of guessed at.
    rec.signature = base58(tx.signature);
    rec.lastValidBlockHeight = latest.lastValidBlockHeight;
    rec.status = 'sending';
    save();
  } catch (e) {
    refundWithdrawal(rec, 'Could not prepare the withdrawal: ' + e.message); // nothing was broadcast
    return;
  }

  try {
    await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  } catch (e) {
    if (e instanceof SendTransactionError) { refundWithdrawal(rec, 'Transaction rejected: ' + e.message); return; } // failed simulation, never broadcast
    await settleWithdrawal(rec); // timeout or similar — it may or may not have gone out
    return;
  }

  try {
    const res = await connection.confirmTransaction(
      { signature: rec.signature, blockhash: tx.recentBlockhash, lastValidBlockHeight: rec.lastValidBlockHeight }, 'confirmed');
    if (res.value.err) refundWithdrawal(rec, 'Transaction failed on-chain');
    else completeWithdrawal(rec);
  } catch (e) {
    await settleWithdrawal(rec);
  }
}

/**
 * Pay `solAmount` from the game wallet to `playerAddress`.
 * opts: { playerId, idempotencyKey } — both required. The balance is deducted
 * first and refunded if the send fails; repeating an idempotencyKey returns the
 * original outcome instead of paying again.
 */
async function withdraw(playerAddress, solAmount, opts) {
  requireEnabled();
  const { playerId, idempotencyKey } = opts || {};
  const player = requirePlayer(playerId);
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
    throw new WalletError('bad_idempotency_key', 'Missing or invalid idempotencyKey');
  }
  let to;
  try { to = new PublicKey(String(playerAddress)).toBase58(); }
  catch (e) { throw new WalletError('bad_address', 'Invalid wallet address'); }
  if (to !== player.owner) throw new WalletError('address_mismatch', 'Funds can only be withdrawn to the wallet you connected with', 403);

  const lamports = solToLamports(solAmount);
  if (lamports < MIN_WITHDRAW_LAMPORTS) {
    throw new WalletError('below_minimum', 'Minimum withdrawal is ' + lamportsToSol(MIN_WITHDRAW_LAMPORTS) + ' SOL');
  }

  // Everything up to and including the deduction is synchronous, so two
  // simultaneous requests can neither overspend the balance nor reuse a key.
  const wkey = playerId + ':' + idempotencyKey;
  const existing = store.withdrawals[wkey];
  if (existing) {
    if (existing.lamports !== lamports || existing.to !== to) {
      throw new WalletError('idempotency_conflict', 'That idempotencyKey was already used for a different withdrawal', 409);
    }
    return withdrawalResult(existing, player);
  }
  if (player.lamports < lamports) throw new WalletError('insufficient_balance', 'Not enough balance', 402);

  player.lamports -= lamports;
  const rec = store.withdrawals[wkey] = {
    playerId, key: idempotencyKey, to, lamports,
    status: 'pending', signature: null, lastValidBlockHeight: null, error: null, createdAt: Date.now(),
  };
  save();
  ledger('withdraw_start', { playerId, to, lamports, sol: lamportsToSol(lamports) });

  inflight.add(wkey);
  try { await sendWithdrawal(rec); }
  finally { inflight.delete(wkey); }
  return withdrawalResult(rec, player);
}

/** Settle withdrawals left half-done by a crash or a slow confirmation. */
async function reconcileWithdrawals() {
  for (const [wkey, rec] of Object.entries(store.withdrawals)) {
    if (inflight.has(wkey)) continue;
    if (rec.status === 'pending') refundWithdrawal(rec, 'Interrupted before it was sent'); // signature was never persisted, so nothing went out
    else if (rec.status === 'sending') await settleWithdrawal(rec);
  }
}

/* ============================== deposits ============================== */

async function sweepToGameWallet(playerId) {
  const player = store.players[playerId];
  const kp = deriveDepositKeypair(playerId);
  const balance = await connection.getBalance(kp.publicKey, 'confirmed');
  if (balance <= TX_FEE_LAMPORTS) { player.needsSweep = false; save(); return; }

  const lamports = balance - TX_FEE_LAMPORTS;
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight })
    .add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: game.publicKey, lamports }));
  tx.sign(kp);
  const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  const res = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new Error('sweep failed on-chain: ' + JSON.stringify(res.value.err));

  player.needsSweep = false;
  save();
  ledger('sweep', { playerId, from: kp.publicKey.toBase58(), lamports, signature });
}

/** Net lamports received by `address` in a transaction, read from the chain (never from a request). */
function lamportsReceived(tx, address) {
  const keys = tx.transaction.message.accountKeys;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].pubkey.toBase58() === address) return tx.meta.postBalances[i] - tx.meta.preBalances[i];
  }
  return 0;
}

async function scanPlayerDeposits(playerId) {
  const player = store.players[playerId];
  const address = new PublicKey(player.address);

  // Newest-first pages of signatures newer than the last one we handled.
  const found = [];
  let before;
  for (;;) {
    const page = await connection.getSignaturesForAddress(
      address, { until: player.lastSig || undefined, before, limit: 100 }, 'finalized');
    found.push(...page);
    if (page.length < 100) break;
    before = page[page.length - 1].signature;
  }

  // Oldest first, so lastSig only ever advances over a fully handled prefix.
  for (const info of found.reverse()) {
    if (processed.has(info.signature)) { player.lastSig = info.signature; continue; }
    if (info.err) { processed.add(info.signature); player.lastSig = info.signature; save(); continue; }

    const tx = await connection.getParsedTransaction(info.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.meta) return; // RPC hasn't indexed it yet — pick it up next poll

    const lamports = lamportsReceived(tx, player.address);
    processed.add(info.signature);
    player.lastSig = info.signature;

    // An address's chain history outlives our records. If the store was ever lost, the
    // player re-registers with a fresh createdAt, and anything that landed before then
    // was already credited (and usually withdrawn) under the old records — crediting it
    // again would pay it out twice.
    if (tx.blockTime && tx.blockTime < Math.floor(player.createdAt / 1000) - HISTORY_GRACE_SEC) {
      save();
      if (lamports > 0) {
        ledger('deposit_ignored_before_registration', { playerId, address: player.address, signature: info.signature, lamports });
      }
      continue;
    }

    if (lamports >= MIN_DEPOSIT_LAMPORTS) {
      player.lamports += lamports;
      player.needsSweep = true;
      save(); // balance and processed-signature set go to disk together
      ledger('deposit', {
        playerId, address: player.address, signature: info.signature,
        lamports, sol: lamportsToSol(lamports), credits: lamportsToCredits(lamports),
      });
    } else {
      save();
      if (lamports > 0) {
        ledger('deposit_rejected_dust', { playerId, address: player.address, signature: info.signature, lamports });
      }
    }
  }
}

async function pollDeposits() {
  if (!enabled || polling) return;
  polling = true;
  try {
    await reconcileWithdrawals();

    const ids = Object.keys(store.players);
    const active = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const infos = await connection.getMultipleAccountsInfo(
        chunk.map((id) => new PublicKey(store.players[id].address)), 'finalized');
      infos.forEach((info, j) => { if (info && info.lamports > 0) active.add(chunk[j]); });
    }
    for (const id of ids) if (store.players[id].needsSweep) active.add(id);

    for (const id of active) {
      try {
        await scanPlayerDeposits(id);
        if (store.players[id].needsSweep) await sweepToGameWallet(id);
      } catch (e) {
        console.error('[wallet] deposit scan failed for ' + store.players[id].address + ':', e.message);
      }
    }
  } catch (e) {
    console.error('[wallet] deposit poll failed:', e.message);
  } finally {
    polling = false;
  }
}

/* ============================== lifecycle ============================== */

function init() {
  const raw = process.env.GAME_WALLET_SECRET;
  if (!raw) {
    console.log('[wallet] GAME_WALLET_SECRET not set — Solana wallet disabled, practice mode only');
    return false;
  }
  if (/mainnet/i.test(RPC_URL) && process.env.ALLOW_MAINNET !== '1') {
    console.error('[wallet] SOLANA_RPC_URL looks like mainnet. This build is devnet-only; set ALLOW_MAINNET=1 to override. Wallet disabled.');
    return false;
  }
  try {
    const secret = JSON.parse(raw);
    if (!Array.isArray(secret) || secret.length !== 64) throw new Error('expected a JSON array of 64 numbers');
    game = Keypair.fromSecretKey(Uint8Array.from(secret));

    const seed = process.env.DEPOSIT_MASTER_SEED;
    if (!seed || seed.length < 16) {
      console.warn('[wallet] DEPOSIT_MASTER_SEED not set (or too short) — deriving it from GAME_WALLET_SECRET. Set a dedicated one before real use.');
    }
    masterKey = crypto.createHash('sha256').update('slithercash/master/v1\0' + (seed && seed.length >= 16 ? seed : Buffer.from(game.secretKey).toString('base64'))).digest();

    loadStore();
    connection = new Connection(RPC_URL, 'confirmed');
    enabled = true;
  } catch (e) {
    console.error('[wallet] startup failed, wallet disabled:', e.message);
    enabled = false;
    return false;
  }

  console.log('[wallet] enabled on ' + RPC_URL);
  console.log('[wallet] game wallet: ' + game.publicKey.toBase58());
  console.log('[wallet] data file: ' + DATA_FILE);
  getGameBalance().then((b) => console.log('[wallet] game wallet balance: ' + b.sol + ' SOL'))
    .catch((e) => console.error('[wallet] could not read game wallet balance:', e.message));

  setTimeout(pollDeposits, 2000);
  pollTimer = setInterval(pollDeposits, POLL_MS);
  return true;
}

function shutdown() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = {
  init,
  shutdown,
  isEnabled: () => enabled,
  WalletError,
  CREDITS_PER_SOL,
  MIN_DEPOSIT_SOL: lamportsToSol(MIN_DEPOSIT_LAMPORTS),
  MIN_WITHDRAW_SOL: lamportsToSol(MIN_WITHDRAW_LAMPORTS),
  createLoginChallenge,
  completeLogin,
  isKnownPlayer,
  getPlayerDepositAddress,
  getPlayerBalance,
  creditPlayer,
  deductPlayer,
  withdraw,
  getGameBalance,
  logLedger: ledger,
  pollDeposits, // exposed for tests
};
