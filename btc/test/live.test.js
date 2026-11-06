'use strict';
/*
 * scripts/live.js driven as a module against a mocked signet API client.
 * Nothing here touches the network; "broadcasts" are recorded in memory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const live = require('../scripts/live');
const htlc = require('../src/htlc');
const fund = require('../src/fund');
const { extractPreimage } = require('../src/verify');
const H = require('./helpers');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const hex = (b) => Buffer.from(b).toString('hex');
const TIP = 329433;

// A fixed, non-public test secret for these tests (lock refuses the documented public vectors).
const SECRET = sha256(Buffer.from('noid-swap btc live.test.js secret'));
const HASHLOCK = hex(sha256(SECRET));
const LOCKTIME = TIP + 24;
const RS = htlc.buildRedeemScript({ hashlock: HASHLOCK, alicePubkey: H.ALICE_PUB_HEX, bobPubkey: H.BOB_PUB_HEX, locktime: LOCKTIME });
const HTLC_ADDR = htlc.p2wshAddress(RS, 'signet');
const BOB_ADDR = fund.p2wpkh(H.bob.publicKey, 'signet').address;
const ALICE_DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const BOB_UTXOS = [{ txid: 'aa'.repeat(32), vout: 0, value: 150000, confirmed: true, blockHeight: TIP - 10 }];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noid-btc-live-'));
const BOB_KEY = path.join(tmp, 'bob.key');
const ALICE_KEY = path.join(tmp, 'alice.key');
const SECRET_FILE = path.join(tmp, 'secret.txt');
fs.writeFileSync(BOB_KEY, H.bob.toWIF() + '\n');
fs.writeFileSync(ALICE_KEY, H.alice.toWIF() + '\n');
fs.writeFileSync(SECRET_FILE, '0x' + hex(SECRET) + '\n');

/** In-memory signet. */
function mockClient(state = {}) {
  const s = {
    tip: TIP,
    utxos: { [BOB_ADDR]: BOB_UTXOS },
    txs: {}, // txid -> {vout:[{value, scriptpubkey}], status}
    hexes: {}, // txid -> hex
    outspends: {}, // "txid:vout" -> outspend result
    fee: 3,
    broadcasts: [],
    ...state,
  };
  const c = {
    state: s,
    base: 'https://mock.example/signet/api',
    async tipHeight() { return s.tip; },
    async addressUtxos(a) { return s.utxos[a] || []; },
    async tx(txid) { return s.txs[txid] || null; },
    async txHex(txid) { return s.hexes[txid] || null; },
    async txStatus(txid) { return s.txs[txid] ? s.txs[txid].status : null; },
    async outspend(txid, vout) { return s.txs[txid] ? s.outspends[`${txid}:${vout}`] || { spent: false } : null; },
    async feeEstimates() { return { 2: s.fee }; },
    async feeRate() { return s.fee; },
    async broadcast(h) {
      const tx = bitcoin.Transaction.fromHex(h);
      s.broadcasts.push(h);
      return tx.getId();
    },
  };
  return c;
}

/** Put a tx "on chain" in the mock from its hex. */
function mine(client, txHex, { confirmed = true, height = TIP } = {}) {
  const tx = bitcoin.Transaction.fromHex(txHex);
  const txid = tx.getId();
  client.state.txs[txid] = {
    txid,
    vout: tx.outs.map((o) => ({ value: Number(o.value), scriptpubkey: hex(o.script) })),
    status: confirmed ? { confirmed: true, block_height: height } : { confirmed: false },
  };
  client.state.hexes[txid] = txHex;
  return txid;
}

/** A funded HTLC: Bob's funding tx mined at height `height`. */
function fundedChain(opts = {}) {
  const c = mockClient();
  const f = fund.buildFundingTx({ keyPair: H.bob, utxos: BOB_UTXOS, witnessScript: RS, amount: 100000, feeRate: 2, network: 'signet' });
  const txid = mine(c, f.hex, { height: TIP - 3, ...opts });
  return { c, txid, vout: 0, value: 100000, fundingHex: f.hex };
}

const scriptArgs = { witnessScript: hex(RS) };

// ---------------------------------------------------------------- keys / guards

