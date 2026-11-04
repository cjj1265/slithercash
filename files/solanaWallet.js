// solanaWallet.js
//
// Deposit / withdraw plumbing for SnakePay.
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
//   SOLANA_RPC_URL       default https://api.devnet.solana.com. The network is read from the RPC itself;
//                        on mainnet the wallet refuses to start unless ALLOW_MAINNET=1, a dedicated
//                        DEPOSIT_MASTER_SEED and ALERT_WEBHOOK_URL are all set.
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
const DAY_MS = 24 * 60 * 60 * 1000;
const STUCK_WITHDRAWAL_MS = 10 * 60 * 1000;
const WITHDRAWAL_KEEP_MS = 30 * DAY_MS;  // finished withdrawal records (idempotency keys) are pruned after this

// Safety limits. They bound what a bug, an exploit or a leaked key can take, so keep them small
// until the system has earned trust. All are env-configurable.
const envNum = (name, fallback) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : fallback; };
const LIMITS = {
  maxWithdrawLamports: Math.round(envNum('MAX_WITHDRAW_SOL', 0.2) * LAMPORTS_PER_SOL),               // per request
  maxPlayerDailyLamports: Math.round(envNum('MAX_PLAYER_DAILY_WITHDRAW_SOL', 0.5) * LAMPORTS_PER_SOL), // per player, rolling 24h
  maxGlobalDailyLamports: Math.round(envNum('MAX_DAILY_WITHDRAW_SOL', 2) * LAMPORTS_PER_SOL),        // everyone together, rolling 24h
  maxBuyinCredits: envNum('MAX_BUYIN_CREDITS', 20),                                                    // per game, in $
  lowWalletLamports: Math.round(envNum('LOW_WALLET_SOL', 0.2) * LAMPORTS_PER_SOL),                    // alert when the game wallet drops below
  insolvencyToleranceLamports: Math.round(envNum('INSOLVENCY_TOLERANCE_SOL', 0.02) * LAMPORTS_PER_SOL),
};
const ALERT_URL = process.env.ALERT_WEBHOOK_URL || '';

// The house fee: this percent of a cash-out's PROFIT (what it is worth above the buy-in). Cashing out
// at or below the buy-in costs nothing, and the stake itself is never touched. 0 turns it off.
let RAKE_PERCENT = (() => { const n = Number(process.env.RAKE_PERCENT); return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 5; })();
// How long a cash-out must be held (seconds). index.js copies it onto the game; the admin page can change it.
const envSeconds = (name, fallback) => (process.env[name] !== undefined && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback);
let cashoutHoldSec = envSeconds('CASHOUT_HOLD_SECONDS', 5);
let minPlaySec = envSeconds('MIN_PLAY_SECONDS', 10);          // a snake must have played this long before it can start a cash-out
let spawnProtectSec = envSeconds('SPAWN_PROTECT_SECONDS', 3); // a new snake cannot be killed (or kill) for this long

// The only address house earnings can ever be sent to. It comes from the environment, never from a request,
// so someone who got hold of the admin token still cannot redirect the money anywhere else.
const OWNER_ADDRESS = (() => {
  const v = process.env.OWNER_ADDRESS;
  if (!v) return null;
  try { return new PublicKey(v).toBase58(); }
  catch (e) { console.error('[wallet] OWNER_ADDRESS is not a valid address: earnings withdrawals are disabled'); return null; }
})();
// After taking earnings the game wallet must still hold this much more than it owes players.
const EARNINGS_RESERVE_LAMPORTS = Math.round(envNum('EARNINGS_RESERVE_SOL', 0.005) * LAMPORTS_PER_SOL);
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
let store = { version: 1, players: {}, processedSignatures: [], withdrawals: {}, paused: null, feesLamports: 0, rakeLamports: 0, earningsTakenLamports: 0, settings: {}, banned: {} };
let earningsBusy = false;               // one earnings withdrawal at a time
const GENESIS_NETWORKS = {
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};
let network = null;                     // 'devnet' | 'mainnet-beta' | 'testnet' | 'unknown', once verified
let shuttingDown = false;
let inPlayProvider = () => 0;           // () => credits currently in play in the real-money world (set by index.js)
let lastSolvency = null;
let solvencyFailures = 0;
let rpcFailures = 0;
const alertLast = new Map();
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
    paused: parsed.paused || null,
    feesLamports: parsed.feesLamports || 0,
    rakeLamports: parsed.rakeLamports || 0,
    earningsTakenLamports: parsed.earningsTakenLamports || 0,
    settings: parsed.settings || {},
    banned: parsed.banned || {},
  };
  for (const sig of store.processedSignatures) processed.add(sig);
  applyStoredSettings();
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

/* ============================== alerts / pause switch ============================== */

