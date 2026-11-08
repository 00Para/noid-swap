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
    async verifyChain() {
      s.verifyCalls = (s.verifyCalls || 0) + 1;
      if (s.wrongChain) throw new Error('API host https://mock.example/signet/api reports genesis 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f, not the signet genesis');
      return { genesis: 'mock', verified: [c.base], dropped: [] };
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
  // the secret is not in the default output: only that it was found, and its hash
  assert.equal(s.preimage, null);
  assert.equal(s.preimageFound, true);
  assert.equal(s.preimageHash, '0x' + HASHLOCK);
  assert.equal(s.preimageMatchesHashlock, true);
  assert.ok(!JSON.stringify(s).includes(hex(SECRET)));
  assert.equal(s.state, 'claimed (unconfirmed)');
  const sp = await live.status({ client: f.c }, { txid: f.txid, vout: '0', printSecret: true, ...scriptArgs });
  assert.equal(sp.preimage, '0x' + hex(SECRET));
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
  assert.equal(s.preimageFound, false);
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
  assert.equal(r.preimage, null, 'not printed unless asked');
  assert.equal(r.preimageFound, true);
  assert.equal(r.preimageHash, '0x' + HASHLOCK);
  assert.ok(!JSON.stringify(r).includes(hex(SECRET)));
  assert.equal(logs.length, 3, 'two "next poll" lines and the "spent" line');
  assert.ok(!logs.join(' | ').includes(hex(SECRET)));
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
  assert.throws(() => live.parseArgs(['claim', '--secret', 'x']), /never taken from the command line/);
  assert.throws(() => live.parseArgs(['claim', '--preimage', 'x']), /never taken from the command line/);
  assert.throws(() => live.parseArgs(['claim', '--secret=' + hex(SECRET)]), /never taken from the command line/);
  assert.throws(() => live.parseArgs(['watch', '--preimage', 'x']), /never taken from the command line/);
  assert.throws(() => live.parseArgs(['lock', '--dry-run']), /unknown flag/); // dry run is the default, not a flag
  assert.throws(() => live.parseArgs(['nope']), /usage/);
  assert.throws(() => live.parseArgs(['tip', 'extra']), /unexpected argument/);
  assert.throws(() => live.parseArgs(['lock', '--key-file']), /needs a value/);
});

// ================================================================ safety layer (fee ladder, watcher, swap file, guards)

const sha = sha256;
const UTXO_VALUE = 100000;

/** An unconfirmed claim of the funded HTLC, in the mock mempool (what `claim --send` would have left there). */
function pendingClaim(f, { rate = 3, sequence, destination = ALICE_DEST } = {}) {
  const b = htlc.buildClaimTx({
    redeemScript: RS, utxo: { txid: f.txid, vout: 0, value: UTXO_VALUE }, destination, network: 'signet',
    preimage: SECRET, keyPair: H.alice, feeRate: rate, ...(sequence === undefined ? {} : { sequence }),
  });
  const id = mine(f.c, b.hex, { confirmed: false });
  f.c.state.outspends[`${f.txid}:0`] = { spent: true, txid: id, vin: 0, confirmed: false, blockHeight: null };
  return { ...b, id };
}
function pendingRefund(f, { rate = 3, destination = BOB_ADDR } = {}) {
  const b = htlc.buildRefundTx({ redeemScript: RS, utxo: { txid: f.txid, vout: 0, value: UTXO_VALUE }, destination, network: 'signet', keyPair: H.bob, feeRate: rate });
  const id = mine(f.c, b.hex, { confirmed: false });
  f.c.state.outspends[`${f.txid}:0`] = { spent: true, txid: id, vin: 0, confirmed: false, blockHeight: null };
  return { ...b, id };
}
const claimAt = (f, extra = {}) => ({ ...claimArgs, txid: f.txid, vout: '0', ...extra });
const refundAt = (f, extra = {}) => ({ ...refundArgs, txid: f.txid, vout: '0', ...extra });

// ---------------------------------------------------------------- chain check

test('chain check: every command verifies the chain once per client; another chain is refused before anything else', async () => {
  const f = fundedChain();
  await live.watch({ client: f.c, sleep: async () => {}, log: () => {} }, { txid: f.txid, vout: '0', maxPolls: '3', ...scriptArgs });
  assert.equal(f.c.state.verifyCalls, 1, 'three polls, one chain check');
  const bad = mockClient({ wrongChain: true });
  await assert.rejects(() => live.tip({ client: bad }), /chain check failed.*not the signet genesis/s);
  await assert.rejects(() => live.balance({ client: bad }, { address: BOB_ADDR }), /chain check failed/);
  await assert.rejects(() => live.lock({ client: bad }, lockArgs), /chain check failed/);
  await assert.rejects(() => live.claim({ client: bad }, { ...claimArgs, txid: 'ab'.repeat(32), vout: '0' }), /chain check failed/);
  await assert.rejects(() => live.refund({ client: bad }, { ...refundArgs, txid: 'ab'.repeat(32), vout: '0' }), /chain check failed/);
  await assert.rejects(() => live.broadcast({ client: bad }, { hex: f.fundingHex, send: true }), /chain check failed/);
  await assert.rejects(() => live.watch({ client: bad }, { txid: 'ab'.repeat(32), ...scriptArgs }), /chain check failed/);
  assert.deepEqual(bad.state.broadcasts, []);
  // a client that cannot prove its chain is refused, never trusted
  const { verifyChain: _v, ...noVerify } = mockClient();
  await assert.rejects(() => live.tip({ client: noVerify }), /cannot verify the chain/);
});

