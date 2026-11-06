'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bitcoin = require('bitcoinjs-lib');
const htlc = require('../src/htlc');
const { checkHtlcSpend, extractPreimage } = require('../src/verify');
const H = require('./helpers');

const hex = (b) => Buffer.from(b).toString('hex');

// Witness script for the fixture keys (G, 2G), the all-zero preimage's hashlock and locktime 2,500,000.
const EXPECTED_WITNESS_SCRIPT_HEX =
  '63820120' + '88a820' + '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925' + '88' +
  '21' + '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
  '67' + '03a02526' + 'b175' +
  '21' + '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5' + '68ac';

// The script this library produced before the design's OP_SIZE check was added (12 elements). It must
// never be accepted: an address built from it is not the design's HTLC.
function legacyRedeemScript(over = {}) {
  const o = { hashlock: H.HASHLOCK_HEX, alicePubkey: H.ALICE_PUB_HEX, bobPubkey: H.BOB_PUB_HEX, locktime: H.LOCKTIME, ...over };
  const OPS = bitcoin.opcodes;
  return Buffer.from(bitcoin.script.compile([
    OPS.OP_IF, OPS.OP_SHA256, Buffer.from(o.hashlock, 'hex'), OPS.OP_EQUALVERIFY, Buffer.from(o.alicePubkey, 'hex'),
    OPS.OP_ELSE, Buffer.from(bitcoin.script.number.encode(o.locktime)), OPS.OP_CHECKLOCKTIMEVERIFY, OPS.OP_DROP, Buffer.from(o.bobPubkey, 'hex'),
    OPS.OP_ENDIF, OPS.OP_CHECKSIG,
  ]));
}

// ------------------------------------------------------------------ script

test('redeem script bytes match a hand-assembled expected hex', () => {
  // 63 OP_IF | 82 OP_SIZE | 01 20 (push 32) | 88 OP_EQUALVERIFY
  // a8 OP_SHA256 | 20 <H> | 88 OP_EQUALVERIFY | 21 <alice>
  // 67 OP_ELSE | 03 a02526 (2,500,000 LE) | b1 OP_CLTV | 75 OP_DROP | 21 <bob>
  // 68 OP_ENDIF | ac OP_CHECKSIG
  const expected =
    '63' + '82' + '0120' + '88' + 'a8' + '20' + H.HASHLOCK_HEX + '88' + '21' + H.ALICE_PUB_HEX +
    '67' + '03a02526' + 'b1' + '75' + '21' + H.BOB_PUB_HEX + '68' + 'ac';
  assert.equal(hex(H.redeemScript()), expected);
  assert.equal(expected.length / 2, 117, '113 bytes of the old template + OP_SIZE 01 20 OP_EQUALVERIFY');
  // Pinned literal (also the README test vector): catches any accidental change to the template.
  assert.equal(hex(H.redeemScript()), EXPECTED_WITNESS_SCRIPT_HEX);
});

test('redeem script follows the serialized form in docs/protocol-design.md section 3.1', () => {
  // Design: 63 82 01 20 88 a8 20 <H:32> 88 21 <alice_pub:33> 67 03 <T_b:3 LE> b1 75 21 <bob_pub:33> 68 ac
  // Design example: T_b = 975,024 = 0x0EE0B0 is pushed as 03 b0 e0 0e.
  const designForm = (H_, alice, bob, tbPush) =>
    ['63', '82', '0120', '88', 'a8', '20', H_, '88', '21', alice, '67', tbPush, 'b1', '75', '21', bob, '68', 'ac'].join('');
  assert.equal(
    hex(H.redeemScript({ locktime: 975024 })),
    designForm(H.HASHLOCK_HEX, H.ALICE_PUB_HEX, H.BOB_PUB_HEX, '03b0e00e')
  );
  const rs = H.redeemScript({ locktime: 975024 });
  assert.deepEqual([...rs.subarray(0, 7)], [0x63, 0x82, 0x01, 0x20, 0x88, 0xa8, 0x20], 'prefix 63 82 01 20 88 a8 20');
  assert.equal(hex(rs.subarray(7, 39)), H.HASHLOCK_HEX, '<H:32> right after the prefix');
  assert.equal(rs[rs.length - 1], 0xac);
  assert.equal(rs[rs.length - 2], 0x68);
});

