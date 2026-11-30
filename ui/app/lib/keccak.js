"use strict";
/*
 * Keccak-256 (the Ethereum hash, NOT NIST SHA3-256: padding byte 0x01), BigInt lanes, no dependency.
 * Used only to re-derive, independently of eth/scripts/live.js, two things a dry run prints: the function selector
 * of newLock / refund and the lock id (keccak256 of the packed sender, receiver, amount, hashlock, timelock).
 * Speed does not matter here (a few hundred bytes at most).
 */

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const rotl = (x, n) => (((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function keccakF(st) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    let t = st[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const tmp = st[j];
      st[j] = rotl(t, ROTC[i]);
      t = tmp;
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = st[j + i];
      for (let i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5] & MASK) & bc[(i + 2) % 5];
    }
    st[0] ^= RC[round];
  }
}

/** @param {Buffer|Uint8Array|string} input a string is hashed as UTF-8 @returns {Buffer} 32 bytes */
function keccak256(input) {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const rate = 136;
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / rate) * rate);
  data.copy(padded);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const st = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) st[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(st);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(st[i], i * 8);
  return out;
}

const keccak256Hex = (input) => "0x" + keccak256(input).toString("hex");

const strip0x = (h) => String(h).replace(/^0x/i, "");

/** abi.encodePacked(address, address, uint256, bytes32, uint256) hashed: the lock id of HTLC.computeLockId. */
function lockIdOf(sender, receiver, amountWei, hashlock, timelock) {
  const parts = [
    Buffer.from(strip0x(sender), "hex"),
    Buffer.from(strip0x(receiver), "hex"),
    Buffer.from(BigInt(amountWei).toString(16).padStart(64, "0"), "hex"),
    Buffer.from(strip0x(hashlock), "hex"),
    Buffer.from(BigInt(timelock).toString(16).padStart(64, "0"), "hex"),
  ];
  for (const [i, n] of [20, 20, 32, 32, 32].entries()) if (parts[i].length !== n) throw new Error("lockIdOf: a field has the wrong width");
  return keccak256Hex(Buffer.concat(parts));
}

/** The 4-byte selector of a signature, as 0x + 8 hex. */
const selectorOf = (signature) => "0x" + keccak256(signature).subarray(0, 4).toString("hex");

module.exports = { keccak256, keccak256Hex, lockIdOf, selectorOf };
