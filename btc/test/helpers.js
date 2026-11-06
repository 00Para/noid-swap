'use strict';
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const htlc = require('../src/htlc');

const dsha = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();
const sha = (b) => crypto.createHash('sha256').update(b).digest();

// Fixed, recognisable keys: private key 1 and 2 (public keys = G and 2G).
const ALICE_PRIV = Buffer.alloc(32); ALICE_PRIV[31] = 1;
const BOB_PRIV = Buffer.alloc(32); BOB_PRIV[31] = 2;
const ALICE_PUB_HEX = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const BOB_PUB_HEX = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';

const PREIMAGE = Buffer.alloc(32, 0); // eth/README test vector
const HASHLOCK_HEX = '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925';
const LOCKTIME = 2500000;

const alice = htlc.keyPairFromPrivateKey(ALICE_PRIV, 'testnet');
const bob = htlc.keyPairFromPrivateKey(BOB_PRIV, 'testnet');

const FUNDING = { txid: 'ab'.repeat(32), vout: 1, value: 100000 };

function redeemScript(over = {}) {
  return htlc.buildRedeemScript({
    hashlock: HASHLOCK_HEX,
    alicePubkey: ALICE_PUB_HEX,
    bobPubkey: BOB_PUB_HEX,
    locktime: LOCKTIME,
    ...over,
  });
}

const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'; // BIP173 testnet P2WPKH example

/** Independent BIP143 sighash for a 1-input tx, SIGHASH_ALL (no lib code). */
function manualBip143(tx, scriptCode, value) {
  const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const varint = (n) => { if (n >= 0xfd) throw new Error('test helper: small only'); return Buffer.from([n]); };
  const inp = tx.ins[0];
  const outpoint = Buffer.concat([Buffer.from(inp.hash), le32(inp.index)]);
  const outputs = Buffer.concat(tx.outs.map((o) => Buffer.concat([le64(o.value), varint(o.script.length), Buffer.from(o.script)])));
  const scriptLen = scriptCode.length < 0xfd ? varint(scriptCode.length) : Buffer.concat([Buffer.from([0xfd]), Buffer.from([scriptCode.length & 0xff, scriptCode.length >> 8])]);
  const pre = Buffer.concat([
    le32(tx.version),
    dsha(outpoint),
    dsha(le32(inp.sequence)),
    outpoint,
    scriptLen,
    scriptCode,
    le64(value),
    le32(inp.sequence),
    dsha(outputs),
    le32(tx.locktime),
    le32(1),
  ]);
  return dsha(pre);
}

/** Hand-rolled tx with caller-chosen locktime/sequence/signer/witness, for negative tests. */
function rawSpend({ rs, locktime = 0, sequence = 0xfffffffd, outValue = 99000, signer, branch, preimage, amount = FUNDING.value, sigOverride }) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = locktime;
  tx.addInput(Buffer.from(FUNDING.txid, 'hex').reverse(), FUNDING.vout, sequence);
  tx.addOutput(bitcoin.address.toOutputScript(DEST, bitcoin.networks.testnet), BigInt(outValue));
  const sig = sigOverride || htlc.signHtlcInput(tx, 0, rs, amount, signer);
  tx.setWitness(0, branch === 'claim' ? htlc.claimWitness(sig, preimage, rs) : htlc.refundWitness(sig, rs));
  return tx;
}

module.exports = {
  dsha, sha, alice, bob, ALICE_PUB_HEX, BOB_PUB_HEX, PREIMAGE, HASHLOCK_HEX, LOCKTIME,
  FUNDING, redeemScript, DEST, manualBip143, rawSpend,
};