test('claim branch size check: OP_SIZE 32 OP_EQUALVERIFY is present and only the preimage length is consumed', () => {
  const rs = H.redeemScript();
  const asm = bitcoin.script.toASM(rs).split(' ');
  assert.deepEqual(asm.slice(0, 7), ['OP_IF', 'OP_SIZE', '20', 'OP_EQUALVERIFY', 'OP_SHA256', H.HASHLOCK_HEX, 'OP_EQUALVERIFY']);
  // the number 32 is the data push 01 20, not an OP_N (OP_1..OP_16 stop at 16)
  assert.equal(hex(rs.subarray(2, 4)), '0120');
  assert.equal(htlc.PREIMAGE_LENGTH, 32);
});

test('fixture keys are the well-known G and 2G', () => {
  assert.equal(hex(H.alice.publicKey), H.ALICE_PUB_HEX);
  assert.equal(hex(H.bob.publicKey), H.BOB_PUB_HEX);
});

test('locktime encoding edge cases (minimal script numbers)', () => {
  // 0x800000 needs a 0x00 sign-padding byte -> 4-byte push
  assert.ok(hex(H.redeemScript({ locktime: 8388608 })).includes('0400008000b175'));
  // small values use OP_N
  assert.ok(hex(H.redeemScript({ locktime: 16 })).includes('60b175'));
  assert.ok(hex(H.redeemScript({ locktime: 1 })).includes('51b175'));
  // max uint32 needs 5 bytes (sign padding)
  assert.ok(hex(H.redeemScript({ locktime: 4294967295 })).includes('05ffffffff00b175'));
  // time lock 1,800,000,000 = 0x6B49D200 -> LE 00 d2 49 6b
  assert.ok(hex(H.redeemScript({ locktime: 1800000000 })).includes('0400d2496bb175'));
  for (const lt of [1, 16, 17, 127, 128, 255, 256, 32767, 32768, 8388607, 8388608, 499999999, 500000000, 1800000000, 2147483648, 4294967295]) {
    assert.equal(htlc.decodeRedeemScript(H.redeemScript({ locktime: lt })).locktime, lt, `locktime ${lt}`);
  }
});

test('buildRedeemScript rejects bad inputs', () => {
  assert.throws(() => H.redeemScript({ locktime: 0 }), /locktime/);
  assert.throws(() => H.redeemScript({ locktime: 4294967296 }), /locktime/);
  assert.throws(() => H.redeemScript({ locktime: 1.5 }), /locktime/);
  assert.throws(() => H.redeemScript({ locktime: -1 }), /locktime/);
  assert.throws(() => H.redeemScript({ hashlock: '00'.repeat(31) }), /hashlock/);
  assert.throws(() => H.redeemScript({ alicePubkey: '04' + '11'.repeat(64) }), /alicePubkey/); // uncompressed
  assert.throws(() => H.redeemScript({ bobPubkey: '02' + '00'.repeat(32) }), /bobPubkey/); // not on curve
  assert.throws(() => H.redeemScript({ bobPubkey: H.ALICE_PUB_HEX }), /differ/);
});

test('locktime kind and maturity helpers', () => {
  assert.equal(htlc.locktimeKind(499999999), 'height');
  assert.equal(htlc.locktimeKind(500000000), 'time');
  assert.equal(htlc.isLocktimeReached(100, { tipHeight: 99 }), false);
  assert.equal(htlc.isLocktimeReached(100, { tipHeight: 100 }), true); // mineable in block 101
  assert.equal(htlc.isLocktimeReached(1800000000, { tipMedianTimePast: 1800000000 }), false); // needs strictly <
  assert.equal(htlc.isLocktimeReached(1800000000, { tipMedianTimePast: 1800000001 }), true);
});

// ------------------------------------------------------------------ address

test('P2WSH address derivation is deterministic and matches bitcoinjs payments', () => {
  const rs = H.redeemScript();
  const a1 = htlc.p2wshAddress(rs, 'testnet');
  const a2 = htlc.p2wshAddress(Buffer.from(rs), 'testnet');
  assert.equal(a1, a2);
  assert.match(a1, /^tb1q[0-9a-z]{58}$/);
  const viaLib = bitcoin.payments.p2wsh({ redeem: { output: rs, network: bitcoin.networks.testnet }, network: bitcoin.networks.testnet }).address;
  assert.equal(a1, viaLib);
  // witness program is sha256(script)
  const spk = htlc.p2wshScriptPubKey(rs);
  assert.equal(hex(spk), '0020' + hex(H.sha(rs)));
  assert.equal(hex(bitcoin.address.toOutputScript(a1, bitcoin.networks.testnet)), hex(spk));
});

