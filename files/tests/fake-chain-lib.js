// Test helper. A tiny stand-in for the Solana RPC, covering only the Connection methods solanaWallet.js calls.
// (The devnet faucet is closed to scripts, so tests run against this.) It parses and signature-checks
// the transactions the wallet module builds and applies system transfers with fees and the
// rent-exemption rule. State lives in a JSON file so a server child process and the test share it.
const fs = require('fs');
const crypto = require('crypto');
const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const { PublicKey, Transaction, SystemInstruction, SystemProgram, SendTransactionError } = web3;

const FEE = 5000;
const RENT_MIN = 890880;

const file = () => process.env.FAKE_CHAIN_FILE;
function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (e) { return { height: 1000, accounts: {}, txs: {}, byAddr: {} }; }
}
function save(s) {
  const tmp = file() + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file());
}
function simErr(msg) {
  const e = Object.create(SendTransactionError.prototype);
  e.name = 'SendTransactionError';
  e.message = 'Simulation failed: ' + msg;
  return e;
}
function airdrop(addr, lamports) {
  const s = load();
  s.accounts[addr] = (s.accounts[addr] || 0) + lamports;
  save(s);
}

const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  unknown: '11111111111111111111111111111111',
};

class FakeConnection {
  async getGenesisHash() { return GENESIS[process.env.FAKE_GENESIS || 'devnet']; }

  async getBalance(pk) { return load().accounts[pk.toBase58()] || 0; }

  async getMultipleAccountsInfo(pks) {
    const s = load();
    return pks.map((pk) => { const l = s.accounts[pk.toBase58()] || 0; return l > 0 ? { lamports: l } : null; });
  }

  async getSignaturesForAddress(pk, opts) {
    const s = load();
    let list = (s.byAddr[pk.toBase58()] || []).slice().reverse(); // newest first, like the real RPC
    if (opts.before) { const i = list.indexOf(opts.before); if (i >= 0) list = list.slice(i + 1); }
    if (opts.until) { const i = list.indexOf(opts.until); if (i >= 0) list = list.slice(0, i); }
    return list.slice(0, opts.limit || 1000).map((signature) => ({ signature, slot: 1, err: s.txs[signature].err, blockTime: s.txs[signature].time }));
  }

  async getParsedTransaction(sig) {
    const t = load().txs[sig];
    if (!t) return null;
    return {
      blockTime: t.time,
      meta: { err: t.err, preBalances: t.pre, postBalances: t.post },
      transaction: { message: { accountKeys: t.keys.map((k) => ({ pubkey: new PublicKey(k) })) } },
    };
  }

  async getLatestBlockhash() {
    return { blockhash: new PublicKey(crypto.randomBytes(32)).toBase58(), lastValidBlockHeight: load().height + 150 };
  }

  async getBlockHeight() { const s = load(); s.height += 5; save(s); return s.height; }

  async sendRawTransaction(buf) {
    const tx = Transaction.from(buf);
    if (!tx.verifySignatures()) throw simErr('signature verification failure');
    const s = load();
    const payer = tx.feePayer.toBase58();
    const order = [], pre = {}, now = {};
    const touch = (a) => { if (!(a in pre)) { pre[a] = s.accounts[a] || 0; now[a] = pre[a]; order.push(a); } };
    touch(payer);
    if (now[payer] < FEE) throw simErr('insufficient funds for fee');
    now[payer] -= FEE;
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(SystemProgram.programId)) throw simErr('unsupported program');
      const t = SystemInstruction.decodeTransfer(ix);
      const from = t.fromPubkey.toBase58(), to = t.toPubkey.toBase58(), amt = Number(t.lamports);
      touch(from); touch(to);
      if (now[from] < amt) throw simErr('insufficient lamports ' + now[from] + ' < ' + amt);
      now[from] -= amt; now[to] += amt;
    }
    for (const a of order) if (now[a] !== 0 && now[a] < RENT_MIN) throw simErr('insufficient funds for rent');

    const sig = bs58.encode(tx.signature);
    for (const a of order) { if (now[a] === 0) delete s.accounts[a]; else s.accounts[a] = now[a]; (s.byAddr[a] = s.byAddr[a] || []).push(sig); }
    s.txs[sig] = { keys: order, pre: order.map((a) => pre[a]), post: order.map((a) => now[a]), err: null, time: Math.floor(Date.now() / 1000) };
    save(s);
    return sig;
  }

  async confirmTransaction({ signature }) {
    if (!load().txs[signature]) throw new Error('block height exceeded');
    return { value: { err: null } };
  }

  async getSignatureStatuses(sigs) {
    const s = load();
    return { value: sigs.map((sig) => (s.txs[sig] ? { err: s.txs[sig].err, confirmationStatus: 'finalized' } : null)) };
  }
}

function install() { web3.Connection = FakeConnection; }

module.exports = { FakeConnection, install, airdrop };
