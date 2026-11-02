// Module-level test of the cash-out fee (settleCashout) on the simulated chain.
// Run from the files/ folder:  npm run test:fee
// Optional: RAKE_PERCENT=10 EXPECT_RAKE_PERCENT=10 npm run test:fee
const fs = require('fs');
const path = require('path');
const SCRATCH = path.join(require('os').tmpdir(), 'slithercash-tests');
fs.mkdirSync(SCRATCH, { recursive: true });
const crypto = require('crypto');
process.env.FAKE_CHAIN_FILE = path.join(SCRATCH, 'rake-chain.json');
const { Keypair } = require('@solana/web3.js');

const data = path.join(SCRATCH, 'rake-wallet-data.json');
for (const f of [data, data + '.ledger.jsonl', process.env.FAKE_CHAIN_FILE]) fs.rmSync(f, { force: true });
const game = Keypair.generate();
require('./fake-chain-lib.js').airdrop(game.publicKey.toBase58(), 1e9);
process.env.GAME_WALLET_SECRET = JSON.stringify(Array.from(game.secretKey));
process.env.DEPOSIT_MASTER_SEED = 'rake-master-seed-0123456789abcdef';
process.env.WALLET_DATA_FILE = data;
process.env.DEPOSIT_POLL_MS = '600000';

const wallet = require('../solanaWallet.js');
let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-7);

function sign(kp, msg) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(msg), key).toString('base64');
}

(async () => {
  wallet.init();
  for (let i = 0; i < 50 && !wallet.isEnabled(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!wallet.isEnabled()) { console.log('wallet did not start'); process.exit(3); }

  const kp = Keypair.generate();
  const ch = wallet.createLoginChallenge(kp.publicKey.toBase58());
  const { playerId } = wallet.completeLogin(kp.publicKey.toBase58(), ch.message, sign(kp, ch.message));
  const pct = wallet.getPublicLimits().rakePercent;
  console.log('rake percent in effect: ' + pct);
  const credits = () => wallet.getPlayerBalance(playerId).credits;
  const fees = async () => (await wallet.getAdminStatus()).earnings.feesCollectedSol * 100; // in credits

  const expectPct = Number(process.env.EXPECT_RAKE_PERCENT || 5);
  check('rake percent is ' + expectPct, pct === expectPct, pct);

  let before = credits();
  let r = wallet.settleCashout(playerId, 5, 5);
  check('cash out at the buy-in: no fee, full amount', r.feeCredits === 0 && near(r.netCredits, 5) && near(credits() - before, 5), r);

  before = credits();
  r = wallet.settleCashout(playerId, 3, 5);
  check('cash out at a loss: no fee', r.feeCredits === 0 && near(credits() - before, 3), r);

  before = credits();
  r = wallet.settleCashout(playerId, 8, 5);
  const wantFee = 3 * expectPct / 100;
  check('cash out at a profit: fee is ' + expectPct + '% of the profit only', near(r.feeCredits, wantFee) && near(r.netCredits, 8 - wantFee) && near(credits() - before, 8 - wantFee), r);

  before = credits();
  r = wallet.settleCashout(playerId, 1000, 500);
  check('large win: fee is ' + expectPct + '% of the profit, not of the stake', near(r.feeCredits, 500 * expectPct / 100) && near(credits() - before, 1000 - 500 * expectPct / 100, 1e-6), r);

  const total = await fees();
  check('fees collected adds up to the fees taken', near(total, (3 + 500) * expectPct / 100, 1e-6), total);

  let threw = false;
  try { wallet.settleCashout('ab'.repeat(32), 8, 5); } catch (e) { threw = e.code === 'unknown_player'; }
  check('unknown player cannot be credited', threw);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
