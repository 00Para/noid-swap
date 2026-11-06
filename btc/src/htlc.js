'use strict';
/*
 * P2WSH SHA-256 HTLC for Bitcoin (the BTC leg of a NOID <-> BTC swap).
 *
 * Redeem script (witnessScript):
 *
 *   OP_IF
 *     OP_SIZE 32 OP_EQUALVERIFY
 *     OP_SHA256 <H> OP_EQUALVERIFY <alicePubkey>
 *   OP_ELSE
 *     <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <bobPubkey>
 *   OP_ENDIF
 *   OP_CHECKSIG
 *
 * Serialized (docs/protocol-design.md section 3.1):
 *   63 82 01 20 88 a8 20 <H:32> 88 21 <alice:33> 67 <push T_b> b1 75 21 <bob:33> 68 ac
 * OP_SIZE pushes the length of the top stack item without popping it, so
 * `OP_SIZE 32 OP_EQUALVERIFY` consumes only the length and leaves the preimage
 * on the stack: the claim fails unless the preimage is exactly 32 bytes (the
 * Ethereum and Parano1d legs both use 32). The old layout without it is NOT
 * accepted by decodeRedeemScript.
 *
 * Roles: Bob locks BTC to the P2WSH address of this script. Alice (who knows
 * the secret s, H = sha256(s), s = 32 raw bytes) CLAIMS with
 *     witness: [ <sig_alice> <s> 0x01 <redeemScript> ]
 * which publishes s in the witness. After `locktime`, Bob REFUNDS with
 *     witness: [ <sig_bob> <empty> <redeemScript> ]
 *
 * LOCKTIME SEMANTICS (BIP65 / BIP113)
 *   - `locktime` < 500,000,000  -> an absolute BLOCK HEIGHT.
 *     `locktime` >= 500,000,000 -> a UNIX TIME (seconds), compared with the
 *     median-time-past (MTP) of the previous 11 blocks (BIP113), which lags
 *     wall-clock by roughly an hour. HEIGHT IS RECOMMENDED: it is not subject
 *     to MTP lag and is easier to reason about next to another chain's timeout.
 *   - The refund tx must set nLockTime >= locktime AND of the same kind
 *     (height vs time) as the script's value, AND its input must have
 *     nSequence < 0xffffffff, otherwise OP_CHECKLOCKTIMEVERIFY fails (a final
 *     sequence disables nLockTime). We use 0xfffffffd (design section 3.1): it
 *     is below 0xffffffff so CLTV is enforced, and it signals BIP125 opt-in RBF
 *     so Bob can fee-bump a refund stuck in the mempool.
 *   - A tx with nLockTime = N (height) can be mined in block N+1 or later,
 *     i.e. once the chain tip height is >= N it is relayable (see
 *     isLocktimeReached()). For time locks the requirement is N < MTP(tip).
 *   - The CLTV in the ELSE branch only constrains the refund path. The claim
 *     path has no time limit on Bitcoin: Alice can claim until Bob's refund is
 *     actually mined. So the swap's safety margin must come from choosing this
 *     locktime SHORTER than the counterparty chain's timeout by enough to cover
 *     Bob noticing the reveal and claiming there (see README).
 *
 * SIGNING: SIGHASH_ALL, BIP143 (segwit v0) digest, scriptCode = the whole
 * redeem script (it contains no OP_CODESEPARATOR). Signatures are DER, low-S.
 *
 * API NOTE: bitcoinjs-lib v7 uses bigint for amounts and Uint8Array (not
 * Buffer) for bytes. This module accepts number|bigint amounts and
 * hex-string|Uint8Array bytes, and returns Buffers.
 */
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const { resolveNetwork } = require('./network');

const ECPair = ECPairFactory(ecc);
const OPS = bitcoin.opcodes;

const LOCKTIME_THRESHOLD = 500000000;
const MAX_LOCKTIME = 0xffffffff;
const SEQUENCE_FINAL = 0xffffffff;
/** Refund input sequence: < 0xffffffff so CLTV is enforced; 0xfffffffd signals opt-in RBF (BIP125) so Bob can fee-bump. */
const SEQUENCE_REFUND = 0xfffffffd;
/** Claim input sequence: 0xfffffffd signals opt-in RBF so Alice can fee-bump. */
const SEQUENCE_CLAIM = 0xfffffffd;
const SIGHASH_ALL = bitcoin.Transaction.SIGHASH_ALL;
const PREIMAGE_LENGTH = 32; // OP_SIZE 32 OP_EQUALVERIFY
const OP_TRUE_ITEM = Buffer.from([0x01]); // IF argument for the claim branch (MINIMALIF-safe)
const OP_FALSE_ITEM = Buffer.alloc(0); // IF argument for the refund branch (empty vector)

