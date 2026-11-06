'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bitcoin = require('bitcoinjs-lib');
const fund = require('../src/fund');
const htlc = require('../src/htlc');
const H = require('./helpers');

const hex = (b) => Buffer.from(b).toString('hex');

// Bob (priv key 2) funds the HTLC from two fixed P2WPKH utxos.
const UTXOS = [
  { txid: '11'.repeat(32), vout: 0, value: 50000 },
  { txid: '22'.repeat(32), vout: 3, value: 120000 },
  { txid: '33'.repeat(32), vout: 1, value: 1000 },
];
const AMOUNT = 100000;

function build(over = {}) {
  return fund.buildFundingTx({ keyPair: H.bob, utxos: UTXOS, witnessScript: H.redeemScript(), amount: AMOUNT, feeRate: 2, network: 'signet', ...over });
}

test('p2wpkh address/scriptCode for the fixture key (2G) match bitcoinjs payments', () => {
  const me = fund.p2wpkh(H.bob.publicKey, 'signet');
  const lib = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(H.bob.publicKey), network: bitcoin.networks.testnet });
  assert.equal(me.address, lib.address);
  assert.match(me.address, /^tb1q/);
  assert.equal(hex(me.scriptPubKey), hex(lib.output));
  assert.equal(hex(me.scriptCode), '76a914' + hex(me.scriptPubKey.subarray(2)) + '88ac');
});

test('funding tx: deterministic known-good hex, structure, P2WSH output, change, signatures', () => {
  const b = build();
  // RFC6979 + low-R signing is deterministic, so the hex is a stable fixture (see the golden test below).
  const tx = bitcoin.Transaction.fromHex(b.hex);
  assert.equal(tx.getId(), b.txid);
  assert.equal(b.vout, 0);
  assert.equal(tx.version, 2);
  assert.equal(tx.locktime, 0);
  // largest-first: the 120,000 utxo alone covers 100,000 + fee
  assert.equal(tx.ins.length, 1);
  assert.equal(hex(Buffer.from(tx.ins[0].hash).reverse()), '22'.repeat(32));
  assert.equal(tx.ins[0].index, 3);
  assert.equal(tx.ins[0].sequence, 0xfffffffd, 'RBF');
  assert.equal(tx.ins[0].script.length, 0);
  // output 0 = the HTLC
  assert.equal(tx.outs.length, 2);
  assert.equal(hex(tx.outs[0].script), hex(htlc.p2wshScriptPubKey(H.redeemScript())));
  assert.equal(Number(tx.outs[0].value), AMOUNT);
  assert.equal(b.address, htlc.p2wshAddress(H.redeemScript(), 'signet'));
  // output 1 = change to Bob's own P2WPKH
  const me = fund.p2wpkh(H.bob.publicKey, 'signet');
  assert.equal(hex(tx.outs[1].script), hex(me.scriptPubKey));
  assert.equal(Number(tx.outs[1].value), b.change);
  assert.equal(b.changeAddress, me.address);
  assert.equal(120000 - AMOUNT - b.fee, b.change);
  assert.equal(b.fee, 2 * b.vsize, 'fee = feeRate * vsize of the dummy-signed estimate');
  assert.ok(b.vsize >= 150 && b.vsize <= 156, `1 P2WPKH in, P2WSH + P2WPKH out: 10.5 + 68 + 43 + 31 = ~153 vB (got ${b.vsize})`);
  // witness [sig, pubkey], signature verifies (independent check)
  const w = tx.ins[0].witness.map((x) => Buffer.from(x));
  assert.equal(w.length, 2);
  assert.equal(hex(w[1]), H.BOB_PUB_HEX);
  const { signature, hashType } = bitcoin.script.signature.decode(w[0]);
  assert.equal(hashType, 1);
  const digest = tx.hashForWitnessV0(0, me.scriptCode, 120000n, 1);
  assert.ok(H.bob.verify(digest, signature));
  assert.ok(!H.alice.verify(digest, signature));
  assert.deepEqual(fund.checkFundingTx(b.hex, { pubkey: H.bob.publicKey, inputValues: [120000] }), { ok: true, errors: [] });
  assert.equal(fund.checkFundingTx(b.hex, { pubkey: H.bob.publicKey, inputValues: [120001] }).ok, false, 'sig commits to the amount');
  assert.equal(fund.checkFundingTx(b.hex, { pubkey: H.alice.publicKey, inputValues: [120000] }).ok, false);
  // deterministic
  assert.equal(build().hex, b.hex);
});

// The golden fixture is a snapshot of buildFundingTx() for fully fixed inputs: Bob = private key 2,
// three fixed utxos, amount 100000, feeRate 2, and witnessScript = helpers.redeemScript() (the design's
// section 3.1 script, with OP_SIZE 32 OP_EQUALVERIFY). Nothing random is involved: ECDSA signing is
// RFC6979 (deterministic) with low-R grinding, and the txid/hex follow from the inputs. It changes
// exactly when the HTLC script, the funding builder, or these inputs change.
//
// To regenerate it deterministically after an intended change (and review the diff by hand):
//     cd btc && REGEN_GOLDEN=1 node --test test/fund.test.js
// which rewrites test/fixtures/funding-golden.json from build() below; a normal run only compares.
const GOLDEN_PATH = require('path').join(__dirname, 'fixtures', 'funding-golden.json');
// Independent of the builder: the design's serialized witnessScript for the fixture terms (see
// htlc.test.js), written out literally, and the P2WSH program it must hash to.
const DESIGN_WITNESS_SCRIPT_HEX =
  '63820120' + '88a820' + H.HASHLOCK_HEX + '88' + '21' + H.ALICE_PUB_HEX + '67' + '03a02526' + 'b175' + '21' + H.BOB_PUB_HEX + '68ac';