/** Post to ALERT_WEBHOOK_URL (Discord and Slack style). Repeats of the same key are muted for `minGapMs`. */
function sendAlert(key, message, minGapMs) {
  console.warn('[ALERT] ' + message);
  if (!ALERT_URL) return;
  const now = Date.now();
  if ((alertLast.get(key) || 0) + (minGapMs === undefined ? 10 * 60 * 1000 : minGapMs) > now) return;
  alertLast.set(key, now);
  const text = 'SnakePay: ' + message;
  fetch(ALERT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, text }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => console.error('[wallet] alert webhook failed:', e.message));
}

const envPaused = () => process.env.WALLET_PAUSED === '1';
function isPaused() { return envPaused() || !!store.paused; }
function getPauseInfo() {
  if (envPaused()) return { paused: true, reason: 'Forced by the WALLET_PAUSED environment variable', forcedByEnv: true };
  return store.paused ? { paused: true, forcedByEnv: false, at: store.paused.at, reason: store.paused.reason, by: store.paused.by } : { paused: false };
}

/**
 * Pausing stops new buy-ins and withdrawals. It never stops crediting: deposits and cash-outs
 * still land in balances, because that money belongs to players whatever state the site is in.
 */
function setPaused(paused, reason, by) {
  requireEnabled();
  store.paused = paused ? { at: Date.now(), reason: String(reason || 'manual').slice(0, 200), by: by || 'admin' } : null;
  save();
  ledger(paused ? 'paused' : 'resumed', { reason: store.paused ? store.paused.reason : null, by: by || 'admin' });
  sendAlert('pause-toggle:' + paused, paused ? 'PAUSED (' + (reason || 'manual') + ')' : 'Resumed', 0);
  return getPauseInfo();
}

/* ============================== admin settings / bans ============================== */

// What the admin page may change while the game runs. Each setting has hard bounds, so even a stolen admin
// token cannot raise a limit past them (the environment variables set the starting values, not these bounds).
const SETTING_DEFS = {
  maxBuyinCredits:   { label: 'Max buy-in ($ credits)',       min: 1,     max: 500, get: () => LIMITS.maxBuyinCredits,                            set: (v) => { LIMITS.maxBuyinCredits = v; } },
  maxWithdrawSol:    { label: 'Per withdrawal (SOL)',          min: 0.001, max: 5,   get: () => lamportsToSol(LIMITS.maxWithdrawLamports),          set: (v) => { LIMITS.maxWithdrawLamports = solToLamports(v); } },
  maxPlayerDailySol: { label: 'Per player per day (SOL)',      min: 0.001, max: 10,  get: () => lamportsToSol(LIMITS.maxPlayerDailyLamports),       set: (v) => { LIMITS.maxPlayerDailyLamports = solToLamports(v); } },
  maxGlobalDailySol: { label: 'All players per day (SOL)',     min: 0.001, max: 50,  get: () => lamportsToSol(LIMITS.maxGlobalDailyLamports),       set: (v) => { LIMITS.maxGlobalDailyLamports = solToLamports(v); } },
  lowWalletSol:      { label: 'Low-wallet alert at (SOL)',     min: 0.001, max: 100, get: () => lamportsToSol(LIMITS.lowWalletLamports),            set: (v) => { LIMITS.lowWalletLamports = solToLamports(v); } },
  rakePercent:       { label: 'House fee (% of profit)',       min: 0,     max: 20,  get: () => RAKE_PERCENT,                                       set: (v) => { RAKE_PERCENT = v; } },
  cashoutHoldSec:    { label: 'Cash-out hold (seconds)',       min: 0,     max: 30,  get: () => cashoutHoldSec,                                     set: (v) => { cashoutHoldSec = v; } },
  minPlaySec:        { label: 'Play before cash-out (seconds)', min: 0,    max: 120, get: () => minPlaySec,                                         set: (v) => { minPlaySec = v; } },
  spawnProtectSec:   { label: 'Spawn protection (seconds)',    min: 0,     max: 10,  get: () => spawnProtectSec,                                    set: (v) => { spawnProtectSec = v; } },
};

function currentSettings() {
  const out = {};
  for (const [k, d] of Object.entries(SETTING_DEFS)) out[k] = d.get();
  return out;
}
/** Current values with their labels and bounds, for the admin page. */
function getSettings() {
  const out = {};
  for (const [k, d] of Object.entries(SETTING_DEFS)) out[k] = { value: d.get(), min: d.min, max: d.max, label: d.label };
  return out;
}
function limitsConsistent(s) { return s.maxWithdrawSol <= s.maxPlayerDailySol && s.maxPlayerDailySol <= s.maxGlobalDailySol; }

/** Re-apply the saved settings on start-up. A saved value that no longer fits its bounds is ignored. */
function applyStoredSettings() {
  const saved = store.settings || {};
  const next = Object.assign(currentSettings(), {});
  for (const [k, v] of Object.entries(saved)) {
    const d = SETTING_DEFS[k];
    if (d && Number.isFinite(v) && v >= d.min && v <= d.max) next[k] = v;
  }
  if (!limitsConsistent(next)) return;
  for (const [k, d] of Object.entries(SETTING_DEFS)) if (next[k] !== d.get()) d.set(next[k]);
}

