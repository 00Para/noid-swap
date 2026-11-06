#!/usr/bin/env node
/*
 * Generate a swap secret and its SHA-256 hashlock.
 *
 * Encoding (must match contracts/HTLC.sol and the Parano1d side):
 *   secret   = 32 random raw bytes
 *   hashlock = SHA-256(secret) over exactly those 32 raw bytes
 *              (no length prefix, no padding, not hex-text, not keccak256)
 *
 * Usage:  node scripts/secret.js            -> prints a fresh secret + hashlock
 *         node scripts/secret.js --json     -> same, as JSON
 *
 * KEEP THE SECRET PRIVATE until you claim on the counterparty's chain.
 * Only the hashlock goes on-chain when locking.
 */
const crypto = require("crypto");
const { sha256, hexlify } = require("ethers");

function generate() {
  const secret = crypto.randomBytes(32);
  const hashlock = crypto.createHash("sha256").update(secret).digest();

  const secretHex = "0x" + secret.toString("hex");
  const hashlockHex = "0x" + hashlock.toString("hex");

  // Self-check: ethers' sha256 over the same 32 bytes (the same bytes the
  // contract hashes via sha256(abi.encodePacked(bytes32))) must agree.
  const ethersHex = sha256(secretHex);
  if (secret.length !== 32 || ethersHex !== hashlockHex) {
    throw new Error(
      `self-check failed: node crypto ${hashlockHex} != ethers ${ethersHex} (secret length ${secret.length})`
    );
  }
  return { secret: secretHex, hashlock: hashlockHex, selfCheck: "ok" };
}

module.exports = { generate };

if (require.main === module) {
  const out = generate();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log("secret    (32 bytes, keep private):", out.secret);
    console.log("hashlock  (sha256(secret), public):", out.hashlock);
    console.log("self-check (node crypto == ethers sha256):", out.selfCheck);
  }
}