test('keygen writes a signet WIF file, prints address + pubkey only, refuses to overwrite', async () => {
  const out = path.join(tmp, 'new.key');
  const r = await live.keygen({}, { out });
  assert.equal(r.network, 'signet');
  assert.match(r.address, /^tb1q[0-9a-z]{38}$/);
  assert.match(r.pubkey, /^0[23][0-9a-f]{64}$/);
  assert.equal(r.keyFile, out);
  const wif = fs.readFileSync(out, 'utf8').trim();
  assert.match(wif, /^c/, 'testnet/signet WIF prefix');
  assert.ok(!JSON.stringify(r).includes(wif), 'the private key is never in the output');
  const kp = live.loadKey(out);
  assert.equal(hex(kp.publicKey), r.pubkey);
  assert.equal(fund.p2wpkh(kp.publicKey, 'signet').address, r.address);
  await assert.rejects(() => live.keygen({}, { out }), /refusing to overwrite/);
  await assert.rejects(() => live.keygen({}, {}), /--out/);
});

test('loadKey refuses a mainnet WIF and garbage', () => {
  const mainnet = htlc.ECPair.fromPrivateKey(Buffer.from('01'.repeat(32), 'hex'), { network: bitcoin.networks.bitcoin }).toWIF();
  const f = path.join(tmp, 'mainnet.key');
  fs.writeFileSync(f, mainnet + '\n');
  assert.throws(() => live.loadKey(f), /MAINNET private key/);
  const g = path.join(tmp, 'garbage.key');
  fs.writeFileSync(g, 'hello\n');
  assert.throws(() => live.loadKey(g), /WIF/);
  assert.throws(() => live.loadKey(path.join(tmp, 'missing.key')), /not found/);
  assert.throws(() => live.loadKey(undefined), /--key-file/);
});

