'use strict';
/*
 * Bob's funding transaction: P2WPKH inputs (his signet key) -> the P2WSH HTLC
 * output (+ P2WPKH change back to the same key).
 *
 *   inputs   native P2WPKH, witness [ <sig> <pubkey> ], nSequence 0xfffffffd (RBF)
 *   outputs  [0] = OP_0 <sha256(witnessScript)>  amount
 *            [1] = change to the funding key's P2WPKH address (omitted if < dust)
 *
 * Signing: BIP143, scriptCode = 76a914 <hash160(pubkey)> 88ac, SIGHASH_ALL,
 * DER low-S low-R. Coin selection: largest-first until amount + fee is
 * covered (fee recomputed for the real input count). Nothing is broadcast here.
 */
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const htlc = require('./htlc');
const { resolveNetwork } = require('./network');

const SEQUENCE_RBF = 0xfffffffd;
const SIGHASH_ALL = bitcoin.Transaction.SIGHASH_ALL;
const DUST_P2WPKH = 294;
const DUST_P2WSH = 330;

function hash160(b) {
  return crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(b).digest()).digest();
}

/** P2WPKH address + scriptPubKey for a compressed pubkey. */
function p2wpkh(pubkey, network) {
  const pub = Buffer.from(pubkey);
  if (pub.length !== 33) throw new Error('p2wpkh needs a 33-byte compressed pubkey');
  const net = resolveNetwork(network);
  const spk = Buffer.concat([Buffer.from([0x00, 0x14]), hash160(pub)]);
  return { address: bitcoin.address.fromOutputScript(spk, net), scriptPubKey: spk, scriptCode: Buffer.concat([Buffer.from('76a914', 'hex'), hash160(pub), Buffer.from('88ac', 'hex')]) };
}

function toSatsNumber(x, what) {
  const v = typeof x === 'bigint' ? x : Number.isSafeInteger(x) ? BigInt(x) : null;
  if (v === null || v < 0n || v > 2100000000000000n) throw new Error(`${what}: not a valid satoshi amount`);
  return v;
}

/**
 * Largest-first selection. utxos: [{txid, vout, value}]. Returns the chosen
 * subset plus the running total, or throws if funds are insufficient.
 */
function selectUtxos(utxos, needed) {
  const sorted = utxos.slice().sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const chosen = [];
  let total = 0n;
  for (const u of sorted) {
    chosen.push(u);
    total += BigInt(u.value);
    if (total >= needed) return { chosen, total };
  }
  throw new Error(`insufficient funds: have ${total} sats in ${utxos.length} utxo(s), need ${needed}`);
}

/**
 * Build + sign the funding tx.
 * @param {object} p
 *   keyPair      ECPair of the funding key (all utxos must be its P2WPKH outputs)
 *   utxos        [{txid, vout, value}] spendable by keyPair (confirmed ones, ideally)
 *   witnessScript HTLC redeem script (bytes/hex); the output pays OP_0 <sha256(script)>
 *   amount       sats to lock
 *   feeRate      sat/vB (integer >= 1)
 *   network      'signet' (default via resolveNetwork)
 *   changeAddress optional; default = the funding key's own P2WPKH address
 * @returns {{tx, hex, txid, vout: 0, vsize, fee, feeRate, inputs, change, changeAddress, address}}
 */