// ---------------------------------------------------------------- keys

test('keys: an uncompressed key, and the wrong role key, are refused for lock, claim and refund', async () => {
  const unc = htlc.ECPair.fromPrivateKey(Buffer.from('03'.repeat(32), 'hex'), { network: bitcoin.networks.testnet, compressed: false }).toWIF();
  const uf = path.join(tmp, 'uncompressed.key');
  fs.writeFileSync(uf, unc + '\n');
  assert.match(unc, /^9/, 'testnet uncompressed WIF');
  assert.throws(() => live.loadKey(uf), /UNCOMPRESSED/);
  const f = fundedChain();
  // claim needs Alice's key, refund Bob's, lock funds from the key that becomes Bob's refund key
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { keyFile: BOB_KEY })), /not the Alice \(claim\) key/);
  f.c.state.tip = LOCKTIME;
  await assert.rejects(() => live.refund({ client: f.c }, refundAt(f, { keyFile: ALICE_KEY })), /not the Bob \(refund\) key/);
  await assert.rejects(() => live.lock({ client: f.c }, { ...lockArgs, keyFile: ALICE_KEY }), /differ|does not match|insufficient|no confirmed/);
  await assert.rejects(() => live.lock({ client: f.c }, { ...lockArgs, keyFile: uf }), /UNCOMPRESSED/);
  // errors never carry key material
  for (const k of [H.alice.toWIF(), H.bob.toWIF(), unc]) {
    await live.claim({ client: f.c }, claimAt(f, { keyFile: BOB_KEY })).catch((e) => assert.ok(!e.message.includes(k)));
  }
});

test('script terms next to --witness-script must agree with it (never silently ignored)', async () => {
  const f = fundedChain();
  const r = await live.status({ client: f.c }, { txid: f.txid, vout: '0', ...scriptArgs, hashlock: HASHLOCK, locktime: String(LOCKTIME) });
  assert.equal(r.funded, true);
  await assert.rejects(() => live.status({ client: f.c }, { txid: f.txid, ...scriptArgs, hashlock: 'ee'.repeat(32) }), /--hashlock disagrees with --witness-script/);
  await assert.rejects(() => live.status({ client: f.c }, { txid: f.txid, ...scriptArgs, locktime: String(LOCKTIME + 1) }), /--locktime disagrees/);
  await assert.rejects(() => live.status({ client: f.c }, { txid: f.txid, ...scriptArgs, alicePubkey: H.BOB_PUB_HEX }), /--alice-pubkey disagrees/);
  await assert.rejects(() => live.status({ client: f.c }, { txid: f.txid, ...scriptArgs, bobPubkey: H.ALICE_PUB_HEX }), /--bob-pubkey disagrees/);
});

// ---------------------------------------------------------------- secret never on argv

test('secret handling: never on argv, and a claim hex (which carries it) is not accepted on argv either', async () => {
  for (const flag of ['--secret', '--preimage', '--s', '--x']) {
    assert.throws(() => live.parseArgs(['claim', flag, hex(SECRET)]), /never taken from the command line/);
  }
  assert.throws(() => live.parseArgs(['claim', `--secret=${hex(SECRET)}`]), /never taken from the command line/);
  const f = fundedChain();
  const c = await live.claim({ client: f.c }, claimAt(f));
  // positional hex of a claim: refused (process listing / shell history), with a pointer to the safe inputs
  await assert.rejects(() => live.broadcast({ client: f.c }, { hex: c.hex, send: true }), /publishes a swap secret.*--hex-file.*--hex-stdin/s);
  assert.deepEqual(f.c.state.broadcasts, []);
  // the same hex from a file or from stdin goes through
  const hf = path.join(tmp, 'claim.hex');
  fs.writeFileSync(hf, c.hex + '\n');
  const viaFile = await live.broadcast({ client: f.c }, { hexFile: hf });
  assert.equal(viaFile.txid, c.txid);
  assert.equal(viaFile.revealsSecret, true);
  assert.ok(!JSON.stringify(viaFile).includes(hex(SECRET)), 'the decoded view does not print the secret');
  const viaStdin = await live.broadcast({ client: f.c, stdin: c.hex }, { hexStdin: true, send: true });
  assert.equal(viaStdin.sent, true);
  assert.deepEqual(f.c.state.broadcasts, [c.hex]);
  // exactly one source
  await assert.rejects(() => live.broadcast({ client: f.c }, { hex: f.fundingHex, hexFile: hf }), /exactly one of/);
  await assert.rejects(() => live.broadcast({ client: f.c }, {}), /exactly one of/);
  await assert.rejects(() => live.broadcast({ client: f.c }, { hexFile: path.join(tmp, 'nope.hex') }), /not found/);
  // a non-claim on argv is still fine (the funding tx in the existing test); and it says it does not reveal
  assert.equal((await live.broadcast({ client: f.c }, { hex: f.fundingHex })).revealsSecret, false);
  // stdout that is a file is refused for secret output; a pipe is fine
  assert.throws(() => live.assertStdoutNotFile({ isFile: () => true }, '--print-secret output'), /stdout is a file/);
  assert.doesNotThrow(() => live.assertStdoutNotFile({ isFile: () => false }, 'x'));
  assert.doesNotThrow(() => live.assertStdoutNotFile(null, 'x'));
});