// ---------------------------------------------------------------- helpers

function toBuf(x, what, length) {
  let b;
  if (typeof x === 'string') {
    const h = x.startsWith('0x') ? x.slice(2) : x;
    if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`${what}: not valid hex`);
    b = Buffer.from(h, 'hex');
  } else if (x instanceof Uint8Array) {
    b = Buffer.from(x);
  } else {
    throw new Error(`${what}: expected hex string or bytes`);
  }
  if (length !== undefined && b.length !== length) {
    throw new Error(`${what}: expected ${length} bytes, got ${b.length}`);
  }
  return b;
}

function sha256(b) {
  return crypto.createHash('sha256').update(b).digest();
}

function checkPubkey(x, what) {
  const b = toBuf(x, what, 33); // segwit policy requires compressed keys
  if (!ecc.isPoint(b)) throw new Error(`${what}: not a valid compressed secp256k1 point`);
  return b;
}

function checkLocktime(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_LOCKTIME) {
    throw new Error(`locktime must be an integer in [1, ${MAX_LOCKTIME}] (got ${n})`);
  }
  return n;
}

function toSats(x, what) {
  let v;
  if (typeof x === 'bigint') v = x;
  else if (Number.isSafeInteger(x)) v = BigInt(x);
  else throw new Error(`${what}: expected a safe integer (satoshis) or bigint`);
  if (v < 0n || v > 2100000000000000n) throw new Error(`${what}: out of range`);
  return v;
}

/** 'height' if locktime < 500,000,000 else 'time'. */
function locktimeKind(locktime) {
  return locktime < LOCKTIME_THRESHOLD ? 'height' : 'time';
}

/**
 * Is a refund with nLockTime = `locktime` valid for inclusion in the NEXT block,
 * given the current chain tip? (Bitcoin Core IsFinalTx with BIP113.)
 *   height lock: locktime <= tipHeight
 *   time lock:   locktime <  tipMedianTimePast
 */
function isLocktimeReached(locktime, { tipHeight, tipMedianTimePast }) {
  checkLocktime(locktime);
  if (locktimeKind(locktime) === 'height') {
    if (!Number.isSafeInteger(tipHeight)) throw new Error('tipHeight required for a height locktime');
    return locktime <= tipHeight;
  }
  if (!Number.isSafeInteger(tipMedianTimePast)) throw new Error('tipMedianTimePast required for a time locktime');
  return locktime < tipMedianTimePast;
}

// ---------------------------------------------------------------- script

/**
 * Build the HTLC redeem script.
 * @param {{hashlock: string|Uint8Array, alicePubkey: string|Uint8Array,
 *          bobPubkey: string|Uint8Array, locktime: number}} p
 *   hashlock = sha256(s) (32 bytes); pubkeys = 33-byte compressed.
 * @returns {Buffer}
 */
function buildRedeemScript({ hashlock, alicePubkey, bobPubkey, locktime }) {
  const H = toBuf(hashlock, 'hashlock', 32);
  const alice = checkPubkey(alicePubkey, 'alicePubkey');
  const bob = checkPubkey(bobPubkey, 'bobPubkey');
  checkLocktime(locktime);
  if (alice.equals(bob)) throw new Error('alicePubkey and bobPubkey must differ');
  // script.number.encode returns a Uint8Array in v7; compile() turns 1..16 into OP_N.
  const lock = Buffer.from(bitcoin.script.number.encode(locktime));
  return Buffer.from(
    bitcoin.script.compile([
      OPS.OP_IF,
      OPS.OP_SIZE,
      Buffer.from([PREIMAGE_LENGTH]), // serializes as 01 20 (a bare 32 is not OP_N)
      OPS.OP_EQUALVERIFY,
      OPS.OP_SHA256,
      H,
      OPS.OP_EQUALVERIFY,
      alice,
      OPS.OP_ELSE,
      lock,
      OPS.OP_CHECKLOCKTIMEVERIFY,
      OPS.OP_DROP,
      bob,
      OPS.OP_ENDIF,
      OPS.OP_CHECKSIG,
    ])
  );
}

/**
 * Parse a redeem script back into its fields. STRICT: the script must be
 * byte-for-byte what buildRedeemScript() would produce for the extracted
 * fields (so non-minimal pushes, extra opcodes, trailing data, etc. are all
 * rejected). Throws on anything else.
 * @returns {{hashlock: Buffer, alicePubkey: Buffer, bobPubkey: Buffer,
 *            locktime: number, locktimeKind: 'height'|'time'}}
 */