test('network switch: signet aliases testnet, regtest and mainnet differ; default is testnet', () => {
  const rs = H.redeemScript();
  assert.equal(htlc.p2wshAddress(rs), htlc.p2wshAddress(rs, 'testnet'));
  assert.equal(htlc.p2wshAddress(rs, 'signet'), htlc.p2wshAddress(rs, 'testnet'));
  assert.match(htlc.p2wshAddress(rs, 'regtest'), /^bcrt1q/);
  assert.match(htlc.p2wshAddress(rs, 'mainnet'), /^bc1q/);
  assert.match(htlc.p2wshAddress(rs, bitcoin.networks.bitcoin), /^bc1q/);
  assert.throws(() => htlc.p2wshAddress(rs, 'litecoin'), /unknown network/);
});

// ------------------------------------------------------------------ decode

test('decodeRedeemScript round-trips', () => {
  const rs = H.redeemScript();
  const f = htlc.decodeRedeemScript(rs);
  assert.equal(hex(f.hashlock), H.HASHLOCK_HEX);
  assert.equal(hex(f.alicePubkey), H.ALICE_PUB_HEX);
  assert.equal(hex(f.bobPubkey), H.BOB_PUB_HEX);
  assert.equal(f.locktime, H.LOCKTIME);
  assert.equal(f.locktimeKind, 'height');
  assert.equal(hex(htlc.buildRedeemScript(f)), hex(rs));
  assert.equal(htlc.decodeRedeemScript(hex(rs)).locktime, H.LOCKTIME); // hex input
  assert.equal(htlc.decodeRedeemScript(H.redeemScript({ locktime: 1800000000 })).locktimeKind, 'time');
});

test('decodeRedeemScript rejects anything that is not exactly our template', () => {
  const rs = H.redeemScript();
  const mutate = (fn) => { const b = Buffer.from(rs); fn(b); return b; };
  assert.throws(() => htlc.decodeRedeemScript(Buffer.concat([rs, Buffer.from([0x61])])), /not an HTLC/); // trailing OP_NOP
  assert.throws(() => htlc.decodeRedeemScript(mutate((b) => { b[0] = 0x64; })), /not an HTLC/); // IF -> NOTIF
  assert.throws(() => htlc.decodeRedeemScript(mutate((b) => { b[1] = 0xa9; })), /not an HTLC/); // SIZE -> HASH160
  assert.throws(() => htlc.decodeRedeemScript(mutate((b) => { b[1] = 0x76; })), /not an HTLC/); // SIZE -> DUP
  assert.throws(() => htlc.decodeRedeemScript(mutate((b) => { b[3] = 0x21; })), /not an HTLC/); // size 32 -> 33
  assert.throws(() => htlc.decodeRedeemScript(mutate((b) => { b[3] = 0x1f; })), /not an HTLC/); // size 32 -> 31
  assert.throws(() => htlc.decodeRedeemScript(mutate((b) => { b[4] = 0x87; })), /not an HTLC/); // size EQUALVERIFY -> EQUAL
  assert.throws(() => htlc.decodeRedeemScript(mutate((b) => { b[5] = 0xa9; })), /not an HTLC/); // SHA256 -> HASH160
  assert.throws(() => htlc.decodeRedeemScript(mutate((b) => { b[b.length - 1] = 0xad; })), /not an HTLC/); // CHECKSIGVERIFY
  assert.throws(() => htlc.decodeRedeemScript(Buffer.from('51')), /not an HTLC/);
  assert.throws(() => htlc.decodeRedeemScript(Buffer.alloc(0)), /not an HTLC/);
  // non-minimal locktime push (extra zero byte) must not be accepted
  const nonMinimal = Buffer.from(hex(rs).replace('03a02526', '04a0252600'), 'hex');
  assert.throws(() => htlc.decodeRedeemScript(nonMinimal));
  // PUSHDATA1 for the hash instead of a direct push
  const pd1 = Buffer.from(hex(rs).replace('20' + H.HASHLOCK_HEX, '4c20' + H.HASHLOCK_HEX), 'hex');
  assert.throws(() => htlc.decodeRedeemScript(pd1), /not an HTLC/);
});