test('claim: needs 3 confirmations on the funding (design step 9) unless --min-confirmations lowers it', async () => {
  const f = fundedChain(); // mined at TIP-3, tip TIP: 4 confirmations
  f.c.state.tip = TIP - 2 + 0; // the funding is at TIP-3: tip TIP-2 gives 2 confirmations
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f)), /2 confirmation\(s\).*wants 3/);
  assert.equal((await live.claim({ client: f.c }, claimAt(f, { minConfirmations: '2' }))).dryRun, true);
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { minConfirmations: '3' })), /2 confirmation/);
  f.c.state.tip = TIP - 1;
  assert.equal((await live.claim({ client: f.c }, claimAt(f))).dryRun, true, '3 confirmations is enough');
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { minConfirmations: '0' })), /--min-confirmations/);
});

// ---------------------------------------------------------------- fee ladder

test('fee floor: a --fee-rate below the explorer estimate (2-block target) is refused for claim and refund, also in a dry run', async () => {
  const f = fundedChain();
  f.c.state.fee = 8;
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { feeRate: '7' })), /below the explorer's estimate of 8 sat\/vB for a 2-block target/);
  const ok = await live.claim({ client: f.c }, claimAt(f, { feeRate: '8' }));
  assert.deepEqual(ok.feeCheck, { target: 2, estimate: 8, chosen: 8, ok: true, floor: 'hard' });
  assert.equal(ok.feeRate, 8);
  assert.equal(ok.feeRateSource, 'flag');
  const above = await live.claim({ client: f.c }, claimAt(f, { feeRate: '20' }));
  assert.equal(above.feeCheck.chosen, 20);
  assert.equal((await live.claim({ client: f.c }, claimAt(f))).feeCheck.chosen, 8, 'default = the estimate');
  assert.deepEqual(f.c.state.broadcasts, []);
  f.c.state.tip = LOCKTIME;
  await assert.rejects(() => live.refund({ client: f.c }, refundAt(f, { feeRate: '2' })), /below the explorer's estimate of 8/);
  assert.equal((await live.refund({ client: f.c }, refundAt(f, { feeRate: '9' }))).feeCheck.chosen, 9);
  // lock only reports (its funding tx is Bob's own risk): a warning, not a refusal
  const l = await live.lock({ client: mockClient({ fee: 8 }) }, { ...lockArgs, feeRate: '2' });
  assert.equal(l.feeCheck.ok, false);
  assert.match(l.warnings.join(' '), /below the explorer's estimate 8/);
  // the cap still holds: an estimate of 3,901 is clamped to 50, so 50 is the highest rate ever demanded
  f.c.state.fee = 50;
  f.c.state.tip = TIP;
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { feeRate: '49' })), /below the explorer's estimate of 50/);
  assert.equal((await live.claim({ client: f.c }, claimAt(f, { feeRate: '50' }))).dryRun, true);
});

test('fee floor: an unreadable estimate refuses a claim (no fee chosen blind)', async () => {
  const f = fundedChain();
  f.c.feeRate = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f)), /cannot read the explorer's fee estimate.*503/);
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { feeRate: '40' })), /cannot read the explorer's fee estimate/);
});