test('assertSignetAddress: tb1q / tb1p accepted; mainnet, regtest, legacy refused by name', () => {
  assert.equal(live.assertSignetAddress('x', ALICE_DEST), ALICE_DEST);
  assert.equal(live.assertSignetAddress('x', 'tb1plrhsgjsez32l07vx0zeda42jxu2dlhfmrdqhyqnmdk7glyq4rr5qlczj2a').length, 62);
  assert.throws(() => live.assertSignetAddress('x', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), /MAINNET/);
  assert.throws(() => live.assertSignetAddress('x', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), /MAINNET/);
  assert.throws(() => live.assertSignetAddress('x', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), /MAINNET/);
  assert.throws(() => live.assertSignetAddress('x', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'), /regtest/);
  assert.throws(() => live.assertSignetAddress('x', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'), /legacy/);
  assert.throws(() => live.assertSignetAddress('x', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsy'), /not a valid signet address/); // bad checksum
  assert.throws(() => live.assertSignetAddress('x', 'hello'), /not a signet bech32/);
});

test('address: builds the same script as the library; accepts --witness-script; rejects bad terms', async () => {
  const r = await live.address({}, { hashlock: '0x' + HASHLOCK, alicePubkey: H.ALICE_PUB_HEX, bobPubkey: H.BOB_PUB_HEX, locktime: String(LOCKTIME) });
  assert.equal(r.witnessScript, hex(RS));
  assert.equal(r.address, HTLC_ADDR);
  assert.equal(r.scriptPubKey, '0020' + hex(sha256(RS)));
  assert.equal(r.locktime, LOCKTIME);
  assert.equal(r.locktimeKind, 'height');
  assert.equal(r.network, 'signet');
  assert.deepEqual(await live.address({}, scriptArgs), r);
  await assert.rejects(() => live.address({}, { ...scriptArgs, witnessScript: '51' }), /not our HTLC template/);
  // the pre-OP_SIZE 113-byte layout is not our template any more (design section 3.1)
  const legacyWs = hex(RS).replace('6382012088a8', '63a8'); // drop OP_SIZE 32 OP_EQUALVERIFY
  assert.equal(legacyWs.length / 2, 113);
  await assert.rejects(() => live.address({}, { ...scriptArgs, witnessScript: legacyWs }), /not our HTLC template/);
  await assert.rejects(() => live.address({}, { hashlock: HASHLOCK, alicePubkey: H.ALICE_PUB_HEX, bobPubkey: H.ALICE_PUB_HEX, locktime: '5' }), /differ/);
  await assert.rejects(() => live.address({}, { hashlock: 'zz', alicePubkey: H.ALICE_PUB_HEX, bobPubkey: H.BOB_PUB_HEX, locktime: '5' }), /--hashlock/);
  await assert.rejects(() => live.address({}, { hashlock: HASHLOCK, alicePubkey: H.ALICE_PUB_HEX, bobPubkey: H.BOB_PUB_HEX }), /--locktime/);
});

test('tip and balance go through the client; balance refuses mainnet', async () => {
  const c = mockClient();
  assert.deepEqual(await live.tip({ client: c }), { network: 'signet', tipHeight: TIP, api: c.base, apiAnswered: c.base });
  const b = await live.balance({ client: c }, { address: BOB_ADDR });
  assert.equal(b.confirmedSats, 150000);
  assert.equal(b.unconfirmedSats, 0);
  assert.equal(b.utxoCount, 1);
  await assert.rejects(() => live.balance({ client: c }, { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }), /MAINNET/);
  await assert.rejects(() => live.tip({ client: { ...c, base: 'https://mempool.space/api' } }), /signet/);
});

// ---------------------------------------------------------------- lock

const lockArgs = { keyFile: BOB_KEY, hashlock: HASHLOCK, alicePubkey: H.ALICE_PUB_HEX, locktime: String(LOCKTIME), amountSats: '100000' };

test('lock: dry run builds + self-checks the funding tx and sends nothing', async () => {
  const c = mockClient();
  const r = await live.lock({ client: c }, lockArgs);
  assert.equal(r.dryRun, true);
  assert.equal(r.sent, false);
  assert.deepEqual(c.state.broadcasts, []);
  assert.equal(r.address, HTLC_ADDR);
  assert.equal(r.witnessScript, hex(RS));
  assert.equal(r.bobPubkey, H.BOB_PUB_HEX);
  assert.equal(r.from, BOB_ADDR);
  assert.equal(r.vout, 0);
  assert.equal(r.outpoint, `${r.txid}:0`);
  assert.equal(r.amountSats, 100000);
  assert.equal(r.feeRate, 3);
  assert.match(r.feeRateSource, /api/);
  assert.equal(r.blocksToLocktime, 24);
  assert.equal(r.claimCutoffHeight, LOCKTIME - 6);
  assert.deepEqual(r.warnings, []);
  const tx = bitcoin.Transaction.fromHex(r.hex);
  assert.equal(tx.getId(), r.txid);
  assert.equal(hex(tx.outs[0].script), hex(htlc.p2wshScriptPubKey(RS)));
  assert.equal(Number(tx.outs[0].value), 100000);
  assert.equal(r.changeSats, 150000 - 100000 - r.fee);
  assert.equal(r.changeAddress, BOB_ADDR);
  assert.ok(fund.checkFundingTx(r.hex, { pubkey: H.bob.publicKey, inputValues: [150000] }).ok);
  assert.ok(!JSON.stringify(r).includes(H.bob.toWIF()));
  // --fee-rate override, still capped
  assert.equal((await live.lock({ client: c }, { ...lockArgs, feeRate: '7' })).feeRate, 7);
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, feeRate: '51' }), /--fee-rate/);
});

test('lock: --send broadcasts exactly the dry-run hex once', async () => {
  const c = mockClient();
  const dry = await live.lock({ client: c }, lockArgs);
  const r = await live.lock({ client: c }, { ...lockArgs, send: true });
  assert.equal(r.sent, true);
  assert.equal(r.dryRun, false);
  assert.deepEqual(c.state.broadcasts, [dry.hex]);
  assert.equal(r.txid, dry.txid);
});

test('lock: refusals (public test-vector hashlocks, past/too-far locktime, no coins, key mismatch, mainnet)', async () => {
  const c = mockClient();
  for (const bad of live.FORBIDDEN_HASHLOCKS) {
    await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, hashlock: bad }), /PUBLIC TEST-VECTOR/);
  }
  assert.ok(live.FORBIDDEN_HASHLOCKS.has('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925'), '32 zero bytes');
  assert.ok(live.FORBIDDEN_HASHLOCKS.has(hex(sha256(Buffer.from([...Array(32).keys()])))), '00 01 .. 1f');
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, locktime: String(TIP) }), /not above the current tip/);
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, locktime: String(TIP + 10000) }), /typo/);
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, locktime: '600000000' }), /--locktime/); // time-based refused for lock
  const short = await live.lock({ client: c }, { ...lockArgs, locktime: String(TIP + 5) });
  assert.match(short.warnings[0], /only 5 blocks/);
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, bobPubkey: H.ALICE_PUB_HEX }), /does not match the key file/);
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, amountSats: '1000000' }), /insufficient funds/);
  const empty = mockClient({ utxos: {} });
  await assert.rejects(() => live.lock({ client: empty }, lockArgs), /no confirmed utxos.*faucet/);
  const unconf = mockClient({ utxos: { [BOB_ADDR]: [{ ...BOB_UTXOS[0], confirmed: false, blockHeight: null }] } });
  await assert.rejects(() => live.lock({ client: unconf }, lockArgs), /no confirmed utxos/);
  assert.equal((await live.lock({ client: unconf }, { ...lockArgs, allowUnconfirmed: true })).dryRun, true);
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, keyFile: ALICE_KEY, bobPubkey: H.BOB_PUB_HEX }), /does not match/);
  assert.deepEqual(c.state.broadcasts, []);
});