test('the old script layout (no OP_SIZE) is rejected everywhere, never mistaken for the design HTLC', () => {
  const old = legacyRedeemScript();
  assert.equal(old.length, 113);
  assert.throws(() => htlc.decodeRedeemScript(old), /legacy layout without OP_SIZE/);
  assert.throws(() => htlc.decodeRedeemScript(old), /not an HTLC/);
  // an address that old code derived: verifyLock refuses the (address, script) pair even though they match
  const oldAddr = htlc.p2wshAddress(old, 'testnet');
  assert.throws(() => htlc.verifyLock({ redeemScript: old, address: oldAddr, network: 'testnet' }), /not an HTLC/);
  assert.notEqual(oldAddr, htlc.p2wshAddress(H.redeemScript(), 'testnet'));
  // spend builders refuse it
  assert.throws(() => htlc.buildClaimTx({
    redeemScript: old, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', preimage: H.PREIMAGE, keyPair: H.alice, feeRate: 5,
  }), /not an HTLC/);
  assert.throws(() => htlc.buildRefundTx({
    redeemScript: old, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', keyPair: H.bob, feeRate: 5,
  }), /not an HTLC/);
  // a correctly signed claim of the old script: checker rejects, watcher yields no preimage
  const tx = H.rawSpend({ rs: old, branch: 'claim', preimage: H.PREIMAGE, signer: H.alice });
  const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not a valid HTLC script/.test(e)), r.errors.join('; '));
  assert.equal(extractPreimage(tx, { hashlock: H.HASHLOCK_HEX }), null);
  assert.equal(extractPreimage(tx), null);
  assert.equal(extractPreimage(tx, { redeemScript: old }), null);
});

test('verifyLock: counterparty checks a shown (address, script) pair', () => {
  const rs = H.redeemScript();
  const addr = htlc.p2wshAddress(rs, 'testnet');
  const ok = htlc.verifyLock({
    redeemScript: rs, address: addr, network: 'testnet',
    expected: { hashlock: H.HASHLOCK_HEX, alicePubkey: H.ALICE_PUB_HEX, bobPubkey: H.BOB_PUB_HEX, minLocktime: 2000000, maxLocktime: 3000000 },
  });
  assert.equal(ok.locktime, H.LOCKTIME);
  const other = htlc.p2wshAddress(H.redeemScript({ locktime: H.LOCKTIME + 1 }), 'testnet');
  assert.throws(() => htlc.verifyLock({ redeemScript: rs, address: other, network: 'testnet' }), /address mismatch/);
  assert.throws(() => htlc.verifyLock({ redeemScript: rs, expected: { hashlock: '11'.repeat(32) } }), /hashlock mismatch/);
  assert.throws(() => htlc.verifyLock({ redeemScript: rs, expected: { alicePubkey: H.BOB_PUB_HEX } }), /alicePubkey mismatch/);
  assert.throws(() => htlc.verifyLock({ redeemScript: rs, expected: { maxLocktime: H.LOCKTIME - 1 } }), /too late/);
  assert.throws(() => htlc.verifyLock({ redeemScript: rs, expected: { minLocktime: H.LOCKTIME + 1 } }), /too early/);
  assert.throws(() => htlc.verifyLock({ redeemScript: rs, expected: { minLocktime: 1800000000 } }), /too early|kind/);
});

// ------------------------------------------------------------------ sighash

test('BIP143 sighash from bitcoinjs equals an independent hand-rolled implementation', () => {
  const rs = H.redeemScript();
  const tx = H.rawSpend({ rs, branch: 'refund', locktime: H.LOCKTIME, signer: H.bob });
  const ours = htlc.htlcSighash(tx, 0, rs, H.FUNDING.value);
  assert.equal(hex(ours), hex(H.manualBip143(tx, rs, H.FUNDING.value)));
  // sanity: digest commits to the amount
  assert.notEqual(hex(htlc.htlcSighash(tx, 0, rs, H.FUNDING.value + 1)), hex(ours));
});

