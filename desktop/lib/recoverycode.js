"use strict";
/*
 * The recovery code (piece 4, spec 6.5): the install secret S written so a person can keep it on paper and type it back.
 *
 *   payload = 0x01 (version) || S (32 bytes) || CRC-16 (2 bytes, big-endian)            35 bytes = 280 bits
 *   CRC     = CRC-16/CCITT-FALSE over 0x01 || S: polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR (check value of "123456789": 0x29B1)
 *   text    = Crockford base32 (alphabet 0123456789ABCDEFGHJKMNPQRSTVWXYZ), 5 bits a character, most significant bit first: 56 characters,
 *             shown as 14 groups of 4 joined by "-"
 *
 * A CRC finds every single wrong character and every swap of two neighbouring characters (both are error bursts of at most 10 bits; a CRC-16 finds every
 * burst of 16 bits or fewer), which a cut hash would only find with a probability.
 *
 * Reading: case does not matter; spaces and hyphens are dropped; O reads as 0, I and L as 1; U and any other character are refused; the length must be
 * 56, the version 1 and the CRC must match.
 *
 * Nothing here logs, prints or keeps a value. The code is shown and typed only in the secret window of the main process (vault.js, I6).
 */

const crypto = require("crypto");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VERSION = 0x01;
const CHARS = 56;
const GROUP = 4;
const GROUPS = CHARS / GROUP; // 14

class RecoveryCodeError extends Error {}

/** CRC-16/CCITT-FALSE of a Buffer. */
function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(buf) {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of buf) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]; // not reached for 35 bytes (280 bits = 56 x 5)
  return out;
}

/** The 56 characters, no hyphens. */
function encodeRaw(S) {
  if (!Buffer.isBuffer(S) || S.length !== 32) throw new RecoveryCodeError("the install secret is not 32 bytes");
  const body = Buffer.concat([Buffer.from([VERSION]), S]);
  const crc = crc16(body);
  return base32(Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff])]));
}

/** The code as shown: 14 groups of 4, joined by "-". */
function encode(S) {
  return groupsOf(encodeRaw(S)).join("-");
}

function groupsOf(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += GROUP) out.push(raw.slice(i, i + GROUP));
  return out;
}

/** The reading rules for typed text: upper case, spaces and hyphens dropped, O to 0, I and L to 1. Returns null for a character that is not allowed. */
function normalise(text) {
  if (typeof text !== "string") return null;
  let out = "";
  for (const raw of text) {
    const ch = raw >= "a" && raw <= "z" ? raw.toUpperCase() : raw; // ASCII letters only: a locale mapping would read the German sharp s as SS
    if (ch === " " || ch === "-") continue;
    const c = ch === "O" ? "0" : ch === "I" || ch === "L" ? "1" : ch;
    if (c.length !== 1 || !ALPHABET.includes(c)) return null;
    out += c;
  }
  return out;
}

/** A typed group read by the same rules; the 4 characters, or null when it is not a group. */
function normaliseGroup(text) {
  const n = normalise(text);
  return n !== null && n.length === GROUP ? n : null;
}

/** The text back to S (a Buffer the caller zero-fills). Throws RecoveryCodeError with a fixed text that carries no part of the input. */
function decode(text) {
  const n = normalise(text);
  if (n === null) throw new RecoveryCodeError("the recovery code has a character that is not allowed");
  if (n.length !== CHARS) throw new RecoveryCodeError("the recovery code has the wrong length");
  const bytes = Buffer.alloc((CHARS * 5) / 8);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of n) {
    acc = (acc << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes[at++] = (acc >> (bits - 8)) & 0xff;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  const body = bytes.subarray(0, 33);
  const crc = (bytes[33] << 8) | bytes[34];
  const ok = crc === crc16(body);
  if (!ok) {
    bytes.fill(0);
    throw new RecoveryCodeError("the recovery code does not check out: a character is wrong");
  }
  if (bytes[0] !== VERSION) {
    bytes.fill(0);
    throw new RecoveryCodeError("the recovery code is of a version this program does not know");
  }
  const S = Buffer.from(bytes.subarray(1, 33));
  bytes.fill(0);
  return S;
}

/**
 * Three group numbers (1 to 14, ascending) for the type-back: all different, and not three in a row. `randomInt` is crypto.randomInt unless a test gives
 * another one with the same signature (min inclusive, max exclusive).
 */
function pickPositions(randomInt = crypto.randomInt) {
  for (;;) {
    const set = new Set();
    while (set.size < 3) set.add(randomInt(1, GROUPS + 1));
    const [a, b, c] = [...set].sort((x, y) => x - y);
    if (b === a + 1 && c === b + 1) continue;
    return [a, b, c];
  }
}

module.exports = { ALPHABET, VERSION, CHARS, GROUP, GROUPS, RecoveryCodeError, crc16, base32, encode, encodeRaw, groupsOf, normalise, normaliseGroup, decode, pickPositions };