/** Change one or more settings. All or nothing; every change is logged and announced on the alert channel. */
function updateSettings(changes, by) {
  requireEnabled();
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new WalletError('bad_setting', 'No settings given');
  const before = currentSettings();
  const next = Object.assign({}, before);
  for (const [k, raw] of Object.entries(changes)) {
    const d = SETTING_DEFS[k];
    if (!d) throw new WalletError('bad_setting', 'Unknown setting: ' + k);
    const v = Number(raw);
    if (raw === '' || raw === null || !Number.isFinite(v) || v < d.min || v > d.max) throw new WalletError('bad_setting', d.label + ' must be between ' + d.min + ' and ' + d.max);
    next[k] = v;
  }
  if (!limitsConsistent(next)) throw new WalletError('bad_setting', 'Per withdrawal must not exceed per player per day, which must not exceed all players per day');
  const diff = {};
  for (const k of Object.keys(changes)) {
    if (next[k] === before[k]) continue;
    diff[k] = { from: before[k], to: next[k] };
    SETTING_DEFS[k].set(next[k]);
    store.settings[k] = next[k];
  }
  if (!Object.keys(diff).length) return getSettings();
  save();
  ledger('settings_changed', { changes: diff, by: by || 'admin' });
  sendAlert('settings-changed', 'Settings changed from the admin page: ' + Object.entries(diff).map(([k, c]) => SETTING_DEFS[k].label + ' ' + c.from + ' -> ' + c.to).join('; '), 0);
  return getSettings();
}

function ownerOf(playerId) { const p = store.players[playerId]; return p ? p.owner : null; }
/** A banned wallet can still sign in, see its balance and withdraw; it just cannot buy in. */
function isBanned(playerId) { const o = ownerOf(playerId); return !!(o && store.banned[o]); }
function banWallet(owner, reason, by) {
  requireEnabled();
  if (!Object.values(store.players).some((p) => p.owner === owner)) throw new WalletError('unknown_wallet', 'No player has that wallet address', 404);
  store.banned[owner] = { at: Date.now(), reason: String(reason || 'no reason given').slice(0, 200), by: by || 'admin' };
  save();
  ledger('wallet_banned', { owner, reason: store.banned[owner].reason, by: by || 'admin' });
  sendAlert('wallet-banned:' + owner, 'Wallet banned from playing: ' + owner.slice(0, 4) + '…' + owner.slice(-4) + ' (' + store.banned[owner].reason + ')', 0);
  return store.banned[owner];
}
function unbanWallet(owner, by) {
  requireEnabled();
  if (!store.banned[owner]) throw new WalletError('not_banned', 'That wallet is not banned', 404);
  delete store.banned[owner];
  save();
  ledger('wallet_unbanned', { owner, by: by || 'admin' });
  return true;
}
function listBans() {
  return Object.entries(store.banned).map(([owner, b]) => ({ owner, at: b.at, reason: b.reason, by: b.by })).sort((a, b) => b.at - a.at);
}

/** Parsed ledger lines. Only the last MAX bytes are read, so a very old, large file cannot slow the admin page down. */
function readLedgerEntries() {
  const MAX = 20 * 1024 * 1024;
  let text = '';
  try {
    const fd = fs.openSync(LEDGER_FILE, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, MAX);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
      if (size > MAX) text = text.slice(text.indexOf('\n') + 1); // drop the line cut in half
    } finally { fs.closeSync(fd); }
  } catch (e) { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch (e) { out.push({ raw: l }); } }
  return out;
}