test('BIP143 official native P2WPKH vector (guards the installed hashForWitnessV0)', () => {
  // https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki, "Native P2WPKH"
  const unsigned =
    '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000';
  const tx = bitcoin.Transaction.fromHex(unsigned);
  const scriptCode = Buffer.from('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac', 'hex');
  const h = tx.hashForWitnessV0(1, scriptCode, 600000000n, bitcoin.Transaction.SIGHASH_ALL);
  assert.equal(hex(h), 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670');
});

// ------------------------------------------------------------------ claim

function claim(over = {}) {
  const rs = H.redeemScript();
  return {
    rs,
    ...htlc.buildClaimTx({
      redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet',
      preimage: H.PREIMAGE, keyPair: H.alice, feeRate: 5, ...over,
    }),
  };
}

test('claim tx: structure, witness layout, and script-logic verification', () => {
  const c = claim();
  const tx = bitcoin.Transaction.fromHex(c.hex); // survives serialisation
  assert.equal(tx.getId(), c.txid);
  assert.equal(tx.version, 2);
  assert.equal(tx.locktime, 0);
  assert.equal(tx.ins.length, 1);
  assert.equal(tx.outs.length, 1);
  assert.equal(hex(Buffer.from(tx.ins[0].hash).reverse()), H.FUNDING.txid);
  assert.equal(tx.ins[0].index, H.FUNDING.vout);
  assert.equal(tx.ins[0].sequence, htlc.SEQUENCE_CLAIM);
  assert.equal(tx.ins[0].script.length, 0, 'native segwit: empty scriptSig');
  assert.equal(c.fee + c.outputValue, H.FUNDING.value);
  assert.equal(Number(tx.outs[0].value), c.outputValue);

  const w = tx.ins[0].witness.map((x) => Buffer.from(x));
  assert.equal(w.length, 4);
  assert.ok(w[0].length >= 70 && w[0].length <= 73 && w[0][w[0].length - 1] === 0x01, 'DER sig + SIGHASH_ALL');
  assert.equal(hex(w[1]), hex(H.PREIMAGE));
  assert.equal(hex(w[2]), '01', 'OP_TRUE selects the IF branch');
  assert.equal(hex(w[3]), hex(c.rs));

  const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value, scriptPubKey: htlc.p2wshScriptPubKey(c.rs), redeemScript: c.rs });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.branch, 'claim');
  assert.equal(hex(r.preimage), hex(H.PREIMAGE));
  // also accepted straight from hex
  assert.equal(checkHtlcSpend(c.hex, 0, { amount: H.FUNDING.value }).ok, true);
});

test('claim tx: signature verifies against alicePubkey over the BIP143 digest (checked by hand)', () => {
  const c = claim();
  const tx = bitcoin.Transaction.fromHex(c.hex);
  const sigWithType = Buffer.from(tx.ins[0].witness[0]);
  const { signature, hashType } = bitcoin.script.signature.decode(sigWithType);
  assert.equal(hashType, 1);
  const digest = H.manualBip143(tx, c.rs, H.FUNDING.value);
  assert.ok(H.alice.verify(digest, signature));
  assert.ok(!H.bob.verify(digest, signature));
});

test('claim tx: fee accounting and vsize', () => {
  const c = claim({ feeRate: 5 });
  assert.ok(c.fee >= Math.ceil(5 * c.vsize), 'effective rate >= requested (estimate used a 73-byte sig)');
  assert.ok(c.fee <= Math.ceil(5 * (c.vsize + 3)), 'and not wildly over');
  // 1-in-1-out P2WPKH-paying claim of this 117-byte script is ~ 139 vB
  assert.ok(c.vsize > 125 && c.vsize < 150, `vsize ${c.vsize}`);
  assert.equal(c.vsize, 139, 'a 117-byte script: 1 vB more than the 138 vB of the old 113-byte one');
  const fixed = claim({ feeRate: undefined, fee: 1234 });
  assert.equal(fixed.fee, 1234);
  assert.equal(fixed.outputValue, H.FUNDING.value - 1234);
  assert.throws(() => claim({ fee: 100 }), /exactly one of/); // both feeRate and fee
  assert.throws(() => claim({ feeRate: undefined }), /exactly one of/); // neither
});

test('claim tx: dust output is refused', () => {
  assert.throws(() => claim({ feeRate: undefined, fee: H.FUNDING.value - 293 }), /dust/); // P2WPKH dust is 294
  assert.doesNotThrow(() => claim({ feeRate: undefined, fee: H.FUNDING.value - 294 }));
  const p2wpkh = bitcoin.address.toOutputScript(H.DEST, bitcoin.networks.testnet);
  assert.equal(htlc.dustThreshold(p2wpkh), 294);
  assert.equal(htlc.dustThreshold(htlc.p2wshScriptPubKey(H.redeemScript())), 330);
  assert.equal(htlc.dustThreshold(Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex')), 546);
});

test('claim negative: wrong preimage fails the sha256 check', () => {
  const rs = H.redeemScript();
  const wrong = Buffer.alloc(32, 1);
  // the builder refuses outright
  assert.throws(() => htlc.buildClaimTx({
    redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', preimage: wrong, keyPair: H.alice, feeRate: 5,
  }), /sha256\(preimage\)/);
  // a hand-forced tx with a validly signed but wrong preimage is flagged by the checker
  const tx = H.rawSpend({ rs, branch: 'claim', preimage: wrong, signer: H.alice, sequence: 0xfffffffd });
  const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /sha256\(preimage\) != hashlock/.test(e)), r.errors.join('; '));
  assert.equal(r.preimage, undefined);
  // wrong-length preimage too
  assert.throws(() => htlc.buildClaimTx({
    redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', preimage: Buffer.alloc(31), keyPair: H.alice, feeRate: 5,
  }), /32 bytes/);
});