test('claim --replace: the same spend at a higher fee (BIP-125), found through the explorer', async () => {
  const f = fundedChain();
  const old = pendingClaim(f, { rate: 3 });
  const oldTx = bitcoin.Transaction.fromHex(old.hex);
  const oldFee = UTXO_VALUE - Number(oldTx.outs[0].value);
  const r = await live.claim({ client: f.c }, claimAt(f, { replace: true }));
  assert.equal(r.replace, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.sent, false);
  assert.deepEqual(f.c.state.broadcasts, []);
  const tx = bitcoin.Transaction.fromHex(r.hex);
  // the SAME spend: same input, same payout script, same sequence and locktime, same preimage
  assert.equal(hex(Buffer.from(tx.ins[0].hash).reverse()), f.txid);
  assert.equal(tx.ins[0].index, 0);
  assert.equal(hex(tx.outs[0].script), hex(oldTx.outs[0].script));
  assert.equal(tx.ins[0].sequence, 0xfffffffd);
  assert.equal(tx.locktime, 0);
  assert.equal(hex(extractPreimage(r.hex, { hashlock: HASHLOCK })), hex(SECRET));
  assert.notEqual(r.txid, old.id);
  // BIP-125: absolute fee up by >= 1 sat/vB of the new size, rate up by >= 1 sat/vB
  assert.ok(r.fee >= oldFee + Math.ceil(r.vsize), `fee ${r.fee} vs old ${oldFee} + vsize ${r.vsize}`);
  assert.ok(r.fee / r.vsize >= oldFee / oldTx.virtualSize() + 1);
  assert.ok(r.feeRate >= 4);
  assert.match(r.feeRateSource, /raised to .* BIP-125/);
  assert.equal(r.bip125.replaces, old.id);
  assert.equal(r.bip125.oldFee, oldFee);
  assert.equal(r.bip125.incrementSatPerVb, 1);
  assert.ok(r.fee >= r.bip125.minFee);
  assert.equal(r.outputSats + r.fee, UTXO_VALUE);
  // --send broadcasts exactly this hex, once
  const s = await live.claim({ client: f.c }, claimAt(f, { replace: true, send: true }));
  assert.equal(s.sent, true);
  assert.deepEqual(f.c.state.broadcasts, [s.hex]);
});

test('claim --replace: an explicit --fee-rate must clear the increment; the refusal names the minimum, which then works', async () => {
  const f = fundedChain();
  pendingClaim(f, { rate: 10 });
  f.c.state.fee = 3;
  const e = await live.claim({ client: f.c }, claimAt(f, { replace: true, feeRate: '10' })).catch((x) => x);
  assert.ok(e instanceof live.UserError);
  assert.match(e.message, /does not replace the pending spend.*use at least --fee-rate (\d+)/s);
  const min = Number(/use at least --fee-rate (\d+)/.exec(e.message)[1]);
  assert.ok(min >= 11);
  const ok = await live.claim({ client: f.c }, claimAt(f, { replace: true, feeRate: String(min) }));
  assert.equal(ok.feeRate, min);
  assert.equal(ok.feeRateSource, 'flag');
  // one below the named minimum still fails
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { replace: true, feeRate: String(min - 1) })), /does not replace/);
  // the estimate floor applies to a replacement too
  f.c.state.fee = 30;
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { replace: true, feeRate: '25' })), /below the explorer's estimate of 30/);
  // the default raises to max(estimate, minimum)
  const auto = await live.claim({ client: f.c }, claimAt(f, { replace: true }));
  assert.equal(auto.feeRate, 30);
});

test('claim --replace: refused when nothing is pending, the spend is confirmed, or it is not our claim', async () => {
  // unspent outpoint
  const u = fundedChain();
  await assert.rejects(() => live.claim({ client: u.c }, claimAt(u, { replace: true })), /nothing to replace.*unspent/);
  // already confirmed
  const c = fundedChain();
  const old = pendingClaim(c);
  c.c.state.outspends[`${c.txid}:0`] = { spent: true, txid: old.id, vin: 0, confirmed: true, blockHeight: TIP };
  await assert.rejects(() => live.claim({ client: c.c }, claimAt(c, { replace: true })), /already spent by .*confirmed in block \d+; nothing to replace/);
  assert.deepEqual(c.c.state.broadcasts, []);
  // a pending REFUND (Bob's) is not a claim to replace
  const r = fundedChain();
  r.c.state.tip = LOCKTIME - 7; // inside the claim window, but a refund is in the mempool (e.g. a stale view)
  pendingRefund(r);
  await assert.rejects(() => live.claim({ client: r.c }, claimAt(r, { replace: true })), /is a refund spend, not a claim/);
  // the pending claim pays somebody else: a replacement must pay the same script
  const d = fundedChain();
  pendingClaim(d, { destination: 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7' });
  await assert.rejects(() => live.claim({ client: d.c }, claimAt(d, { replace: true })), /pays another destination than --to/);
  // the pending claim does not signal RBF: it cannot be replaced
  const n = fundedChain();
  pendingClaim(n, { sequence: 0xffffffff });
  await assert.rejects(() => live.claim({ client: n.c }, claimAt(n, { replace: true })), /does not signal RBF/);
  // the explorer lost the pending tx
  const g = fundedChain();
  const gone = pendingClaim(g);
  delete g.c.state.hexes[gone.id];
  await assert.rejects(() => live.claim({ client: g.c }, claimAt(g, { replace: true })), /no longer has the pending spend/);
  // a plain claim (no --replace) over a pending one is refused and points at --replace
  const p = fundedChain();
  pendingClaim(p);
  await assert.rejects(() => live.claim({ client: p.c }, claimAt(p)), /already spent by .*unconfirmed.*--replace/s);
  // a hex that is not the txid it was asked for is not trusted
  const w = fundedChain();
  const real = pendingClaim(w);
  const other = htlc.buildClaimTx({ redeemScript: RS, utxo: { txid: w.txid, vout: 0, value: UTXO_VALUE }, destination: ALICE_DEST, network: 'signet', preimage: SECRET, keyPair: H.alice, feeRate: 9 });
  w.c.state.hexes[real.id] = other.hex;
  await assert.rejects(() => live.claim({ client: w.c }, claimAt(w, { replace: true })), /does not match its txid/);
});

test('claim --replace: refused past the cutoff (T_b - 6) like any claim; --ignore-cutoff overrides with a warning', async () => {
  const f = fundedChain();
  pendingClaim(f);
  f.c.state.tip = LOCKTIME - 6;
  assert.equal((await live.claim({ client: f.c }, claimAt(f, { replace: true }))).dryRun, true, 'at the cutoff is still allowed');
  f.c.state.tip = LOCKTIME - 5;
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { replace: true })), /past the claim cutoff/);
  const forced = await live.claim({ client: f.c }, claimAt(f, { replace: true, ignoreCutoff: true }));
  assert.match(forced.warnings[0], /past the claim cutoff/);
  assert.deepEqual(f.c.state.broadcasts, []);
});