function buildFundingTx({ keyPair, utxos, witnessScript, amount, feeRate, network, changeAddress }) {
  if (!keyPair || !keyPair.publicKey) throw new Error('keyPair required');
  const net = resolveNetwork(network);
  const rs = htlc._toBuf(witnessScript, 'witnessScript');
  htlc.decodeRedeemScript(rs); // must be our HTLC template
  const amt = toSatsNumber(amount, 'amount');
  if (amt < BigInt(DUST_P2WSH)) throw new Error(`amount ${amt} sats is below the P2WSH dust threshold ${DUST_P2WSH}`);
  if (!Number.isInteger(feeRate) || feeRate < 1) throw new Error('feeRate must be an integer >= 1 sat/vB');
  if (!Array.isArray(utxos) || !utxos.length) throw new Error('no spendable utxos');
  for (const u of utxos) {
    if (!/^[0-9a-f]{64}$/i.test(u.txid) || !Number.isInteger(u.vout) || u.vout < 0) throw new Error('bad utxo');
    toSatsNumber(u.value, 'utxo.value');
  }

  const me = p2wpkh(keyPair.publicKey, net);
  const htlcSpk = htlc.p2wshScriptPubKey(rs);
  const address = bitcoin.address.fromOutputScript(htlcSpk, net);
  const changeSpk = changeAddress ? Buffer.from(bitcoin.address.toOutputScript(changeAddress, net)) : me.scriptPubKey;
  const changeAddr = changeAddress || me.address;
  const dummySig = Buffer.alloc(72, 0x30);
  const pub = Buffer.from(keyPair.publicKey);

  // Iterate: the fee depends on the input count, which depends on the fee.
  let needed = amt;
  let chosen, total, fee, change, tx;
  for (let round = 0; round < 10; round++) {
    ({ chosen, total } = selectUtxos(utxos, needed));
    const mk = (withChange) => {
      const t = new bitcoin.Transaction();
      t.version = 2;
      t.locktime = 0;
      for (const u of chosen) t.addInput(Buffer.from(u.txid, 'hex').reverse(), u.vout, SEQUENCE_RBF);
      t.addOutput(htlcSpk, amt);
      if (withChange) t.addOutput(changeSpk, 0n);
      for (let i = 0; i < chosen.length; i++) t.setWitness(i, [dummySig, pub]);
      return t;
    };
    const vWith = mk(true).virtualSize();
    const feeWith = BigInt(feeRate * vWith);
    change = total - amt - feeWith;
    if (change >= BigInt(DUST_P2WPKH)) {
      fee = feeWith;
      tx = mk(true);
      tx.outs[1].value = change;
      break;
    }
    // change would be dust: drop it, everything above amount goes to fees
    const vWithout = mk(false).virtualSize();
    const feeWithout = BigInt(feeRate * vWithout);
    if (total >= amt + feeWithout) {
      fee = total - amt;
      change = 0n;
      tx = mk(false);
      break;
    }
    needed = amt + feeWith + BigInt(DUST_P2WPKH); // pull in another input and retry
    if (needed > total && round === 9) throw new Error('insufficient funds after fee');
  }
  if (!tx) throw new Error('insufficient funds: could not cover amount + fee');

  // Sign every input (BIP143, P2WPKH scriptCode).
  for (let i = 0; i < chosen.length; i++) {
    const digest = Buffer.from(tx.hashForWitnessV0(i, me.scriptCode, toSatsNumber(chosen[i].value, 'utxo.value'), SIGHASH_ALL));
    const sig = Buffer.from(bitcoin.script.signature.encode(keyPair.sign(digest, true), SIGHASH_ALL));
    tx.setWitness(i, [sig, pub]);
  }

  return {
    tx,
    hex: tx.toHex(),
    txid: tx.getId(),
    vout: 0,
    address,
    amount: Number(amt),
    vsize: tx.virtualSize(),
    fee: Number(fee),
    feeRate,
    effectiveFeeRate: Number(fee) / tx.virtualSize(),
    inputs: chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: Number(u.value) })),
    change: Number(change),
    changeAddress: change > 0n ? changeAddr : null,
  };
}

/**
 * Check every input of a funding tx: P2WPKH witness [sig, pubkey] where the
 * pubkey matches `pubkey` and the signature verifies over the BIP143 digest
 * for the given input values. Returns {ok, errors}.
 */
function checkFundingTx(txOrHex, { pubkey, inputValues }) {
  const tx = typeof txOrHex === 'string' ? bitcoin.Transaction.fromHex(txOrHex) : txOrHex;
  const errors = [];
  const pub = Buffer.from(pubkey);
  const { scriptCode } = p2wpkh(pub);
  const ecc = require('tiny-secp256k1');
  tx.ins.forEach((inp, i) => {
    const w = (inp.witness || []).map((x) => Buffer.from(x));
    if (w.length !== 2) return errors.push(`input ${i}: witness has ${w.length} items, expected 2`);
    if (!w[1].equals(pub)) return errors.push(`input ${i}: pubkey mismatch`);
    let d;
    try {
      d = bitcoin.script.signature.decode(w[0]);
    } catch (e) {
      return errors.push(`input ${i}: bad DER (${e.message})`);
    }
    if (d.hashType !== SIGHASH_ALL) return errors.push(`input ${i}: hashtype ${d.hashType}`);
    const digest = Buffer.from(tx.hashForWitnessV0(i, scriptCode, toSatsNumber(inputValues[i], 'inputValue'), SIGHASH_ALL));
    if (!ecc.verify(digest, pub, d.signature, true)) errors.push(`input ${i}: signature does not verify`);
  });
  return { ok: errors.length === 0, errors };
}

module.exports = { buildFundingTx, checkFundingTx, selectUtxos, p2wpkh, hash160, SEQUENCE_RBF, DUST_P2WPKH, DUST_P2WSH };