test('claim negative: a preimage that is not exactly 32 bytes fails OP_SIZE 32 even if its hash matches', () => {
  for (const len of [0, 1, 31, 33, 64]) {
    const x = Buffer.alloc(len, 7);
    const rs = H.redeemScript({ hashlock: hex(H.sha(x)) }); // a lock whose H really is sha256(x)
    // builder refuses
    assert.throws(() => htlc.buildClaimTx({
      redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', preimage: x, keyPair: H.alice, feeRate: 5,
    }), /32 bytes/);
    // hand-forced, validly signed claim: the checker flags the size, no preimage is reported
    const tx = H.rawSpend({ rs, branch: 'claim', preimage: x, signer: H.alice });
    const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value });
    assert.equal(r.ok, false, `len ${len}`);
    assert.ok(r.errors.some((e) => /exactly 32/.test(e)), r.errors.join('; '));
    assert.equal(r.preimage, undefined);
    // and the watcher never turns it into a "preimage"
    assert.equal(extractPreimage(tx, { hashlock: hex(H.sha(x)) }), null, `len ${len}`);
  }
});

test('claim negative: claiming with Bob\'s key fails', () => {
  const rs = H.redeemScript();
  assert.throws(() => htlc.buildClaimTx({
    redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', preimage: H.PREIMAGE, keyPair: H.bob, feeRate: 5,
  }), /does not match the alice pubkey/);
  const tx = H.rawSpend({ rs, branch: 'claim', preimage: H.PREIMAGE, signer: H.bob, sequence: 0xfffffffd });
  const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /claim: signature does not verify/.test(e)), r.errors.join('; '));
});

test('claim negative: signature is bound to amount, outputs, and script', () => {
  const c = claim();
  assert.equal(checkHtlcSpend(c.hex, 0, { amount: H.FUNDING.value + 1 }).ok, false, 'wrong committed amount');
  const tampered = bitcoin.Transaction.fromHex(c.hex);
  tampered.outs[0].value -= 1n; // someone redirects a satoshi to fees
  assert.equal(checkHtlcSpend(tampered, 0, { amount: H.FUNDING.value }).ok, false, 'tampered output');
  const other = htlc.p2wshScriptPubKey(H.redeemScript({ locktime: H.LOCKTIME + 1 }));
  const r = checkHtlcSpend(c.hex, 0, { amount: H.FUNDING.value, scriptPubKey: other });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /does not hash to the prevout/.test(e)));
});