test('claim --replace: no rate up to the cap can replace a pending spend that already pays the cap', async () => {
  const f = fundedChain();
  pendingClaim(f, { rate: 50 });
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { replace: true })), /no fee rate up to the 50 sat\/vB cap/);
});

test('refund --replace: Bob re-sends the same refund at a higher fee under the same rules', async () => {
  const f = fundedChain();
  f.c.state.tip = LOCKTIME;
  await assert.rejects(() => live.refund({ client: f.c }, refundAt(f, { replace: true })), /nothing to replace/);
  const old = pendingRefund(f, { rate: 3 });
  const r = await live.refund({ client: f.c }, refundAt(f, { replace: true }));
  const tx = bitcoin.Transaction.fromHex(r.hex);
  assert.equal(tx.locktime, LOCKTIME);
  assert.equal(tx.ins[0].sequence, 0xfffffffd);
  assert.equal(r.bip125.replaces, old.id);
  assert.ok(r.fee > old.fee);
  assert.equal(extractPreimage(r.hex, { hashlock: HASHLOCK }), null);
  // an unrelated pending claim is not a refund to replace
  const g = fundedChain();
  g.c.state.tip = LOCKTIME;
  pendingClaim(g);
  await assert.rejects(() => live.refund({ client: g.c }, refundAt(g, { replace: true })), /is a claim spend, not a refund/);
});

// ---------------------------------------------------------------- Bob's watcher

test('watch --lock TXID:VOUT: finds the preimage in an UNCONFIRMED claim, checks it against the hashlock, prints it only on request', async () => {
  const f = fundedChain();
  const claim = pendingClaim(f);
  f.c.state.tip = TIP + 1;
  const lockRef = `${f.txid}:0`;
  const logs = [];
  const r = await live.watch({ client: f.c, sleep: async () => {}, log: (m) => logs.push(m) }, { lock: lockRef, ...scriptArgs });
  assert.equal(r.watch.stoppedBecause, 'spent');
  assert.equal(r.spend.txid, claim.id);
  assert.equal(r.spend.confirmed, false, 'seen in the mempool, not waited for a block');
  assert.equal(r.spend.branch, 'claim');
  assert.equal(r.preimageFound, true);
  assert.equal(r.preimageHash, '0x' + HASHLOCK);
  assert.equal(r.preimageMatchesHashlock, true);
  assert.equal(r.preimage, null);
  assert.ok(!JSON.stringify(r).includes(hex(SECRET)));
  assert.ok(!logs.join(' | ').includes(hex(SECRET)));
  assert.match(logs.join(' | '), /preimage found, sha256 0x/);
  // --print-secret: the value, in the JSON result only
  const p = await live.watch({ client: f.c, sleep: async () => {}, log: (m) => logs.push(m) }, { lock: lockRef, printSecret: true, ...scriptArgs });
  assert.equal(p.preimage, '0x' + hex(SECRET));
  assert.equal(sha256(Buffer.from(p.preimage.slice(2), 'hex')).toString('hex'), HASHLOCK);
  assert.ok(!logs.join(' | ').includes(hex(SECRET)), 'never on stderr');
  // --lock and --txid/--vout must agree; a malformed outpoint is refused
  await assert.rejects(() => live.watch({ client: f.c }, { lock: lockRef, txid: 'cd'.repeat(32), ...scriptArgs }), /--txid disagrees with --lock/);
  await assert.rejects(() => live.watch({ client: f.c }, { lock: lockRef, vout: '1', ...scriptArgs }), /--vout disagrees with --lock/);
  await assert.rejects(() => live.watch({ client: f.c }, { lock: f.txid, ...scriptArgs }), /--lock must be TXID:VOUT/);
  await assert.rejects(() => live.watch({ client: f.c }, { lock: `${f.txid}:x`, ...scriptArgs }), /--lock must be TXID:VOUT/);
});