test('funding tx: golden hex is stable', () => {
  const b = build();
  if (process.env.REGEN_GOLDEN === '1') {
    const old = JSON.parse(require('fs').readFileSync(GOLDEN_PATH, 'utf8'));
    require('fs').writeFileSync(
      GOLDEN_PATH,
      JSON.stringify({ note: old.note, txid: b.txid, vsize: b.vsize, fee: b.fee, change: b.change, hex: b.hex }, null, 2) + '\n'
    );
  }
  const golden = JSON.parse(require('fs').readFileSync(GOLDEN_PATH, 'utf8'));
  assert.equal(b.hex, golden.hex);
  assert.equal(b.txid, golden.txid);
  assert.equal(b.vsize, golden.vsize);
  assert.equal(b.fee, golden.fee);
  assert.equal(b.change, golden.change);
});

test('funding tx: the golden fixture pays the design section 3.1 script, not the old layout', () => {
  const golden = JSON.parse(require('fs').readFileSync(GOLDEN_PATH, 'utf8'));
  const tx = bitcoin.Transaction.fromHex(golden.hex);
  const program = Buffer.concat([Buffer.from('0020', 'hex'), H.sha(Buffer.from(DESIGN_WITNESS_SCRIPT_HEX, 'hex'))]);
  assert.equal(hex(tx.outs[0].script), hex(program), 'output 0 = OP_0 <sha256(design witnessScript)>');
  assert.equal(DESIGN_WITNESS_SCRIPT_HEX, hex(H.redeemScript()));
  // the old (pre-OP_SIZE) script hashes to a different program: 12c640a5...d221 in the previous fixture
  const OPS = bitcoin.opcodes;
  const legacy = Buffer.from(bitcoin.script.compile([
    OPS.OP_IF, OPS.OP_SHA256, Buffer.from(H.HASHLOCK_HEX, 'hex'), OPS.OP_EQUALVERIFY, Buffer.from(H.ALICE_PUB_HEX, 'hex'),
    OPS.OP_ELSE, Buffer.from(bitcoin.script.number.encode(H.LOCKTIME)), OPS.OP_CHECKLOCKTIMEVERIFY, OPS.OP_DROP, Buffer.from(H.BOB_PUB_HEX, 'hex'),
    OPS.OP_ENDIF, OPS.OP_CHECKSIG,
  ]));
  assert.equal(hex(H.sha(legacy)), '12c640a58795dfbd9d91a4b4f975b5276d3feb4d976faab7567843bf9ab0d221');
  assert.notEqual(hex(tx.outs[0].script), '0020' + hex(H.sha(legacy)));
  assert.match(golden.note, /OP_SIZE/);
});

test('funding tx: multiple inputs are all signed; dust change is folded into the fee', () => {
  // amount 169,000 needs 120,000 + 50,000 (two inputs); change would be ~1,000 - fee
  const b = build({ amount: 169000, feeRate: 1 });
  assert.equal(b.inputs.length, 2);
  const tx = bitcoin.Transaction.fromHex(b.hex);
  assert.equal(tx.ins.length, 2);
  assert.deepEqual(fund.checkFundingTx(tx, { pubkey: H.bob.publicKey, inputValues: b.inputs.map((i) => i.value) }), { ok: true, errors: [] });
  if (b.change === 0) {
    assert.equal(tx.outs.length, 1);
    assert.equal(b.changeAddress, null);
    assert.equal(b.fee, 170000 - 169000);
  } else {
    assert.ok(b.change >= fund.DUST_P2WPKH);
  }
  // force the dust case explicitly: total 170,000, amount 169,800 -> change < 294 even at 1 sat/vB
  const d = build({ amount: 169800, feeRate: 1 });
  const dtx = bitcoin.Transaction.fromHex(d.hex);
  assert.equal(dtx.outs.length, 1, 'no dust change output');
  assert.equal(d.change, 0);
  assert.equal(d.fee, 170000 - 169800);
  assert.ok(d.fee >= d.vsize * 1);
});

test('funding tx: refuses insufficient funds, dust amounts, bad fee rates, foreign scripts', () => {
  assert.throws(() => build({ amount: 171000 }), /insufficient funds/);
  assert.throws(() => build({ amount: 170600 }), /insufficient funds/); // 400 sats left: not enough for the 3-input fee
  const tight = build({ amount: 170000 }); // 1,000 sats left: covers the 3-input fee, change 422 >= dust
  assert.equal(tight.inputs.length, 3);
  assert.equal(170000 + tight.fee + tight.change, 171000);
  assert.throws(() => build({ amount: 329 }), /dust/);
  assert.throws(() => build({ feeRate: 0 }), /feeRate/);
  assert.throws(() => build({ feeRate: 1.5 }), /feeRate/);
  assert.throws(() => build({ utxos: [] }), /no spendable utxos/);
  assert.throws(() => build({ witnessScript: Buffer.from('51', 'hex') }), /not an HTLC/);
  // the three small utxos together cannot pay for 169,000 at a high fee rate without pulling the third one in
  const b = build({ amount: 169000, feeRate: 3 });
  assert.ok(b.inputs.length >= 2);
});

test('selectUtxos is largest-first', () => {
  const { chosen, total } = fund.selectUtxos(UTXOS, 130000n);
  assert.deepEqual(chosen.map((u) => u.value), [120000, 50000]);
  assert.equal(total, 170000n);
  assert.throws(() => fund.selectUtxos(UTXOS, 200000n), /insufficient/);
});