function decodeRedeemScript(script) {
  const raw = toBuf(script, 'script');
  const chunks = bitcoin.script.decompile(raw);
  if (
    chunks &&
    chunks.length === 12 &&
    chunks[0] === OPS.OP_IF &&
    chunks[1] === OPS.OP_SHA256
  ) {
    // The pre-design layout (no OP_SIZE 32 OP_EQUALVERIFY). An address built from it must never pass as an HTLC.
    throw new Error('not an HTLC script: legacy layout without OP_SIZE 32 OP_EQUALVERIFY');
  }
  if (!chunks || chunks.length !== 15) throw new Error('not an HTLC script: wrong number of elements');
  const [IF, SIZE, LEN, EQV0, SHA, H, EQV, alice, ELSE, lock, CLTV, DROP, bob, ENDIF, CHECKSIG] = chunks;
  const ok =
    IF === OPS.OP_IF &&
    SIZE === OPS.OP_SIZE &&
    LEN instanceof Uint8Array &&
    LEN.length === 1 &&
    LEN[0] === PREIMAGE_LENGTH &&
    EQV0 === OPS.OP_EQUALVERIFY &&
    SHA === OPS.OP_SHA256 &&
    EQV === OPS.OP_EQUALVERIFY &&
    ELSE === OPS.OP_ELSE &&
    CLTV === OPS.OP_CHECKLOCKTIMEVERIFY &&
    DROP === OPS.OP_DROP &&
    ENDIF === OPS.OP_ENDIF &&
    CHECKSIG === OPS.OP_CHECKSIG &&
    H instanceof Uint8Array &&
    H.length === 32 &&
    alice instanceof Uint8Array &&
    alice.length === 33 &&
    bob instanceof Uint8Array &&
    bob.length === 33;
  if (!ok) throw new Error('not an HTLC script: opcode/push layout mismatch');

  let locktime;
  if (typeof lock === 'number') {
    // decompile() reports a minimal OP_1..OP_16 push as the opcode number
    if (lock < OPS.OP_1 || lock > OPS.OP_16) throw new Error('not an HTLC script: bad locktime push');
    locktime = lock - OPS.OP_1 + 1;
  } else if (lock instanceof Uint8Array) {
    if (lock.length > 5) throw new Error('not an HTLC script: locktime too long');
    locktime = bitcoin.script.number.decode(lock, 5, true);
  } else {
    throw new Error('not an HTLC script: bad locktime push');
  }

  const fields = {
    hashlock: Buffer.from(H),
    alicePubkey: Buffer.from(alice),
    bobPubkey: Buffer.from(bob),
    locktime,
  };
  const rebuilt = buildRedeemScript(fields); // also validates ranges / keys
  if (!rebuilt.equals(raw)) throw new Error('not an HTLC script: non-canonical encoding');
  return { ...fields, locktimeKind: locktimeKind(locktime) };
}

/** scriptPubKey of the P2WSH output: OP_0 <sha256(redeemScript)>. */
function p2wshScriptPubKey(redeemScript) {
  const h = sha256(toBuf(redeemScript, 'redeemScript'));
  return Buffer.concat([Buffer.from([0x00, 0x20]), h]);
}

/** Bech32 P2WSH address for the redeem script. network: name|object, default testnet/signet. */
function p2wshAddress(redeemScript, network) {
  return bitcoin.address.fromOutputScript(p2wshScriptPubKey(redeemScript), resolveNetwork(network));
}

/**
 * For a COUNTERPARTY who is shown (address, redeemScript): confirm the script
 * is a well-formed HTLC, hashes to the address, and has the expected terms.
 * `expected` fields are all optional; give those you care about:
 *   hashlock, alicePubkey, bobPubkey, locktime (exact), minLocktime, maxLocktime.
 * Returns the decoded fields; throws a descriptive Error on any mismatch.
 * (This checks the *script*. You must still check on-chain that the address
 * is funded with the right amount and enough confirmations.)
 */
