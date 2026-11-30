"use strict";
/*
 * NIP-44 version 2 encryption (secp256k1 key agreement, HKDF, padding, ChaCha20, HMAC-SHA256, base64), written against the published text and
 * checked against its official test vectors (test/board-nip44.test.js).
 *
 *  - The shared point's x coordinate comes from the vendored @noble/curves (`getSharedSecret` with an even-y lift of the x-only public key, which is
 *    what the x-only form means); the point arithmetic is not ours.
 *  - HKDF-extract and HKDF-expand are built from HMAC-SHA256 here (Node's hkdfSync always does both at once; NIP-44 needs them separately).
 *  - ChaCha20 is Node's own (OpenSSL form: a 16-byte IV is the 4-byte little-endian block counter, here 0, then the 12-byte nonce).
 *  - A conversation key and a message key are secrets: never logged, never put in an error text.
 *
 * Plaintext length: 1 to 65,535 bytes. The current NIP text also describes a 6-byte extended prefix for longer plaintexts, but its own
 * published vectors list 65,536 as invalid, so both limits are kept as the vectors say; a payload that decodes to the extended form is refused.
 */

const crypto = require("crypto");
const { secp256k1 } = require("../../vendor");
const { fail, secretBytes } = require("./note");

const SALT = Buffer.from("nip44-v2", "utf8");
const MAX_PLAINTEXT = 65535;
const MAX_PAYLOAD_CHARS = 4 * Math.ceil((1 + 32 + 2 + 65536 + 32) / 3); // base64 length of the largest valid payload
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const hmac = (key, ...parts) => {
  const h = crypto.createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
};

/** HKDF-extract (RFC 5869) with SHA-256. */
const hkdfExtract = (ikm, salt) => hmac(salt, ikm);

/** HKDF-expand (RFC 5869) with SHA-256: `length` bytes from a pseudo-random key and an info string. */
function hkdfExpand(prk, info, length) {
  if (length > 255 * 32) fail("nip44", "hkdf output too long");
  const out = [];
  let t = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    t = hmac(prk, t, info, Buffer.from([i]));
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, length);
}

/**
 * The long-term key between two parties: conv(a, B) == conv(b, A).
 * @param {Buffer|string} secret our secret key
 * @param {string} pubHex their x-only public key (64 hex)
 * @returns {Buffer} 32 bytes (a secret)
 */
function getConversationKey(secret, pubHex) {
  const sk = secretBytes(secret);
  if (typeof pubHex !== "string" || !/^[0-9a-f]{64}$/.test(pubHex)) fail("nip44", "a public key is 64 lower-case hex characters");
  let shared;
  try {
    shared = Buffer.from(secp256k1.getSharedSecret(sk, "02" + pubHex, true)); // 33 bytes: prefix + x
  } catch {
    fail("nip44", "the public key is not a valid point");
  }
  return hkdfExtract(shared.subarray(1, 33), SALT);
}

function getMessageKeys(conversationKey, nonce) {
  if (!Buffer.isBuffer(conversationKey) || conversationKey.length !== 32) fail("nip44", "invalid conversation_key length");
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) fail("nip44", "invalid nonce length");
  const keys = hkdfExpand(conversationKey, nonce, 76);
  return { chachaKey: keys.subarray(0, 32), chachaNonce: keys.subarray(32, 44), hmacKey: keys.subarray(44, 76) };
}

/** Length of the padded plaintext (without the 2-byte prefix). */
function calcPaddedLen(unpaddedLen) {
  if (!Number.isInteger(unpaddedLen) || unpaddedLen < 1) fail("nip44", "invalid plaintext length");
  if (unpaddedLen <= 32) return 32;
  const nextPower = 2 ** (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

function pad(plaintext) {
  if (typeof plaintext !== "string" || !plaintext.isWellFormed()) fail("nip44", "plaintext is not well-formed text");
  const unpadded = Buffer.from(plaintext, "utf8");
  if (unpadded.length < 1 || unpadded.length > MAX_PLAINTEXT) fail("nip44", "invalid plaintext length");
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(unpadded.length);
  return Buffer.concat([prefix, unpadded, Buffer.alloc(calcPaddedLen(unpadded.length) - unpadded.length)]);
}

function unpad(padded) {
  if (padded.length < 2 + 32) fail("nip44", "invalid padding");
  const len = padded.readUInt16BE(0);
  if (len === 0) fail("nip44", "invalid padding"); // the extended form is not accepted (see the header)
  const body = padded.subarray(2, 2 + len);
  if (body.length !== len || padded.length !== 2 + calcPaddedLen(len)) fail("nip44", "invalid padding");
  // the padding bytes are zeros in every implementation; a payload with anything else there is not one of ours
  for (let i = 2 + len; i < padded.length; i++) if (padded[i] !== 0) fail("nip44", "invalid padding");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    fail("nip44", "plaintext is not valid UTF-8");
  }
}

function chacha20(key, nonce12, data) {
  const iv = Buffer.concat([Buffer.alloc(4), nonce12]); // counter 0
  const c = crypto.createCipheriv("chacha20", key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

/**
 * @param {string} plaintext
 * @param {Buffer} conversationKey
 * @param {Buffer} [nonce] 32 random bytes; given only by tests that reproduce the vectors
 * @returns {string} the base64 payload
 */
function encrypt(plaintext, conversationKey, nonce = crypto.randomBytes(32)) {
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmac(hmacKey, nonce, ciphertext);
  return Buffer.concat([Buffer.from([2]), nonce, ciphertext, mac]).toString("base64");
}

function decodePayload(payload) {
  if (typeof payload !== "string" || payload.length === 0 || payload[0] === "#") fail("nip44", "unknown version");
  if (payload.length < 132 || payload.length > MAX_PAYLOAD_CHARS) fail("nip44", "invalid payload size");
  if (payload.length % 4 !== 0 || !B64.test(payload)) fail("nip44", "invalid base64");
  const data = Buffer.from(payload, "base64");
  if (data.length < 99) fail("nip44", "invalid data size");
  if (data[0] !== 2) fail("nip44", "unknown version");
  return { nonce: data.subarray(1, 33), ciphertext: data.subarray(33, data.length - 32), mac: data.subarray(data.length - 32) };
}

/** @returns {string} the plaintext; throws a BoardError("nip44") on any fault, after a constant-time MAC check */
function decrypt(payload, conversationKey) {
  const { nonce, ciphertext, mac } = decodePayload(payload);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const calculated = hmac(hmacKey, nonce, ciphertext);
  if (!crypto.timingSafeEqual(calculated, mac)) fail("nip44", "invalid MAC");
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}

module.exports = { getConversationKey, getMessageKeys, calcPaddedLen, pad, unpad, encrypt, decrypt, hkdfExtract, hkdfExpand, MAX_PLAINTEXT };