test('claim negative: malformed witnesses', () => {
  const c = claim();
  const mk = (fn) => { const t = bitcoin.Transaction.fromHex(c.hex); const w = t.ins[0].witness.map((x) => Buffer.from(x)); fn(w); t.setWitness(0, w); return t; };
  // selector other than 0x01 / empty (MINIMALIF)
  assert.equal(checkHtlcSpend(mk((w) => { w[2] = Buffer.from([0x02]); }), 0, { amount: H.FUNDING.value }).ok, false);
  assert.equal(checkHtlcSpend(mk((w) => { w[2] = Buffer.from([0x01, 0x00]); }), 0, { amount: H.FUNDING.value }).ok, false);
  // extra item
  assert.equal(checkHtlcSpend(mk((w) => { w.unshift(Buffer.alloc(0)); }), 0, { amount: H.FUNDING.value }).ok, false);
  // flipped sighash type
  const r = checkHtlcSpend(mk((w) => { w[0][w[0].length - 1] = 0x02; }), 0, { amount: H.FUNDING.value });
  assert.equal(r.ok, false);
  // non-DER signature
  assert.equal(checkHtlcSpend(mk((w) => { w[0] = Buffer.alloc(65, 1); }), 0, { amount: H.FUNDING.value }).ok, false);
  // witness script isn't an HTLC
  assert.equal(checkHtlcSpend(mk((w) => { w[3] = Buffer.from('51', 'hex'); }), 0, { amount: H.FUNDING.value }).ok, false);
  // high-S signature (malleated) is rejected by the low-S rule
  const tx = bitcoin.Transaction.fromHex(c.hex);
  const { signature, hashType } = bitcoin.script.signature.decode(Buffer.from(tx.ins[0].witness[0]));
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt('0x' + hex(signature.subarray(32)));
  const hi = Buffer.concat([signature.subarray(0, 32), Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex')]);
  const highS = bitcoin.Transaction.fromHex(c.hex);
  const ww = highS.ins[0].witness.map((x) => Buffer.from(x));
  ww[0] = Buffer.from(bitcoin.script.signature.encode(hi, hashType));
  highS.setWitness(0, ww);
  const rh = checkHtlcSpend(highS, 0, { amount: H.FUNDING.value });
  assert.equal(rh.ok, false);
});

// ------------------------------------------------------------------ refund

function refund(over = {}) {
  const rs = H.redeemScript();
  return {
    rs,
    ...htlc.buildRefundTx({
      redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', keyPair: H.bob, feeRate: 5, ...over,
    }),
  };
}

test('refund tx: nLockTime, nSequence, witness layout, signature by Bob', () => {
  const r0 = refund();
  const tx = bitcoin.Transaction.fromHex(r0.hex);
  assert.equal(tx.locktime, H.LOCKTIME);
  assert.equal(tx.ins[0].sequence, 0xfffffffd, 'design section 3.1: refund nSequence = 0xfffffffd (BIP125 opt-in RBF)');
  assert.equal(tx.ins[0].sequence, htlc.SEQUENCE_REFUND);
  assert.ok(tx.ins[0].sequence < 0xffffffff, 'CLTV needs a non-final sequence');
  assert.ok(tx.ins[0].sequence <= 0xfffffffd, 'signals RBF (BIP125: any sequence < 0xfffffffe)');
  // the claim input is also 0xfffffffd, per the same table
  assert.equal(htlc.SEQUENCE_CLAIM, 0xfffffffd);
  // the explicit override still works and is still bounded below 0xffffffff
  assert.equal(bitcoin.Transaction.fromHex(refund({ sequence: 0xfffffffe }).hex).ins[0].sequence, 0xfffffffe);
  const w = tx.ins[0].witness.map((x) => Buffer.from(x));
  assert.equal(w.length, 3);
  assert.equal(w[1].length, 0, 'empty vector = OP_FALSE selects ELSE');
  assert.equal(hex(w[2]), hex(r0.rs));
  const digest = H.manualBip143(tx, r0.rs, H.FUNDING.value);
  const { signature } = bitcoin.script.signature.decode(w[0]);
  assert.ok(H.bob.verify(digest, signature));
  assert.ok(!H.alice.verify(digest, signature));

  const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value, scriptPubKey: htlc.p2wshScriptPubKey(r0.rs) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.branch, 'refund');
  // against a chain tip
  assert.equal(checkHtlcSpend(tx, 0, { amount: H.FUNDING.value, chain: { tipHeight: H.LOCKTIME - 1 } }).ok, false, 'not yet mature');
  assert.equal(checkHtlcSpend(tx, 0, { amount: H.FUNDING.value, chain: { tipHeight: H.LOCKTIME } }).ok, true, 'mature');
});

test('refund negative: nLockTime < locktime is flagged invalid', () => {
  const rs = H.redeemScript();
  const tx = H.rawSpend({ rs, branch: 'refund', locktime: H.LOCKTIME - 1, signer: H.bob });
  const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /nLockTime .* < script locktime/.test(e)), r.errors.join('; '));
  const zero = H.rawSpend({ rs, branch: 'refund', locktime: 0, signer: H.bob });
  assert.equal(checkHtlcSpend(zero, 0, { amount: H.FUNDING.value }).ok, false);
  // larger nLockTime is fine for CLTV
  const later = H.rawSpend({ rs, branch: 'refund', locktime: H.LOCKTIME + 10, signer: H.bob });
  assert.equal(checkHtlcSpend(later, 0, { amount: H.FUNDING.value }).ok, true);
});

test('refund negative: final nSequence disables locktime and is flagged', () => {
  const rs = H.redeemScript();
  const tx = H.rawSpend({ rs, branch: 'refund', locktime: H.LOCKTIME, sequence: 0xffffffff, signer: H.bob });
  const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /0xffffffff/.test(e)));
  assert.throws(() => htlc.buildRefundTx({
    redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', keyPair: H.bob, feeRate: 5, sequence: 0xffffffff,
  }), /nSequence/);
});