test('watch: never writes the secret anywhere (no file API is called while the preimage is read and printed)', async () => {
  const f = fundedChain();
  pendingClaim(f);
  const calls = [];
  const names = ['writeFileSync', 'appendFileSync', 'writeSync', 'createWriteStream', 'openSync', 'writeFile', 'appendFile'];
  const saved = {};
  for (const n of names) {
    saved[n] = fs[n];
    fs[n] = (...a) => { calls.push(n); return saved[n](...a); };
  }
  let r;
  try {
    r = await live.watch({ client: f.c, sleep: async () => {}, log: () => {} }, { lock: `${f.txid}:0`, printSecret: true, ...scriptArgs });
  } finally {
    for (const n of names) fs[n] = saved[n];
  }
  assert.equal(r.preimage, '0x' + hex(SECRET));
  assert.deepEqual(calls, []);
});

test('watch: a refund spend yields no preimage; a spend the explorer cannot show yet keeps the watcher polling', async () => {
  const f = fundedChain();
  f.c.state.tip = LOCKTIME;
  pendingRefund(f);
  const r = await live.watch({ client: f.c, sleep: async () => {}, log: () => {} }, { lock: `${f.txid}:0`, printSecret: true, ...scriptArgs });
  assert.equal(r.spend.branch, 'refund');
  assert.equal(r.preimageFound, false);
  assert.equal(r.preimage, null);
  // outspend says "spent" but the tx hex is not served yet: that is not "no reveal"
  const g = fundedChain();
  const c = pendingClaim(g);
  const hexKept = g.c.state.hexes[c.id];
  delete g.c.state.hexes[c.id];
  let n = 0;
  const sleep = async () => { n++; if (n === 2) g.c.state.hexes[c.id] = hexKept; };
  const logs = [];
  const w = await live.watch({ client: g.c, sleep, log: (m) => logs.push(m) }, { lock: `${g.txid}:0`, ...scriptArgs });
  assert.equal(w.watch.polls, 3);
  assert.equal(w.preimageFound, true);
  // with a polling budget that runs out first, the caller sees spent:true but no branch, and a clear stop reason
  const h = fundedChain();
  const c2 = pendingClaim(h);
  delete h.c.state.hexes[c2.id];
  const w2 = await live.watch({ client: h.c, sleep: async () => {}, log: () => {} }, { lock: `${h.txid}:0`, maxPolls: '2', ...scriptArgs });
  assert.equal(w2.watch.stoppedBecause, 'max-polls reached');
  assert.equal(w2.spend.branch, null);
  assert.equal(w2.preimageFound, false);
});

test('watch/status: a transaction the explorer returns for the wrong txid or the wrong input is never read for a preimage', async () => {
  const f = fundedChain();
  const c = pendingClaim(f);
  // a different valid claim hex served under the pending txid
  const other = htlc.buildClaimTx({ redeemScript: RS, utxo: { txid: f.txid, vout: 0, value: UTXO_VALUE }, destination: ALICE_DEST, network: 'signet', preimage: SECRET, keyPair: H.alice, feeRate: 11 });
  f.c.state.hexes[c.id] = other.hex;
  const s = await live.status({ client: f.c }, { lock: `${f.txid}:0`, printSecret: true, ...scriptArgs });
  assert.equal(s.spend.branch, 'unknown');
  assert.equal(s.spend.scriptCheck.ok, false);
  assert.equal(s.preimageFound, false);
  assert.equal(s.preimage, null);
  // outspend names input 1 of a one-input tx
  const g = fundedChain();
  const c2 = pendingClaim(g);
  g.c.state.outspends[`${g.txid}:0`] = { spent: true, txid: c2.id, vin: 1, confirmed: false, blockHeight: null };
  const s2 = await live.status({ client: g.c }, { lock: `${g.txid}:0`, printSecret: true, ...scriptArgs });
  assert.equal(s2.spend.branch, 'unknown');
  assert.equal(s2.preimage, null);
});

