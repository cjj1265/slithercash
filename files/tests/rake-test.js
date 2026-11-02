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
const owner = Keypair.generate(); // where house earnings may be sent (OWNER_ADDRESS)
const fakeChain = require('./fake-chain-lib.js');
fakeChain.airdrop(game.publicKey.toBase58(), 1e9);
process.env.OWNER_ADDRESS = owner.publicKey.toBase58();
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

  if (expectPct > 0) {
    console.log('\n-- withdrawing house earnings --');
    const conn = new fakeChain.FakeConnection();
    const gameAddr = game.publicKey.toBase58(), ownerAddr = owner.publicKey.toBase58();
    const expectErr = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    const feesSol = (3 + 500) * expectPct / 100 / 100;

    const s0 = await wallet.getAdminStatus();
    check('the owner address is reported', s0.earnings.ownerAddress === ownerAddr, s0.earnings.ownerAddress);
    check('collected fees are available to take', near(s0.earnings.availableSol, feesSol, 1e-9), s0.earnings);

    let e = await expectErr(() => wallet.withdrawEarnings(0.1, 'key-insolvent-01'));
    check('refused while the game wallet is short of what it owes players', e && e.code === 'insolvent', e && e.code);

    // Give the wallet exactly 0.01 SOL more than it owes: solvent, but nowhere near enough room for 0.1 SOL.
    const owedL = Math.round(s0.solvency.owesSol * 1e9);
    fakeChain.airdrop(gameAddr, owedL - (await conn.getBalance(game.publicKey)) + 10000000);
    e = await expectErr(() => wallet.withdrawEarnings(0.1, 'key-surplus-001'));
    check('refused if it would leave the wallet too close to what it owes', e && e.code === 'over_surplus', e && e.code);

    fakeChain.airdrop(gameAddr, 5e9); // plenty of room from here on
    e = await expectErr(() => wallet.withdrawEarnings(feesSol + 1, 'key-overavail-01'));
    check('cannot take more than the fees actually collected', e && e.code === 'over_earnings', e && e.code);
    e = await expectErr(() => wallet.withdrawEarnings(0.0001, 'key-tiny-000001'));
    check('below the minimum is refused', e && e.code === 'below_minimum', e && e.code);
    e = await expectErr(() => wallet.withdrawEarnings(0.1, 'x'));
    check('a missing or short idempotency key is refused', e && e.code === 'bad_idempotency_key', e && e.code);
    wallet.setPaused(true, 'earnings test', 'test');
    e = await expectErr(() => wallet.withdrawEarnings(0.1, 'key-paused-0001'));
    check('refused while the site is paused', e && e.code === 'paused', e && e.code);
    wallet.setPaused(false, '', 'test');

    const ownerBefore = await conn.getBalance(owner.publicKey);
    const ok = await wallet.withdrawEarnings(0.1, 'key-ok-0000001');
    check('a valid withdrawal completes and goes to the owner address', ok.status === 'completed' && !!ok.signature && ok.to === ownerAddr, ok);
    check('the owner received exactly 0.1 SOL on chain', (await conn.getBalance(owner.publicKey)) - ownerBefore === 1e8);
    const s1 = await wallet.getAdminStatus();
    check('available fees dropped by what was taken', near(s1.earnings.availableSol, feesSol - 0.1, 1e-9) && near(s1.earnings.takenSol, 0.1, 1e-9), s1.earnings);
    check('the wallet is still solvent afterwards', s1.solvency.ok === true, s1.solvency);

    const again = await wallet.withdrawEarnings(0.1, 'key-ok-0000001');
    check('repeating the same key returns the same result and pays nothing more', again.signature === ok.signature && (await conn.getBalance(owner.publicKey)) - ownerBefore === 1e8);
    e = await expectErr(() => wallet.withdrawEarnings(0.05, 'key-ok-0000001'));
    check('the same key with a different amount is refused', e && e.code === 'idempotency_conflict', e && e.code);

    const both = await Promise.allSettled([wallet.withdrawEarnings(0.01, 'key-race-000001'), wallet.withdrawEarnings(0.01, 'key-race-000002')]);
    const done = both.filter((x) => x.status === 'fulfilled').length, busy = both.filter((x) => x.status === 'rejected' && x.reason.code === 'busy').length;
    check('two at once: exactly one runs, the other is told to wait', done === 1 && busy === 1, both.map((x) => x.status === 'fulfilled' ? 'ok' : x.reason.code));
    check('only the one that ran was paid', (await conn.getBalance(owner.publicKey)) - ownerBefore === 1e8 + 1e7);

    const ledgerTypes = fs.readFileSync(data + '.ledger.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
    check('the ledger records earnings_start and earnings_ok', ledgerTypes.includes('earnings_start') && ledgerTypes.includes('earnings_ok'), ledgerTypes.slice(-6));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