// ---------------------------------------------------------------- status

test('status: not found / unconfirmed / claimable / refundable', async () => {
  const c0 = mockClient();
  const nf = await live.status({ client: c0 }, { txid: 'ab'.repeat(32), vout: '0', ...scriptArgs });
  assert.equal(nf.funded, false);
  assert.equal(nf.state, 'not found');
  assert.equal(nf.claimCutoffHeight, LOCKTIME - 6);

  const u = fundedChain({ confirmed: false });
  const su = await live.status({ client: u.c }, { txid: u.txid, vout: '0', ...scriptArgs });
  assert.equal(su.funded, true);
  assert.equal(su.confirmed, false);
  assert.equal(su.confirmations, 0);
  assert.equal(su.valueSats, 100000);
  assert.equal(su.state, 'funding unconfirmed');

  const f = fundedChain();
  const sf = await live.status({ client: f.c }, { txid: f.txid, vout: '0', ...scriptArgs });
  assert.equal(sf.confirmed, true);
  assert.equal(sf.blockHeight, TIP - 3);
  assert.equal(sf.confirmations, 4);
  assert.equal(sf.spent, false);
  assert.equal(sf.refundableAtTip, false);
  assert.equal(sf.state, 'funded (claimable)');
  assert.equal(sf.address, HTLC_ADDR);

  f.c.state.tip = LOCKTIME;
  const sr = await live.status({ client: f.c }, { txid: f.txid, vout: '0', ...scriptArgs });
  assert.equal(sr.refundableAtTip, true);
  assert.match(sr.state, /refundable/);

  // wrong script for this outpoint
  const other = hex(htlc.buildRedeemScript({ hashlock: HASHLOCK, alicePubkey: H.ALICE_PUB_HEX, bobPubkey: H.BOB_PUB_HEX, locktime: LOCKTIME + 1 }));
  await assert.rejects(() => live.status({ client: f.c }, { txid: f.txid, vout: '0', witnessScript: other }), /not this HTLC/);
  await assert.rejects(() => live.status({ client: f.c }, { txid: f.txid, vout: '1', ...scriptArgs }), /pays .* not this HTLC|no output/);
});

test('status: a claim spend is detected, branch = claim, preimage extracted and checked', async () => {
  const f = fundedChain();
  const claim = htlc.buildClaimTx({ redeemScript: RS, utxo: { txid: f.txid, vout: 0, value: 100000 }, destination: ALICE_DEST, network: 'signet', preimage: SECRET, keyPair: H.alice, feeRate: 2 });
  const ctxid = mine(f.c, claim.hex, { confirmed: false });
  f.c.state.outspends[`${f.txid}:0`] = { spent: true, txid: ctxid, vin: 0, confirmed: false, blockHeight: null };
  const s = await live.status({ client: f.c }, { txid: f.txid, vout: '0', ...scriptArgs });
  assert.equal(s.spent, true);
  assert.equal(s.spend.txid, ctxid);
  assert.equal(s.spend.branch, 'claim');
  assert.deepEqual(s.spend.scriptCheck, { ok: true, errors: [] });
  assert.equal(s.preimage, '0x' + hex(SECRET));
  assert.equal(s.preimageMatchesHashlock, true);
  assert.equal(s.state, 'claimed (unconfirmed)');
  f.c.state.outspends[`${f.txid}:0`].confirmed = true;
  assert.equal((await live.status({ client: f.c }, { txid: f.txid, vout: '0', ...scriptArgs })).state, 'claimed');
});

