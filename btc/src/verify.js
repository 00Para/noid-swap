'use strict';
/*
 * Minimal checker for HTLC spends. bitcoinjs-lib has no script interpreter, so
 * this re-implements, for exactly our one script template, what consensus +
 * standardness would evaluate:
 *
 *   claim  witness [sig, preimage, 0x01, script]:
 *     IF-arg is exactly 0x01 (MINIMALIF); len(preimage) == 32
 *     (OP_SIZE 32 OP_EQUALVERIFY); sha256(preimage) == H
 *     (OP_SHA256 <H> OP_EQUALVERIFY); sig is a strict-DER, low-S, SIGHASH_ALL
 *     signature by alicePubkey over the BIP143 digest (OP_CHECKSIG).
 *   refund witness [sig, <empty>, script]:
 *     IF-arg is empty; CLTV: input nSequence != 0xffffffff, tx.nLockTime and
 *     script locktime are the same kind (height/time) and tx.nLockTime >=
 *     script locktime; sig by bobPubkey over the BIP143 digest.
 *
 * It is NOT a general interpreter and is no substitute for testmempoolaccept
 * on a real node before broadcasting. It does not check that the outpoint
 * exists, that the spent amount is right (you supply it), or fees.
 */
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const {
  decodeRedeemScript,
  p2wshScriptPubKey,
  htlcSighash,
  locktimeKind,
  isLocktimeReached,
  SEQUENCE_FINAL,
  PREIMAGE_LENGTH,
  SIGHASH_ALL,
  _toBuf: toBuf,
  _sha256: sha256,
} = require('./htlc');

function loadTx(tx) {
  if (typeof tx === 'string') return bitcoin.Transaction.fromHex(tx);
  if (tx instanceof Uint8Array) return bitcoin.Transaction.fromBuffer(tx);
  return tx;
}

function checkSig(tx, inIndex, redeemScript, amount, sigWithType, pubkey, label, errors) {
  let decoded;
  try {
    decoded = bitcoin.script.signature.decode(Buffer.from(sigWithType));
  } catch (e) {
    errors.push(`${label}: signature is not strict DER with a hashtype byte (${e.message})`);
    return false;
  }
  if (decoded.hashType !== SIGHASH_ALL) {
    errors.push(`${label}: hashtype ${decoded.hashType} is not SIGHASH_ALL (1)`);
    return false;
  }
  const digest = htlcSighash(tx, inIndex, redeemScript, amount);
  // strict=true -> reject high-S (BIP146 LOW_S standardness rule)
  if (!ecc.verify(digest, pubkey, decoded.signature, true)) {
    errors.push(`${label}: signature does not verify for the expected pubkey over the BIP143 digest`);
    return false;
  }
  return true;
}

/**
 * Check one input of `tx` as an HTLC spend.
 * @param {Transaction|string|Uint8Array} txOrHex
 * @param {number} inIndex
 * @param {{amount: number|bigint, scriptPubKey?: Uint8Array|string,
 *          redeemScript?: Uint8Array|string,
 *          chain?: {tipHeight?: number, tipMedianTimePast?: number}}} ctx
 *   amount = value (sats) of the P2WSH output being spent (committed to by BIP143).
 *   scriptPubKey = optional prevout script to check the witness script hashes to.
 *   redeemScript = optional script the witness must equal.
 *   chain = optional tip info; if given, a refund is also flagged when its
 *   locktime has not yet matured.
 * @returns {{ok: boolean, branch: 'claim'|'refund'|null, errors: string[], preimage?: Buffer}}
 */