function verifyLock({ redeemScript, address, network, expected = {} }) {
  const f = decodeRedeemScript(redeemScript);
  if (address !== undefined) {
    const actual = p2wshAddress(redeemScript, network);
    if (actual !== address) throw new Error(`address mismatch: script hashes to ${actual}, shown ${address}`);
  }
  const eq = (name, a, b) => {
    if (b !== undefined && !a.equals(toBuf(b, name))) throw new Error(`${name} mismatch`);
  };
  eq('hashlock', f.hashlock, expected.hashlock);
  eq('alicePubkey', f.alicePubkey, expected.alicePubkey);
  eq('bobPubkey', f.bobPubkey, expected.bobPubkey);
  if (expected.locktime !== undefined && f.locktime !== expected.locktime) throw new Error('locktime mismatch');
  if (expected.minLocktime !== undefined && f.locktime < expected.minLocktime) throw new Error('locktime too early');
  if (expected.maxLocktime !== undefined && f.locktime > expected.maxLocktime) throw new Error('locktime too late');
  if (
    (expected.minLocktime !== undefined || expected.maxLocktime !== undefined || expected.locktime !== undefined) &&
    [expected.locktime, expected.minLocktime, expected.maxLocktime]
      .filter((x) => x !== undefined)
      .some((x) => locktimeKind(x) !== f.locktimeKind)
  ) {
    throw new Error('locktime kind (height vs time) mismatch');
  }
  return f;
}

// ---------------------------------------------------------------- witnesses

/** Claim witness stack: [sig, preimage, 0x01, redeemScript]. */
function claimWitness(sig, preimage, redeemScript) {
  return [Buffer.from(sig), Buffer.from(preimage), Buffer.from(OP_TRUE_ITEM), Buffer.from(redeemScript)];
}

/** Refund witness stack: [sig, <empty>, redeemScript]. */
function refundWitness(sig, redeemScript) {
  return [Buffer.from(sig), Buffer.alloc(0), Buffer.from(redeemScript)];
}

// ---------------------------------------------------------------- tx building

/** BIP143 sighash (SIGHASH_ALL) for input `inIndex`, scriptCode = redeemScript. */
function htlcSighash(tx, inIndex, redeemScript, amount) {
  return Buffer.from(
    tx.hashForWitnessV0(inIndex, toBuf(redeemScript, 'redeemScript'), toSats(amount, 'amount'), SIGHASH_ALL)
  );
}

/** DER signature + SIGHASH_ALL byte, low-S, low-R (smaller). */
function signHtlcInput(tx, inIndex, redeemScript, amount, keyPair) {
  const hash = htlcSighash(tx, inIndex, redeemScript, amount);
  const sig = keyPair.sign(hash, true);
  return Buffer.from(bitcoin.script.signature.encode(sig, SIGHASH_ALL));
}

/**
 * Dust threshold in sats for an output script at Core's default dust relay fee
 * (3 sat/vB): 294 for P2WPKH, 330 for P2WSH/P2TR, 546 for P2PKH. A claim or
 * refund whose output would be below this is non-standard and will not relay.
 */
function dustThreshold(scriptPubKey) {
  const spk = toBuf(scriptPubKey, 'scriptPubKey');
  const isWitnessProgram =
    spk.length >= 4 && spk.length <= 42 && (spk[0] === 0x00 || (spk[0] >= 0x51 && spk[0] <= 0x60)) && spk[1] === spk.length - 2;
  const spendCost = isWitnessProgram ? 67 : 148;
  return 3 * (8 + 1 + spk.length + spendCost);
}

function destinationScript(destination, network) {
  if (typeof destination === 'string') return Buffer.from(bitcoin.address.toOutputScript(destination, resolveNetwork(network)));
  return toBuf(destination, 'destination');
}

function txidToHash(txid) {
  return toBuf(txid, 'txid', 32).reverse(); // display order -> internal byte order
}

/**
 * Shared builder. kind: 'claim' | 'refund'.
 */
