#!/usr/bin/env node
/*
 * Generate a swap secret and its SHA-256 hashlock. Mirrors
 * ../../eth/scripts/secret.js so both legs of the swap use identical bytes.
 *
 * Encoding (same on every leg, including Parano1d):
 *   secret   = 32 random raw bytes
 *   hashlock = SHA-256(secret) over exactly those 32 raw bytes
 *              (no length prefix, no padding, not hex-text, not keccak256)
 *
 * On Bitcoin the script does `OP_SHA256 <H> OP_EQUALVERIFY`, i.e. it hashes the
 * witness item byte-for-byte, so the witness item must be the 32 raw bytes.
 *
 * Usage:  node src/secret.js         -> prints a fresh secret + hashlock
 *         node src/secret.js --json  -> same, as JSON
 *
 * KEEP THE SECRET PRIVATE until Alice claims. Only the hashlock is shared.
 */
const crypto = require('crypto');

const SECRET_LENGTH = 32;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function hexToBytes(hex, what) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`${what}: not hex`);
  return Buffer.from(h, 'hex');
}

/** Normalise a 32-byte value given as 0x-hex, hex, or bytes -> Buffer. */
function toBytes32(x, what = 'value') {
  const b = typeof x === 'string' ? hexToBytes(x, what) : Buffer.from(x);
  if (b.length !== SECRET_LENGTH) {
    throw new Error(`${what} must be exactly 32 bytes (got ${b.length})`);
  }
  return b;
}

/** hashlock = SHA-256(32 raw bytes). Accepts hex (0x optional) or bytes. */
function hashlockOf(secret) {
  return sha256(toBytes32(secret, 'secret'));
}

/**
 * Re-implementation of what eth/scripts/secret.js does, spelled out the way
 * eth/README.md describes it: the hex string is decoded to bytes and those
 * bytes are hashed, output rendered as 0x + 64 hex chars. Used as a
 * cross-check; it deliberately shares no code with hashlockOf().
 */
function ethHashlock(secretHex0x) {
  if (!/^0x[0-9a-f]{64}$/i.test(secretHex0x)) throw new Error('expected 0x + 64 hex chars');
  return '0x' + crypto.createHash('sha256').update(Buffer.from(secretHex0x.slice(2), 'hex')).digest('hex');
}

/** Assert BTC-side and ETH-side hashlocks agree for the same secret bytes. */
function assertMatchesEth(secret) {
  const s = toBytes32(secret, 'secret');
  const btc = '0x' + hashlockOf(s).toString('hex');
  const eth = ethHashlock('0x' + s.toString('hex'));
  if (btc !== eth) throw new Error(`hashlock mismatch: btc ${btc} != eth ${eth}`);
  return btc;
}

function generate() {
  const secret = crypto.randomBytes(SECRET_LENGTH);
  const secretHex = '0x' + secret.toString('hex');
  const hashlockHex = assertMatchesEth(secret); // throws on any divergence
  return { secret: secretHex, hashlock: hashlockHex, selfCheck: 'ok' };
}

module.exports = { generate, hashlockOf, ethHashlock, assertMatchesEth, toBytes32, sha256, SECRET_LENGTH };

if (require.main === module) {
  const out = generate();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log('secret    (32 bytes, keep private):', out.secret);
    console.log('hashlock  (sha256(secret), public):', out.hashlock);
    console.log('self-check (btc hashlock == eth encoding):', out.selfCheck);
  }
}