test('status: a refund spend is detected, branch = refund, no preimage', async () => {
  const f = fundedChain();
  f.c.state.tip = LOCKTIME + 1;
  const refund = htlc.buildRefundTx({ redeemScript: RS, utxo: { txid: f.txid, vout: 0, value: 100000 }, destination: BOB_ADDR, network: 'signet', keyPair: H.bob, feeRate: 2 });
  const rtxid = mine(f.c, refund.hex, { height: LOCKTIME + 1 });
  f.c.state.outspends[`${f.txid}:0`] = { spent: true, txid: rtxid, vin: 0, confirmed: true, blockHeight: LOCKTIME + 1 };
  const s = await live.status({ client: f.c }, { txid: f.txid, vout: '0', ...scriptArgs });
  assert.equal(s.spend.branch, 'refund');
  assert.equal(s.spend.scriptCheck.ok, true);
  assert.equal(s.preimage, null);
  assert.equal(s.state, 'refunded');
});

// ---------------------------------------------------------------- claim

const claimArgs = { keyFile: ALICE_KEY, to: ALICE_DEST, secretFile: SECRET_FILE, ...scriptArgs };

test('claim: secret from --secret-file; dry run reveals s only inside the hex; watcher recovers it', async () => {
  const f = fundedChain();
  const r = await live.claim({ client: f.c }, { ...claimArgs, txid: f.txid, vout: '0' });
  assert.equal(r.dryRun, true);
  assert.equal(r.sent, false);
  assert.equal(r.branch, 'claim');
  assert.equal(r.inputSats, 100000);
  assert.equal(r.outputSats + r.fee, 100000);
  assert.equal(r.feeRate, 3);
  assert.equal(r.nLockTime, 0);
  assert.equal(r.nSequence, '0xfffffffd');
  assert.equal(r.to, ALICE_DEST);
  assert.deepEqual(f.c.state.broadcasts, []);
  const tx = bitcoin.Transaction.fromHex(r.hex);
  assert.equal(tx.getId(), r.txid);
  assert.equal(hex(Buffer.from(tx.ins[0].hash).reverse()), f.txid);
  assert.equal(hex(tx.ins[0].witness[3]), hex(RS));
  assert.equal(hex(extractPreimage(r.hex, { hashlock: HASHLOCK })), hex(SECRET));
  // the JSON has no secret/preimage field; only the (unavoidable) witness inside hex
  const { hex: _h, ...rest } = r;
  assert.ok(!JSON.stringify(rest).includes(hex(SECRET)));
  assert.ok(!('preimage' in r) && !('secret' in r));
  assert.ok(!JSON.stringify(r).includes(H.alice.toWIF()));
});