function buildSpend(kind, p) {
  const { redeemScript, utxo, destination, network, keyPair, fee, feeRate } = p;
  const rs = toBuf(redeemScript, 'redeemScript');
  const fields = decodeRedeemScript(rs);
  const amount = toSats(utxo.value, 'utxo.value');
  const vout = utxo.vout;
  if (!Number.isInteger(vout) || vout < 0) throw new Error('utxo.vout must be a non-negative integer');
  if ((fee === undefined) === (feeRate === undefined)) throw new Error('give exactly one of fee (sats) or feeRate (sat/vB)');

  const signerPub = Buffer.from(keyPair.publicKey);
  const expectedPub = kind === 'claim' ? fields.alicePubkey : fields.bobPubkey;
  if (!signerPub.equals(expectedPub)) {
    throw new Error(`keyPair does not match the ${kind === 'claim' ? 'alice' : 'bob'} pubkey in the script`);
  }

  let preimage;
  if (kind === 'claim') {
    preimage = toBuf(p.preimage, 'preimage', 32);
    if (!sha256(preimage).equals(fields.hashlock)) throw new Error('sha256(preimage) != hashlock in script');
  }

  let sequence;
  if (kind === 'claim') {
    sequence = p.sequence === undefined ? SEQUENCE_CLAIM : p.sequence;
  } else {
    sequence = p.sequence === undefined ? SEQUENCE_REFUND : p.sequence;
    if (sequence >= SEQUENCE_FINAL) throw new Error('refund input nSequence must be < 0xffffffff or CLTV fails');
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > SEQUENCE_FINAL) throw new Error('bad sequence');

  const spk = destinationScript(destination, network);
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = kind === 'refund' ? fields.locktime : 0;
  tx.addInput(txidToHash(utxo.txid), vout, sequence);
  tx.addOutput(spk, 0n);

  // Fee: size the tx with a worst-case (73 byte) signature; real sigs are <= that.
  const dummySig = Buffer.alloc(73, 0x30);
  tx.setWitness(0, kind === 'claim' ? claimWitness(dummySig, preimage, rs) : refundWitness(dummySig, rs));
  const estVsize = tx.virtualSize();
  if (feeRate !== undefined && !(feeRate > 0)) throw new Error('feeRate must be > 0');
  const feeSats = fee !== undefined ? toSats(fee, 'fee') : BigInt(Math.ceil(feeRate * estVsize));
  const outValue = amount - feeSats;
  const dust = BigInt(dustThreshold(spk));
  if (outValue < dust) {
    throw new Error(`output ${outValue} sats is below the dust threshold ${dust} (fee ${feeSats}, input ${amount})`);
  }
  tx.outs[0].value = outValue;

  const sig = signHtlcInput(tx, 0, rs, amount, keyPair);
  tx.setWitness(0, kind === 'claim' ? claimWitness(sig, preimage, rs) : refundWitness(sig, rs));

  return {
    tx,
    hex: tx.toHex(),
    txid: tx.getId(),
    vsize: tx.virtualSize(),
    weight: tx.weight(),
    fee: Number(feeSats),
    outputValue: Number(outValue),
  };
}

/**
 * Build + sign the CLAIM tx (Alice). Reveals the preimage in the witness.
 * @param {object} p
 *   redeemScript, utxo:{txid (display hex), vout, value (sats)},
 *   destination (address string or scriptPubKey bytes), preimage (32 bytes),
 *   keyPair (ECPair for alicePubkey), network, and EXACTLY ONE of
 *   fee (absolute sats) | feeRate (sat/vB). Optional: sequence (default 0xfffffffd, RBF).
 *   The claim pays its own fee out of the HTLC value; nothing else is added.
 */
function buildClaimTx(p) {
  return buildSpend('claim', p);
}

/**
 * Build + sign the REFUND tx (Bob). nLockTime = script locktime,
 * nSequence = 0xfffffffd (RBF opt-in). Not valid for the network until the locktime has
 * passed (see isLocktimeReached). Same params as buildClaimTx minus preimage.
 */
function buildRefundTx(p) {
  return buildSpend('refund', p);
}

// ---------------------------------------------------------------- keys

function keyPairFromWif(wif, network) {
  return ECPair.fromWIF(wif, resolveNetwork(network));
}
function keyPairFromPrivateKey(priv, network) {
  return ECPair.fromPrivateKey(toBuf(priv, 'privateKey', 32), { network: resolveNetwork(network) });
}
function randomKeyPair(network) {
  return ECPair.makeRandom({ network: resolveNetwork(network) });
}

module.exports = {
  buildRedeemScript,
  decodeRedeemScript,
  p2wshScriptPubKey,
  p2wshAddress,
  verifyLock,
  buildClaimTx,
  buildRefundTx,
  // lower level
  htlcSighash,
  signHtlcInput,
  claimWitness,
  refundWitness,
  dustThreshold,
  locktimeKind,
  isLocktimeReached,
  // keys
  ECPair,
  keyPairFromWif,
  keyPairFromPrivateKey,
  randomKeyPair,
  // constants
  LOCKTIME_THRESHOLD,
  SEQUENCE_FINAL,
  SEQUENCE_REFUND,
  SEQUENCE_CLAIM,
  PREIMAGE_LENGTH,
  SIGHASH_ALL,
  OP_TRUE_ITEM,
  OP_FALSE_ITEM,
  // internal helpers reused by verify.js
  _toBuf: toBuf,
  _sha256: sha256,
};