test('extractPreimage with inputIndex reads only the input that spends your outpoint', () => {
  const claim = htlc.buildClaimTx({ redeemScript: RS, utxo: { txid: 'aa'.repeat(32), vout: 0, value: UTXO_VALUE }, destination: ALICE_DEST, network: 'signet', preimage: SECRET, keyPair: H.alice, feeRate: 3 });
  assert.equal(hex(extractPreimage(claim.hex, { hashlock: HASHLOCK, inputIndex: 0 })), hex(SECRET));
  assert.equal(extractPreimage(claim.hex, { hashlock: HASHLOCK, inputIndex: 1 }), null);
  // two inputs: the claim witness sits in input 1 of a bigger tx; asking for input 0 must not find it
  const tx = bitcoin.Transaction.fromHex(claim.hex);
  const two = new bitcoin.Transaction();
  two.version = 2;
  two.addInput(Buffer.alloc(32, 7), 0, 0xfffffffd);
  two.addInput(Buffer.from(tx.ins[0].hash), 0, 0xfffffffd);
  two.addOutput(tx.outs[0].script, tx.outs[0].value);
  two.setWitness(0, [Buffer.alloc(64, 1), Buffer.alloc(33, 2)]);
  two.setWitness(1, tx.ins[0].witness.map((w) => Buffer.from(w)));
  assert.equal(extractPreimage(two, { hashlock: HASHLOCK, inputIndex: 0 }), null);
  assert.equal(hex(extractPreimage(two, { hashlock: HASHLOCK, inputIndex: 1 })), hex(SECRET));
  assert.equal(hex(extractPreimage(two, { hashlock: HASHLOCK })), hex(SECRET));
});

// ---------------------------------------------------------------- swap file

const SEAL_SENTINEL = 'SEALED-SECRET-SENTINEL-do-not-read';
function writeSwap(name, over = {}) {
  const role = over.role || 'bob';
  const j = {
    version: 1,
    role,
    created_at: 1,
    public: {
      hashlock: '0x' + (over.hashlock || HASHLOCK),
      claim_authority: 'o1x',
      opening_hex: '00',
      contract_root: 'o1y',
      params: { variant: 'raw', amount_micronoid: 10000000, deadline_height: 300735, eth: { chain_id: 31337, contract: '0x' + '11'.repeat(20) }, ...(over.params || {}) },
    },
    phase: { role, phase: role === 'alice' ? 'lock_final' : 'funding_final' },
    history: [],
    ...(role === 'alice' ? { secret: { nonce: SEAL_SENTINEL, ciphertext: SEAL_SENTINEL } } : {}),
    ...(over.top || {}),
  };
  if (over.phase) j.phase = over.phase;
  const f = path.join(tmp, `${name}.swap.json`);
  fs.writeFileSync(f, typeof over.raw === 'string' ? over.raw : JSON.stringify(j));
  return f;
}

test('swap file: lock takes the hashlock from the file, a given --hashlock must equal it, the role must be Bob', async () => {
  const bobFile = writeSwap('bob-ok');
  const c = mockClient();
  const { hashlock: _h, ...noHash } = lockArgs;
  const r = await live.lock({ client: c }, { ...noHash, swap: bobFile });
  assert.equal(r.hashlock, HASHLOCK);
  assert.equal(r.address, HTLC_ADDR);
  assert.equal(r.swap.file, path.resolve(bobFile));
  assert.equal(r.swap.role, 'bob');
  assert.equal(r.swap.phase, 'funding_final');
  assert.equal(r.swap.profile, 'production');
  assert.match(r.swap.warnings.join(' '), /NOID<->ETH file/);
  assert.match(r.swap.warnings.join(' '), /no Bitcoin terms/);
  // the same hashlock given explicitly (with or without 0x) is fine
  assert.equal((await live.lock({ client: c }, { ...lockArgs, hashlock: '0x' + HASHLOCK, swap: bobFile })).dryRun, true);
  // a different hashlock is refused, with both values in the message
  const other = hex(sha256(Buffer.from('another secret')));
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, hashlock: other, swap: bobFile }), (e) => /--hashlock disagrees with the swap file/.test(e.message) && e.message.includes(other) && e.message.includes(HASHLOCK));
  // a file for another hashlock is refused through the flag-less path too (file's hashlock is what gets locked, so the address differs from the expected one)
  const otherFile = writeSwap('bob-other', { hashlock: other });
  const lockedOther = await live.lock({ client: c }, { ...noHash, swap: otherFile });
  assert.equal(lockedOther.hashlock, other);
  assert.notEqual(lockedOther.address, HTLC_ADDR);
  // Alice's file cannot be used to lock; neither can a file whose swap is over
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, swap: writeSwap('alice-lock', { role: 'alice' }) }), /lock is bob's command but the swap file is alice's/);
  for (const phase of ['refunded', 'aborted']) {
    await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, swap: writeSwap(`bob-${phase}`, { phase: { role: 'bob', phase } }) }), new RegExp(`finished phase "${phase}"`));
  }
  assert.deepEqual(c.state.broadcasts, []);
});