/** Activity per day (UTC) for the last `days` days, and all-time counts, from the ledger. */
function dailyStats(entries, days) {
  const byDay = new Map();
  const dayKey = (ts) => String(ts).slice(0, 10);
  const get = (k) => { if (!byDay.has(k)) byDay.set(k, { date: k, games: 0, volumeSol: 0, cashouts: 0, feesSol: 0, depositsSol: 0, withdrawnSol: 0, newPlayers: 0, players: new Set() }); return byDay.get(k); };
  let games = 0, volumeSol = 0;
  for (const e of entries) {
    if (!e.ts || !e.type) continue;
    const d = get(dayKey(e.ts));
    if (e.type === 'buyin') { d.games++; d.volumeSol += (e.credits || 0) / CREDITS_PER_SOL; if (e.walletId) d.players.add(e.walletId); games++; volumeSol += (e.credits || 0) / CREDITS_PER_SOL; }
    else if (e.type === 'cashout') { d.cashouts++; d.feesSol += (e.feeCredits || 0) / CREDITS_PER_SOL; }
    else if (e.type === 'deposit') d.depositsSol += e.sol || 0;
    else if (e.type === 'withdraw_ok') d.withdrawnSol += (e.lamports || 0) / LAMPORTS_PER_SOL;
    else if (e.type === 'player_registered') d.newPlayers++;
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    const d = byDay.get(k) || get(k);
    out.push({ date: k, games: d.games, volumeSol: d.volumeSol, cashouts: d.cashouts, feesSol: d.feesSol, depositsSol: d.depositsSol, withdrawnSol: d.withdrawnSol, newPlayers: d.newPlayers, activePlayers: d.players.size });
  }
  return { days: out, totalGames: games, totalVolumeSol: volumeSol };
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
  // This is what the wallet shows when asking the player to sign, so it must say the truth about the network.
  const message = 'SnakePay login (' + (network === 'mainnet-beta' ? 'mainnet' : (network || 'devnet')) + ')\nWallet: ' + pk + '\nNonce: ' + nonce + '\nIssued: ' + new Date(now).toISOString();
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

/**
 * Credit a cash-out, keeping the house fee: RAKE_PERCENT of the profit (the amount above the buy-in).
 * Fee-free when the player cashes out at or below what they paid in. The fee simply stays in the
 * game wallet, so it shows up as surplus; rakeLamports is the running total for the admin page.
 */
function settleCashout(playerId, amountCredits, buyinCredits) {
  const player = requirePlayer(playerId);
  const grossLamports = Math.round(amountCredits / CREDITS_PER_SOL * LAMPORTS_PER_SOL);
  const buyinLamports = solToLamports(buyinCredits / CREDITS_PER_SOL);
  const profit = Math.max(0, grossLamports - buyinLamports);
  const feeLamports = Math.floor(profit * RAKE_PERCENT / 100);
  const netLamports = grossLamports - feeLamports;
  player.lamports += netLamports;
  store.rakeLamports += feeLamports;
  save();
  const result = {
    grossCredits: lamportsToCredits(grossLamports),
    feeCredits: lamportsToCredits(feeLamports),
    netCredits: lamportsToCredits(netLamports),
    feeLamports, balance: balanceOf(player),
  };
  ledger('cashout', { walletId: playerId, buyin: buyinCredits, credits: amountCredits, feeCredits: result.feeCredits, netCredits: result.netCredits });
  return result;
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

/** What clients may be told about the limits, so the UI can steer players before the server refuses them. */
function getPublicLimits() {
  return { maxWithdrawSol: lamportsToSol(LIMITS.maxWithdrawLamports), maxBuyin: LIMITS.maxBuyinCredits, rakePercent: RAKE_PERCENT };
}

/** Called before a wallet-backed buy-in. Throws if the site is paused or the stake is above the limit. */
function assertCanBuyIn(credits) {
  requireEnabled();
  if (isPaused()) throw new WalletError('paused', 'Play with real balance is temporarily paused. Your balance is safe.', 503);
  if (credits > LIMITS.maxBuyinCredits) throw new WalletError('over_limit', 'The maximum buy-in is ' + formatCredits(LIMITS.maxBuyinCredits), 403);
}

/**
 * Credits are an internal unit (1 SOL = CREDITS_PER_SOL). On devnet they are shown as play-money
 * dollars; on mainnet they are real SOL, so they are shown as SOL and never as a dollar figure the
 * server cannot know.
 */
function formatCredits(credits) {
  return network === 'mainnet-beta'
    ? '◎' + (credits / CREDITS_PER_SOL).toFixed(3)
    : '$' + credits;
}

function setInPlayProvider(fn) { inPlayProvider = fn; }

/**
 * Can the game wallet cover everything it owes?
 *   owed   = player balances + value in play in the real-money world + withdrawals already deducted but not yet sent
 *   holds  = game wallet + deposits that are credited but not yet swept
 * Value that leaves the world (dead snakes' orbs trimmed by the orb cap) only ever shrinks what is owed,
 * so a healthy system sits at or above zero surplus.
 */
async function computeSolvency() {
  const houseLamports = await connection.getBalance(game.publicKey, 'confirmed');
  const unswept = Object.keys(store.players).filter((id) => store.players[id].needsSweep);
  let unsweptLamports = 0;
  for (let i = 0; i < unswept.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(
      unswept.slice(i, i + 100).map((id) => new PublicKey(store.players[id].address)), 'confirmed');
    for (const info of infos) if (info) unsweptLamports += info.lamports;
  }
  // Everything below is read synchronously, together, so it describes one moment.
  let balances = 0;
  for (const p of Object.values(store.players)) balances += p.lamports;
  let inflightLamports = 0;
  // Earnings leaving the wallet are the house's own money, not owed to a player, so they are not counted here.
  for (const rec of Object.values(store.withdrawals)) {
    if (rec.kind !== 'earnings' && (rec.status === 'pending' || rec.status === 'sending')) inflightLamports += rec.lamports;
  }
  const inPlayLamports = Math.ceil(inPlayProvider() / CREDITS_PER_SOL * LAMPORTS_PER_SOL);

  const assets = houseLamports + unsweptLamports;
  const owed = balances + inPlayLamports + inflightLamports;
  // Network fees the game wallet has absorbed (sweeps and withdrawals) are an operating cost, not a
  // shortfall, so they are added back; otherwise thousands of small transactions would look like insolvency.
  const surplus = assets - owed + store.feesLamports;
  return {
    assetsLamports: assets, houseLamports, unsweptLamports,
    owedLamports: owed, balancesLamports: balances, inPlayLamports, inflightLamports,
    feesLamports: store.feesLamports,
    surplusLamports: surplus,
    ok: surplus >= -LIMITS.insolvencyToleranceLamports,
    checkedAt: Date.now(),
  };
}

/** Runs every poll. Two failures in a row pause the site, which filters out a single in-flight-withdrawal blip. */
async function checkSolvency() {
  const s = await computeSolvency();
  lastSolvency = s;
  if (s.houseLamports < LIMITS.lowWalletLamports) {
    sendAlert('low-wallet', 'Game wallet is low: ' + lamportsToSol(s.houseLamports) + ' SOL (alert threshold ' + lamportsToSol(LIMITS.lowWalletLamports) + ')', 60 * 60 * 1000);
  }
  if (s.ok) { solvencyFailures = 0; return s; }
  solvencyFailures++;
  if (solvencyFailures >= 2 && !isPaused()) {
    setPaused(true, 'Auto-pause: the game wallet is short by ' + lamportsToSol(-s.surplusLamports) + ' SOL against what it owes', 'auto');
    sendAlert('insolvent', 'INSOLVENT — auto-paused. Holds ' + lamportsToSol(s.assetsLamports) + ' SOL, owes ' + lamportsToSol(s.owedLamports) + ' SOL', 0);
  }
  return s;
}

/** Everything the admin page shows. Player ids are bearer secrets, so they are deliberately left out. */
async function getAdminStatus() {
  requireEnabled();
  const solvency = await computeSolvency();
  const out = withdrawnSince(Date.now() - DAY_MS);
  const players = Object.values(store.players)
    .map((p) => ({ owner: p.owner, address: p.address, sol: lamportsToSol(p.lamports), createdAt: p.createdAt, needsSweep: p.needsSweep }))
    .sort((a, b) => b.sol - a.sol)
    .slice(0, 200);
  const unsettled = Object.values(store.withdrawals)
    .filter((r) => r.status === 'pending' || r.status === 'sending')
    .map((r) => ({ kind: r.kind || 'player', to: r.to, sol: lamportsToSol(r.lamports), status: r.status, signature: r.signature, ageSec: Math.round((Date.now() - r.createdAt) / 1000) }));

  const entries = readLedgerEntries();
  const recent = entries.slice(-60).reverse();
  const audit = entries.filter((e) => e.type === 'admin_action').slice(-100).reverse();
  const activity = dailyStats(entries, 14);

  return {
    network,
    pause: getPauseInfo(),
    rpc: RPC_URL.replace(/\/\/([^/@]*@)?([^/?]+).*/, '//$2/…'), // host only: RPC URLs often embed an API key
    gameWallet: { address: game.publicKey.toBase58(), sol: lamportsToSol(solvency.houseLamports) },
    solvency: {
      ok: solvency.ok,
      holdsSol: lamportsToSol(solvency.assetsLamports),
      owesSol: lamportsToSol(solvency.owedLamports),
      surplusSol: lamportsToSol(solvency.surplusLamports),
      balancesSol: lamportsToSol(solvency.balancesLamports),
      inPlaySol: lamportsToSol(solvency.inPlayLamports),
      inflightSol: lamportsToSol(solvency.inflightLamports),
      unsweptSol: lamportsToSol(solvency.unsweptLamports),
      feesPaidSol: lamportsToSol(solvency.feesLamports),
    },
    limits: {
      maxWithdrawSol: lamportsToSol(LIMITS.maxWithdrawLamports),
      maxPlayerDailySol: lamportsToSol(LIMITS.maxPlayerDailyLamports),
      maxGlobalDailySol: lamportsToSol(LIMITS.maxGlobalDailyLamports),
      maxBuyinCredits: LIMITS.maxBuyinCredits,
      maxBuyinSol: LIMITS.maxBuyinCredits / CREDITS_PER_SOL,
      lowWalletSol: lamportsToSol(LIMITS.lowWalletLamports),
      toleranceSol: lamportsToSol(LIMITS.insolvencyToleranceLamports),
    },
    earnings: {
      feesCollectedSol: lamportsToSol(store.rakeLamports),
      takenSol: lamportsToSol(store.earningsTakenLamports),
      availableSol: lamportsToSol(store.rakeLamports - store.earningsTakenLamports),
      // what could be taken this minute: the lesser of the fees available and the wallet's room above what it owes
      maxNowSol: lamportsToSol(Math.max(0, Math.min(store.rakeLamports - store.earningsTakenLamports, solvency.surplusLamports - EARNINGS_RESERVE_LAMPORTS))),
      reserveSol: lamportsToSol(EARNINGS_RESERVE_LAMPORTS),
      ownerAddress: OWNER_ADDRESS,
      rakePercent: RAKE_PERCENT,
      networkCostsSol: lamportsToSol(store.feesLamports),
    },
    withdrawnLast24hSol: lamportsToSol(out.total),
    playerCount: Object.keys(store.players).length,
    alertsConfigured: !!ALERT_URL,
    unsettledWithdrawals: unsettled,
    players,
    recent,
    audit,
    activity,
    settings: getSettings(),
    bans: listBans(),
  };
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
  store.feesLamports += TX_FEE_LAMPORTS; // the game wallet pays this on top of the amount
  save();
  if (rec.kind === 'earnings') {
    ledger('earnings_ok', { to: rec.to, lamports: rec.lamports, sol: lamportsToSol(rec.lamports), signature: rec.signature });
    sendAlert('earnings-ok:' + rec.signature, 'House earnings withdrawn: ' + lamportsToSol(rec.lamports) + ' SOL sent to the owner address (' + rec.signature + ')', 0);
    return;
  }
  ledger('withdraw_ok', { playerId: rec.playerId, to: rec.to, lamports: rec.lamports, signature: rec.signature });
}

function refundWithdrawal(rec, reason) {
  if (rec.status !== 'pending' && rec.status !== 'sending') return;
  if (rec.kind === 'earnings') store.earningsTakenLamports -= rec.lamports; // the earnings are available again
  else store.players[rec.playerId].lamports += rec.lamports;
  rec.status = 'refunded';
  rec.error = String(reason).slice(0, 200);
  rec.updatedAt = Date.now();
  save();
  ledger(rec.kind === 'earnings' ? 'earnings_refund' : 'withdraw_refund',
    { playerId: rec.playerId, to: rec.to, lamports: rec.lamports, signature: rec.signature, reason: rec.error });
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

  if (isPaused()) throw new WalletError('paused', 'Withdrawals are temporarily paused. Your balance is safe.', 503);
  if (lamports > LIMITS.maxWithdrawLamports) {
    throw new WalletError('over_limit', 'The maximum per withdrawal is ' + lamportsToSol(LIMITS.maxWithdrawLamports) + ' SOL', 403);
  }
  const out = withdrawnSince(Date.now() - DAY_MS);
  if ((out.byPlayer[playerId] || 0) + lamports > LIMITS.maxPlayerDailyLamports) {
    throw new WalletError('over_limit', 'Daily withdrawal limit reached (' + lamportsToSol(LIMITS.maxPlayerDailyLamports) + ' SOL per 24 hours). Try again later.', 403);
  }
  if (out.total + lamports > LIMITS.maxGlobalDailyLamports) {
    sendAlert('global-daily-cap', 'Global daily withdrawal cap (' + lamportsToSol(LIMITS.maxGlobalDailyLamports) + ' SOL) reached — withdrawals are being refused until it rolls over');
    throw new WalletError('over_limit', 'Withdrawals are at their daily limit. Please try again later.', 503);
  }

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

function earningsResult(rec) {
  return { status: rec.status, signature: rec.signature || null, to: rec.to, lamports: rec.lamports, sol: lamportsToSol(rec.lamports), error: rec.error || null };
}

/**
 * Send house earnings to OWNER_ADDRESS, and nowhere else. The rules, in order:
 *   - only fees actually collected (rakeLamports) that have not been taken yet are available;
 *   - the wallet must be solvent right now, judged from a fresh look at the chain;
 *   - afterwards it must still hold at least EARNINGS_RESERVE more than it owes players;
 *   - the site must not be paused (resume first), and one earnings withdrawal runs at a time.
 * It then uses the same crash-safe flow as player withdrawals (signature persisted before broadcast, refund
 * only when the chain proves failure) and is idempotent per key.
 */
async function withdrawEarnings(solAmount, idempotencyKey) {
  requireEnabled();
  if (!OWNER_ADDRESS) throw new WalletError('owner_not_configured', 'OWNER_ADDRESS is not set on the server, so earnings cannot be withdrawn', 400);
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
    throw new WalletError('bad_idempotency_key', 'Missing or invalid idempotencyKey');
  }
  const lamports = solToLamports(solAmount);
  if (lamports < MIN_WITHDRAW_LAMPORTS) {
    throw new WalletError('below_minimum', 'Minimum is ' + lamportsToSol(MIN_WITHDRAW_LAMPORTS) + ' SOL');
  }

  const wkey = 'earnings:' + idempotencyKey;
  const existing = store.withdrawals[wkey];
  if (existing) {
    if (existing.lamports !== lamports) throw new WalletError('idempotency_conflict', 'That idempotencyKey was already used for a different amount', 409);
    return earningsResult(existing);
  }
  if (isPaused()) throw new WalletError('paused', 'The site is paused. Resume it before withdrawing earnings.', 503);
  if (earningsBusy) throw new WalletError('busy', 'Another earnings withdrawal is in progress', 409);

  earningsBusy = true;
  try {
    const available = () => store.rakeLamports - store.earningsTakenLamports;
    if (lamports > available()) {
      throw new WalletError('over_earnings', 'Only ' + lamportsToSol(available()) + ' SOL of fees is available to take', 400);
    }
    const s = await computeSolvency();
    if (!s.ok) throw new WalletError('insolvent', 'The game wallet is short of what it owes players. Earnings cannot be taken.', 409);
    if (s.surplusLamports - lamports < EARNINGS_RESERVE_LAMPORTS) {
      const room = Math.max(0, s.surplusLamports - EARNINGS_RESERVE_LAMPORTS);
      throw new WalletError('over_surplus', 'That would leave the game wallet too close to what it owes players. At most ' + lamportsToSol(room) + ' SOL can be taken right now.', 400);
    }
    // The RPC calls above took time: re-check anything that could have changed meanwhile.
    if (store.withdrawals[wkey] || isPaused() || lamports > available()) {
      throw new WalletError('state_changed', 'Something changed while checking, please try again', 409);
    }

    store.earningsTakenLamports += lamports; // reserved now; given back if the send fails
    const rec = store.withdrawals[wkey] = {
      kind: 'earnings', playerId: null, key: idempotencyKey, to: OWNER_ADDRESS, lamports,
      status: 'pending', signature: null, lastValidBlockHeight: null, error: null, createdAt: Date.now(),
    };
    save();
    ledger('earnings_start', { to: OWNER_ADDRESS, lamports, sol: lamportsToSol(lamports) });

    inflight.add(wkey);
    try { await sendWithdrawal(rec); }
    finally { inflight.delete(wkey); }
    return earningsResult(rec);
  } finally {
    earningsBusy = false;
  }
}

/** Lamports sent (or being sent) since `since`: refunded withdrawals don't count. */
function withdrawnSince(since) {
  const byPlayer = {};
  let total = 0;
  for (const rec of Object.values(store.withdrawals)) {
    if (rec.createdAt < since || rec.status === 'refunded' || rec.kind === 'earnings') continue; // the daily caps are about players' money
    byPlayer[rec.playerId] = (byPlayer[rec.playerId] || 0) + rec.lamports;
    total += rec.lamports;
  }
  return { byPlayer, total };
}

/** Settle withdrawals left half-done by a crash or a slow confirmation. */
async function reconcileWithdrawals() {
  for (const [wkey, rec] of Object.entries(store.withdrawals)) {
    if (inflight.has(wkey)) continue;
    if (rec.status === 'pending') refundWithdrawal(rec, 'Interrupted before it was sent'); // signature was never persisted, so nothing went out
    else if (rec.status === 'sending') {
      await settleWithdrawal(rec);
      if (rec.status === 'sending' && Date.now() - rec.createdAt > STUCK_WITHDRAWAL_MS) {
        sendAlert('stuck:' + rec.signature, 'Withdrawal ' + rec.signature + ' (' + lamportsToSol(rec.lamports) + ' SOL) has been unconfirmed for over 10 minutes', 60 * 60 * 1000);
      }
    }
  }
  // Finished records only exist to answer repeated idempotency keys, so they can age out.
  let pruned = 0;
  for (const [wkey, rec] of Object.entries(store.withdrawals)) {
    if ((rec.status === 'completed' || rec.status === 'refunded') && Date.now() - rec.createdAt > WITHDRAWAL_KEEP_MS) { delete store.withdrawals[wkey]; pruned++; }
  }
  if (pruned) save();
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
  store.feesLamports += TX_FEE_LAMPORTS; // paid out of the deposit, so the game wallet receives 5000 less than was credited
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

/**
 * Look for ONE player's deposit right now, instead of waiting for the next 30s poll. The page calls this
 * while the deposit window is open. It takes the same lock as the poller (`polling`), so a deposit can
 * never be scanned by both at once; if the poller is busy the caller simply gets the current balance.
 */
async function checkPlayerDepositNow(playerId) {
  const player = requirePlayer(playerId);
  if (polling) return balanceOf(player);
  polling = true;
  try {
    const info = await connection.getAccountInfo(new PublicKey(player.address), 'finalized');
    if ((info && info.lamports > 0) || player.needsSweep) {
      await scanPlayerDeposits(playerId);
      if (player.needsSweep) await sweepToGameWallet(playerId);
    }
  } catch (e) {
    console.error('[wallet] on-demand deposit check failed for ' + player.address + ':', e.message);
  } finally {
    polling = false;
  }
  return balanceOf(player);
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

    await checkSolvency();
    rpcFailures = 0;
  } catch (e) {
    console.error('[wallet] deposit poll failed:', e.message);
    rpcFailures++;
    if (rpcFailures >= 3) sendAlert('rpc-down', 'The deposit poller has failed ' + rpcFailures + ' times in a row (' + e.message.slice(0, 120) + ') — deposits are not being credited', 30 * 60 * 1000);
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
  try {
    const secret = JSON.parse(raw);
    if (!Array.isArray(secret) || secret.length !== 64) throw new Error('expected a JSON array of 64 numbers');
    game = Keypair.fromSecretKey(Uint8Array.from(secret));

    const seed = process.env.DEPOSIT_MASTER_SEED;
    if (!seed || seed.length < 16) {
      console.warn('[wallet] DEPOSIT_MASTER_SEED not set (or too short) — deriving it from GAME_WALLET_SECRET. Set a dedicated one before real use.');
    }
    // This label is part of how every deposit address and player id is derived. It keeps the project's
    // ORIGINAL name on purpose and must never change, or every address and balance key would change with it.
    masterKey = crypto.createHash('sha256').update('slithercash/master/v1\0' + (seed && seed.length >= 16 ? seed : Buffer.from(game.secretKey).toString('base64'))).digest();

    loadStore();
    connection = new Connection(RPC_URL, 'confirmed');
  } catch (e) {
    console.error('[wallet] startup failed, wallet disabled:', e.message);
    return false;
  }

  // The wallet stays disabled until the RPC proves which network it is actually on.
  verifyNetworkThenStart();
  return true;
}

/**
 * Which network is this? Asked of the RPC itself (its genesis hash), never guessed from the URL: paid
 * providers' URLs don't reliably say "mainnet", and pointing a real wallet at the wrong network
 * (or play money at the real one) is exactly the kind of mistake worth refusing to start over.
 */
async function verifyNetworkThenStart() {
  while (!shuttingDown) {
    try {
      network = GENESIS_NETWORKS[await connection.getGenesisHash()] || 'unknown';
      break;
    } catch (e) {
      console.error('[wallet] could not identify the network (retrying in 10s):', e.message);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  if (shuttingDown) return;

  let refusal = null;
  if (network === 'unknown') refusal = 'the RPC reports a network this build does not recognise';
  else if (network === 'mainnet-beta') {
    const seed = process.env.DEPOSIT_MASTER_SEED;
    if (process.env.ALLOW_MAINNET !== '1') refusal = 'this is MAINNET (real money) and ALLOW_MAINNET=1 is not set';
    else if (!seed || seed.length < 16) refusal = 'mainnet requires a dedicated DEPOSIT_MASTER_SEED (16+ characters)';
    else if (!ALERT_URL) refusal = 'mainnet requires ALERT_WEBHOOK_URL so someone hears about problems';
  }
  if (refusal) {
    console.error('[wallet] REFUSING TO START on ' + network + ': ' + refusal + '. Wallet disabled.');
    enabled = false;
    return;
  }
  enabled = true;
  if (network === 'mainnet-beta') {
    console.warn('[wallet] *** MAINNET: real money. ***');
    sendAlert('mainnet-start', 'Server started on MAINNET (real money). Limits: ' + lamportsToSol(LIMITS.maxWithdrawLamports) + ' SOL per withdrawal, ' +
      lamportsToSol(LIMITS.maxGlobalDailyLamports) + ' SOL per day in total', 60 * 1000);
  }

  // Paid RPC URLs usually carry an API key, so only ever log the host.
  console.log('[wallet] enabled on ' + network + ' via ' + RPC_URL.replace(/\/\/([^/@]*@)?([^/?]+).*/, '//$2/…'));
  console.log('[wallet] game wallet: ' + game.publicKey.toBase58());
  console.log('[wallet] data file: ' + DATA_FILE);
  console.log('[wallet] house fee: ' + RAKE_PERCENT + '% of cash-out profit; earnings can be withdrawn to ' +
    (OWNER_ADDRESS ? OWNER_ADDRESS.slice(0, 4) + '…' + OWNER_ADDRESS.slice(-4) : 'nowhere (OWNER_ADDRESS not set)'));
  console.log('[wallet] limits: withdraw ' + lamportsToSol(LIMITS.maxWithdrawLamports) + ' SOL each, ' +
    lamportsToSol(LIMITS.maxPlayerDailyLamports) + '/player/day, ' + lamportsToSol(LIMITS.maxGlobalDailyLamports) + '/day total; buy-in max $' + LIMITS.maxBuyinCredits);
  if (isPaused()) console.warn('[wallet] PAUSED: ' + getPauseInfo().reason);
  if (!ALERT_URL) console.warn('[wallet] ALERT_WEBHOOK_URL not set — nobody will be told if something goes wrong');
  getGameBalance().then((b) => console.log('[wallet] game wallet balance: ' + b.sol + ' SOL'))
    .catch((e) => console.error('[wallet] could not read game wallet balance:', e.message));

  setTimeout(pollDeposits, 2000);
  pollTimer = setInterval(pollDeposits, POLL_MS);
}

function shutdown() {
  shuttingDown = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = {
  init,
  shutdown,
  isEnabled: () => enabled,
  getNetwork: () => network,
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
  settleCashout,
  deductPlayer,
  withdraw,
  withdrawEarnings,
  getGameBalance,
  getPublicLimits,
  assertCanBuyIn,
  setInPlayProvider,
  getAdminStatus,
  getSettings,
  updateSettings,
  ownerOf,
  isBanned,
  banWallet,
  unbanWallet,
  isPaused,
  getPauseInfo,
  setPaused,
  sendAlert,
  logLedger: ledger,
  checkPlayerDepositNow,
  pollDeposits, // exposed for tests
};