test('claim: secret from stdin (0x or bare hex); refusals', async () => {
  const f = fundedChain();
  const a = { ...claimArgs, secretFile: undefined, txid: f.txid, vout: '0' };
  const r1 = await live.claim({ client: f.c, stdin: hex(SECRET) + '\n' }, a);
  const r2 = await live.claim({ client: f.c, stdin: async () => '0x' + hex(SECRET) }, a);
  assert.equal(r1.txid, r2.txid);
  await assert.rejects(() => live.claim({ client: f.c, stdin: hex(sha256(Buffer.from('wrong'))) }, a), /sha256\(secret\) != the hashlock/);
  await assert.rejects(() => live.claim({ client: f.c, stdin: 'abc' }, a), /64 hex chars/);
  await assert.rejects(() => live.claim({ client: f.c, stdin: '' }, a), /64 hex chars/);
  await assert.rejects(() => live.claim({ client: f.c }, { ...a, keyFile: BOB_KEY, stdin: undefined, secretFile: SECRET_FILE }), /not the Alice \(claim\) key/);
  await assert.rejects(() => live.claim({ client: f.c }, { ...a, secretFile: SECRET_FILE, to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }), /MAINNET/);
  await assert.rejects(() => live.claim({ client: f.c }, { ...a, secretFile: SECRET_FILE, txid: 'cd'.repeat(32) }), /not found/);
  // unconfirmed funding
  const u = fundedChain({ confirmed: false });
  await assert.rejects(() => live.claim({ client: u.c }, { ...claimArgs, txid: u.txid, vout: '0' }), /unconfirmed/);
  assert.equal((await live.claim({ client: u.c }, { ...claimArgs, txid: u.txid, vout: '0', allowUnconfirmed: true })).dryRun, true);
  // already spent
  f.c.state.outspends[`${f.txid}:0`] = { spent: true, txid: 'ef'.repeat(32), vin: 0, confirmed: true, blockHeight: TIP };
  await assert.rejects(() => live.claim({ client: f.c }, { ...claimArgs, txid: f.txid, vout: '0' }), /already spent/);
  assert.deepEqual(f.c.state.broadcasts, []);
});

test('claim: refused past the cutoff (locktime - 6) unless --ignore-cutoff; --send broadcasts once', async () => {
  const f = fundedChain();
  f.c.state.tip = LOCKTIME - 6;
  assert.equal((await live.claim({ client: f.c }, { ...claimArgs, txid: f.txid, vout: '0' })).warnings.length, 0, 'at the cutoff is still ok');
  f.c.state.tip = LOCKTIME - 5;
  await assert.rejects(() => live.claim({ client: f.c }, { ...claimArgs, txid: f.txid, vout: '0' }), /past the claim cutoff/);
  const forced = await live.claim({ client: f.c }, { ...claimArgs, txid: f.txid, vout: '0', ignoreCutoff: true });
  assert.match(forced.warnings[0], /refund may confirm first/);
  f.c.state.tip = TIP;
  const sent = await live.claim({ client: f.c }, { ...claimArgs, txid: f.txid, vout: '0', send: true });
  assert.equal(sent.sent, true);
  assert.equal(f.c.state.broadcasts.length, 1);
  assert.equal(bitcoin.Transaction.fromHex(f.c.state.broadcasts[0]).getId(), sent.txid);
});

// ---------------------------------------------------------------- refund

const refundArgs = { keyFile: BOB_KEY, to: BOB_ADDR, ...scriptArgs };

test('refund: too early before the locktime; valid at the locktime with nLockTime/nSequence set', async () => {
  const f = fundedChain();
  f.c.state.tip = LOCKTIME - 1;
  await assert.rejects(() => live.refund({ client: f.c }, { ...refundArgs, txid: f.txid, vout: '0' }), /too early.*1 block\(s\) to go/s);
  f.c.state.tip = LOCKTIME;
  const r = await live.refund({ client: f.c }, { ...refundArgs, txid: f.txid, vout: '0' });
  assert.equal(r.branch, 'refund');
  assert.equal(r.dryRun, true);
  assert.equal(r.nLockTime, LOCKTIME);
  assert.equal(r.nSequence, '0xfffffffd');
  const tx = bitcoin.Transaction.fromHex(r.hex);
  assert.equal(tx.locktime, LOCKTIME);
  assert.equal(tx.ins[0].sequence, 0xfffffffd);
  assert.equal(tx.ins[0].witness.length, 3);
  assert.equal(r.outputSats + r.fee, 100000);
  assert.equal(extractPreimage(r.hex, { hashlock: HASHLOCK }), null);
  await assert.rejects(() => live.refund({ client: f.c }, { ...refundArgs, keyFile: ALICE_KEY, txid: f.txid, vout: '0' }), /not the Bob \(refund\) key/);
  assert.deepEqual(f.c.state.broadcasts, []);
  const s = await live.refund({ client: f.c }, { ...refundArgs, txid: f.txid, vout: '0', send: true });
  assert.equal(s.sent, true);
  assert.deepEqual(f.c.state.broadcasts, [r.hex]);
});