test('swap file: claim needs Alice\'s file and the script\'s hashlock; the sealed secret is never read or printed; refund works after an abort', async () => {
  const f = fundedChain();
  const aliceFile = writeSwap('alice-ok', { role: 'alice' });
  const r = await live.claim({ client: f.c }, claimAt(f, { swap: aliceFile }));
  assert.equal(r.swap.role, 'alice');
  assert.ok(!JSON.stringify(r).includes(SEAL_SENTINEL), 'the file\'s secret blob is not touched');
  assert.deepEqual(f.c.state.broadcasts, []);
  // role
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { swap: writeSwap('bob-claim') })), /claim is alice's command but the swap file is bob's/);
  // script bound to another hashlock than the file's
  await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { swap: writeSwap('alice-other', { role: 'alice', hashlock: 'ee'.repeat(32) }) })), /script's hashlock .* is not the swap file's/);
  // finished swap (Alice's NOID refunded / secret lost): no new claim
  for (const phase of ['refunded', 'lost', 'aborted']) {
    await assert.rejects(() => live.claim({ client: f.c }, claimAt(f, { swap: writeSwap(`alice-${phase}`, { role: 'alice', phase: { role: 'alice', phase } }) })), new RegExp(`finished phase "${phase}"`));
  }
  // refund is exactly what a finished Bob needs: allowed under an aborted file
  f.c.state.tip = LOCKTIME;
  const bobAborted = writeSwap('bob-aborted2', { phase: { role: 'bob', phase: 'aborted' } });
  const rf = await live.refund({ client: f.c }, refundAt(f, { swap: bobAborted }));
  assert.equal(rf.swap.phase, 'aborted');
  await assert.rejects(() => live.refund({ client: f.c }, refundAt(f, { swap: aliceFile })), /refund is bob's command but the swap file is alice's/);
  // watch / status take either role, and check the hashlock
  const w = await live.status({ client: f.c }, { lock: `${f.txid}:0`, ...scriptArgs, swap: aliceFile });
  assert.equal(w.swap.role, 'alice');
  await assert.rejects(() => live.status({ client: f.c }, { lock: `${f.txid}:0`, ...scriptArgs, swap: writeSwap('bob-other2', { hashlock: 'ee'.repeat(32) }) }), /script's hashlock .* is not the swap file's/);
});

test('swap file: unreadable, foreign or inconsistent files are refused', async () => {
  const c = mockClient();
  const bad = (raw, re, name) => assert.rejects(() => live.lock({ client: c }, { ...lockArgs, swap: writeSwap(name, { raw }) }), re);
  await assert.rejects(() => live.lock({ client: c }, { ...lockArgs, swap: path.join(tmp, 'missing.swap.json') }), /swap file not found/);
  await bad('not json', /not valid JSON/, 'bad1');
  await bad('{}', /is it a swap-cli swap file/, 'bad2');
  await bad(JSON.stringify({ version: 2, role: 'bob', public: { hashlock: '0x' + HASHLOCK }, phase: { role: 'bob', phase: 'received' } }), /file version 2/, 'bad3');
  await bad(JSON.stringify({ version: 1, role: 'carol', public: { hashlock: '0x' + HASHLOCK }, phase: { role: 'bob', phase: 'received' } }), /role "carol"/, 'bad4');
  await bad(JSON.stringify({ version: 1, role: 'bob', public: { hashlock: '0x' + HASHLOCK }, phase: { role: 'alice', phase: 'created' } }), /phase belongs to alice but the file's role is bob/, 'bad5');
  await bad(JSON.stringify({ version: 1, role: 'bob', public: { hashlock: '0x1234' }, phase: { role: 'bob', phase: 'received' } }), /swap file hashlock/, 'bad6');
  const sw = live.readSwapFile(writeSwap('ok-read2', { params: { profile: 'sepolia' } }));
  assert.deepEqual(Object.keys(sw).sort(), ['file', 'hasBtcTerms', 'hashlock', 'isEthPair', 'phase', 'profile', 'role']);
  assert.equal(sw.profile, 'sepolia');
  assert.equal(sw.hasBtcTerms, false);
});

test('parseArgs: the new flags', () => {
  assert.deepEqual(live.parseArgs(['claim', '--replace', '--fee-rate', '9', '--swap', 's.json', '--lock', 'a:0', '--min-confirmations', '2']).args, { replace: true, feeRate: '9', swap: 's.json', lock: 'a:0', minConfirmations: '2' });
  assert.deepEqual(live.parseArgs(['refund', '--replace']).args, { replace: true });
  assert.deepEqual(live.parseArgs(['watch', '--lock', 'a:0', '--print-secret', '--swap', 's']).args, { lock: 'a:0', printSecret: true, swap: 's' });
  assert.deepEqual(live.parseArgs(['status', '--print-secret']).args, { printSecret: true });
  assert.deepEqual(live.parseArgs(['lock', '--swap', 's']).args, { swap: 's' });
  assert.deepEqual(live.parseArgs(['broadcast', '--hex-stdin', '--send']).args, { hexStdin: true, send: true });
  assert.deepEqual(live.parseArgs(['broadcast', '--hex-file', 'f']).args, { hexFile: 'f' });
  assert.throws(() => live.parseArgs(['lock', '--replace']), /unknown flag --replace/);
  assert.throws(() => live.parseArgs(['claim', '--print-secret']), /unknown flag --print-secret/);
  assert.throws(() => live.parseArgs(['tip', '--swap', 's']), /unknown flag/);
});