test('refund negative: height vs time locktime kind mismatch is flagged', () => {
  const rsTime = H.redeemScript({ locktime: 1800000000 });
  const bad = H.rawSpend({ rs: rsTime, branch: 'refund', locktime: 2600000, signer: H.bob }); // a height vs a time script
  const r = checkHtlcSpend(bad, 0, { amount: H.FUNDING.value });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /height|time/.test(e)));
  const good = refund({ redeemScript: rsTime });
  assert.equal(bitcoin.Transaction.fromHex(good.hex).locktime, 1800000000);
  assert.equal(checkHtlcSpend(good.hex, 0, { amount: H.FUNDING.value, chain: { tipMedianTimePast: 1800000001 } }).ok, true);
  assert.equal(checkHtlcSpend(good.hex, 0, { amount: H.FUNDING.value, chain: { tipMedianTimePast: 1800000000 } }).ok, false);
});

test('refund negative: only Bob can refund', () => {
  const rs = H.redeemScript();
  assert.throws(() => htlc.buildRefundTx({
    redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', keyPair: H.alice, feeRate: 5,
  }), /does not match the bob pubkey/);
  const tx = H.rawSpend({ rs, branch: 'refund', locktime: H.LOCKTIME, signer: H.alice });
  const r = checkHtlcSpend(tx, 0, { amount: H.FUNDING.value });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /refund: signature does not verify/.test(e)));
});

test('cross-branch: a claim witness cannot be replayed as a refund and vice versa', () => {
  const rs = H.redeemScript();
  // Alice's key in the refund branch
  const a = H.rawSpend({ rs, branch: 'refund', locktime: H.LOCKTIME, signer: H.alice });
  assert.equal(checkHtlcSpend(a, 0, { amount: H.FUNDING.value }).ok, false);
  // Bob's key in the claim branch with the correct preimage
  const b = H.rawSpend({ rs, branch: 'claim', preimage: H.PREIMAGE, signer: H.bob });
  assert.equal(checkHtlcSpend(b, 0, { amount: H.FUNDING.value }).ok, false);
});

// ------------------------------------------------------------------ preimage extraction

test('extractPreimage: Bob\'s watcher learns s from a claim witness', () => {
  const c = claim();
  const s = extractPreimage(c.hex, { hashlock: H.HASHLOCK_HEX });
  assert.equal(hex(s), hex(H.PREIMAGE));
  assert.equal(hex(extractPreimage(bitcoin.Transaction.fromHex(c.hex))), hex(H.PREIMAGE)); // hashlock from the script
  assert.equal(hex(extractPreimage(c.hex, { redeemScript: c.rs, hashlock: H.HASHLOCK_HEX })), hex(H.PREIMAGE));
  // and a non-trivial random secret end to end
  const { generate } = require('../src/secret');
  const g = generate();
  const rs = H.redeemScript({ hashlock: g.hashlock });
  const cl = htlc.buildClaimTx({ redeemScript: rs, utxo: H.FUNDING, destination: H.DEST, network: 'testnet', preimage: g.secret, keyPair: H.alice, feeRate: 2 });
  assert.equal('0x' + hex(extractPreimage(cl.hex, { hashlock: g.hashlock })), g.secret);
});

test('extractPreimage returns null when there is nothing trustworthy to extract', () => {
  const rf = refund();
  assert.equal(extractPreimage(rf.hex, { hashlock: H.HASHLOCK_HEX }), null, 'refund reveals nothing');
  const c = claim();
  assert.equal(extractPreimage(c.hex, { hashlock: '11'.repeat(32) }), null, 'different hashlock');
  assert.equal(extractPreimage(c.hex, { redeemScript: H.redeemScript({ locktime: H.LOCKTIME + 1 }) }), null, 'different lock');
  // tampered preimage in the witness no longer hashes to H
  const t = bitcoin.Transaction.fromHex(c.hex);
  const w = t.ins[0].witness.map((x) => Buffer.from(x));
  w[1][0] ^= 0xff;
  t.setWitness(0, w);
  assert.equal(extractPreimage(t, { hashlock: H.HASHLOCK_HEX }), null);
  // an unrelated segwit spend
  const plain = new bitcoin.Transaction();
  plain.addInput(Buffer.alloc(32, 1), 0);
  plain.setWitness(0, [Buffer.alloc(71, 1), Buffer.alloc(33, 2)]);
  assert.equal(extractPreimage(plain), null);
});