// ---------------------------------------------------------------- broadcast / watch / CLI

test('broadcast: decodes the hex; sends only with --send', async () => {
  const f = fundedChain();
  const r = await live.broadcast({ client: f.c }, { hex: f.fundingHex });
  assert.equal(r.dryRun, true);
  assert.equal(r.sent, false);
  assert.equal(r.txid, f.txid);
  assert.equal(r.outputs[0].address, HTLC_ADDR);
  assert.equal(r.outputs[0].value, 100000);
  assert.equal(r.inputs[0].sequence, '0xfffffffd');
  assert.deepEqual(f.c.state.broadcasts, []);
  const s = await live.broadcast({ client: f.c }, { hex: f.fundingHex, send: true });
  assert.equal(s.sent, true);
  assert.deepEqual(f.c.state.broadcasts, [f.fundingHex]);
  await assert.rejects(() => live.broadcast({ client: f.c }, { hex: 'zz' }), /hex/);
  await assert.rejects(() => live.broadcast({ client: f.c }, { hex: '00' }), /not a valid transaction/);
});

test('watch: polls until the outpoint is spent (prints the preimage) or until-height', async () => {
  const f = fundedChain();
  const claim = htlc.buildClaimTx({ redeemScript: RS, utxo: { txid: f.txid, vout: 0, value: 100000 }, destination: ALICE_DEST, network: 'signet', preimage: SECRET, keyPair: H.alice, feeRate: 2 });
  const ctxid = mine(f.c, claim.hex, { confirmed: false });
  let n = 0;
  const logs = [];
  const sleep = async () => {
    n++;
    f.c.state.tip++;
    if (n === 2) f.c.state.outspends[`${f.txid}:0`] = { spent: true, txid: ctxid, vin: 0, confirmed: false, blockHeight: null };
  };
  const r = await live.watch({ client: f.c, sleep, log: (m) => logs.push(m) }, { txid: f.txid, vout: '0', intervalSeconds: '1', ...scriptArgs });
  assert.equal(r.watch.polls, 3);
  assert.equal(r.watch.stoppedBecause, 'spent');
  assert.equal(r.preimage, '0x' + hex(SECRET));
  assert.equal(logs.length, 2);
  const g = fundedChain();
  const r2 = await live.watch({ client: g.c, sleep: async () => { g.c.state.tip += 10; }, log: () => {} }, { txid: g.txid, vout: '0', untilHeight: String(TIP + 15), ...scriptArgs });
  assert.equal(r2.watch.stoppedBecause, 'until-height reached');
  assert.equal(r2.spent, false);
  const r3 = await live.watch({ client: g.c, sleep: async () => {}, log: () => {} }, { txid: g.txid, vout: '0', maxPolls: '2', ...scriptArgs });
  assert.equal(r3.watch.polls, 2);
});

test('parseArgs: flags, positionals, dry-run default, and the secret is never accepted on argv', () => {
  const p = live.parseArgs(['lock', '--key-file', 'k', '--hashlock', 'h', '--alice-pubkey', 'a', '--locktime', '5', '--amount-sats', '7', '--send']);
  assert.deepEqual(p, { command: 'lock', args: { keyFile: 'k', hashlock: 'h', alicePubkey: 'a', locktime: '5', amountSats: '7', send: true } });
  assert.equal(live.parseArgs(['claim', '--secret-file', 's']).args.secretFile, 's');
  assert.equal(live.parseArgs(['balance', 'tb1qx']).args.address, 'tb1qx');
  assert.equal(live.parseArgs(['broadcast', 'deadbeef']).args.hex, 'deadbeef');
  assert.throws(() => live.parseArgs(['claim', '--secret', 'x']), /unknown flag --secret/);
  assert.throws(() => live.parseArgs(['claim', '--preimage', 'x']), /unknown flag --preimage/);
  assert.throws(() => live.parseArgs(['lock', '--dry-run']), /unknown flag/); // dry run is the default, not a flag
  assert.throws(() => live.parseArgs(['nope']), /usage/);
  assert.throws(() => live.parseArgs(['tip', 'extra']), /unexpected argument/);
  assert.throws(() => live.parseArgs(['lock', '--key-file']), /needs a value/);
});