function checkHtlcSpend(txOrHex, inIndex, ctx) {
  const tx = loadTx(txOrHex);
  const errors = [];
  const result = { ok: false, branch: null, errors };
  const input = tx.ins[inIndex];
  if (!input) {
    errors.push('no such input');
    return result;
  }
  if (input.script && input.script.length) errors.push('scriptSig must be empty for native P2WSH');
  const w = input.witness || [];
  if (w.length < 3) {
    errors.push(`witness has ${w.length} items, expected 3 (refund) or 4 (claim)`);
    return result;
  }
  const witnessScript = Buffer.from(w[w.length - 1]);
  if (ctx.redeemScript !== undefined && !witnessScript.equals(toBuf(ctx.redeemScript, 'redeemScript'))) {
    errors.push('witness script differs from the expected redeem script');
  }
  if (ctx.scriptPubKey !== undefined && !p2wshScriptPubKey(witnessScript).equals(toBuf(ctx.scriptPubKey, 'scriptPubKey'))) {
    errors.push('witness script does not hash to the prevout scriptPubKey');
  }
  let f;
  try {
    f = decodeRedeemScript(witnessScript);
  } catch (e) {
    errors.push(`witness script is not a valid HTLC script: ${e.message}`);
    return result;
  }

  const selector = Buffer.from(w[w.length - 2]);
  if (selector.length === 1 && selector[0] === 0x01) {
    // ---- IF branch: claim
    result.branch = 'claim';
    if (w.length !== 4) {
      errors.push(`claim witness must have 4 items (got ${w.length})`);
      return result;
    }
    const preimage = Buffer.from(w[1]);
    if (preimage.length !== PREIMAGE_LENGTH) {
      errors.push(`claim: preimage is ${preimage.length} bytes, the script requires exactly ${PREIMAGE_LENGTH} (OP_SIZE 32 OP_EQUALVERIFY would fail)`);
    } else if (!sha256(preimage).equals(f.hashlock)) {
      errors.push('claim: sha256(preimage) != hashlock (OP_EQUALVERIFY would fail)');
    } else {
      result.preimage = preimage;
    }
    checkSig(tx, inIndex, witnessScript, ctx.amount, w[0], f.alicePubkey, 'claim', errors);
  } else if (selector.length === 0) {
    // ---- ELSE branch: refund
    result.branch = 'refund';
    if (w.length !== 3) {
      errors.push(`refund witness must have 3 items (got ${w.length})`);
      return result;
    }
    if (input.sequence === SEQUENCE_FINAL) {
      errors.push('refund: input nSequence is 0xffffffff (final); CLTV would fail');
    }
    if (locktimeKind(tx.locktime) !== f.locktimeKind) {
      errors.push(`refund: tx nLockTime (${tx.locktime}) is a ${locktimeKind(tx.locktime)}, script locktime is a ${f.locktimeKind}`);
    } else if (tx.locktime < f.locktime) {
      errors.push(`refund: tx nLockTime ${tx.locktime} < script locktime ${f.locktime}; CLTV would fail`);
    }
    if (ctx.chain && !errors.length) {
      try {
        if (!isLocktimeReached(tx.locktime, ctx.chain)) errors.push('refund: locktime not yet reached at the given chain tip');
      } catch (e) {
        errors.push(`refund: ${e.message}`);
      }
    }
    checkSig(tx, inIndex, witnessScript, ctx.amount, w[0], f.bobPubkey, 'refund', errors);
  } else {
    errors.push('IF selector must be exactly 0x01 (claim) or empty (refund) (MINIMALIF)');
    return result;
  }
  result.ok = errors.length === 0;
  return result;
}

/**
 * What Bob's watcher does: given a transaction seen spending the HTLC output
 * (from mempool or a block), return the 32-byte preimage if and only if some
 * input carries a claim witness whose preimage hashes to the hashlock; else null.
 * `hashlock` is optional: if omitted, the hashlock inside the witness script is
 * used (then pass `redeemScript`/check the outpoint yourself so you know the
 * tx really spends YOUR lock). The sha256 check is always performed, so a
 * garbage witness can never yield a "preimage".
 * NOTE: signature validity is not needed to learn s, but only trust s from a
 * tx that spends your outpoint; consensus guarantees that tx is valid if confirmed.
 */
function extractPreimage(txOrHex, { hashlock, redeemScript } = {}) {
  const tx = loadTx(txOrHex);
  const want = hashlock === undefined ? undefined : toBuf(hashlock, 'hashlock', 32);
  const wantScript = redeemScript === undefined ? undefined : toBuf(redeemScript, 'redeemScript');
  for (const input of tx.ins) {
    const w = input.witness || [];
    if (w.length !== 4) continue;
    const sel = Buffer.from(w[2]);
    if (!(sel.length === 1 && sel[0] === 0x01)) continue;
    const script = Buffer.from(w[3]);
    if (wantScript && !script.equals(wantScript)) continue;
    let f;
    try {
      f = decodeRedeemScript(script);
    } catch {
      continue;
    }
    if (want && !f.hashlock.equals(want)) continue;
    const preimage = Buffer.from(w[1]);
    if (preimage.length === 32 && sha256(preimage).equals(f.hashlock)) return preimage;
  }
  return null;
}

module.exports = { checkHtlcSpend, extractPreimage };
