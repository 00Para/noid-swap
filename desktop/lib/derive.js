"use strict";
/*
 * The derivation of every key and passphrase from the install secret S (piece 4, spec 6.3). Pure functions over bytes; standard library only.
 *
 *   K(L, R)       = HMAC-SHA256(key = S, message = ASCII("no1d-swap/v1/" + L + "/" + R))
 *                   L is "swap-passphrase", "board" or "migrated-passphrase"; R is the run id (32 lower-case hex characters)
 *   passphrase(R) = lower-case hex of K("swap-passphrase", R)           64 characters, handed to swap-cli as SWAP_PASSPHRASE
 *   boardKey(R)   = K("board", R)                                        32 bytes, an AES-256-GCM key (sealed.js)
 *   migratedKey(R)= K("migrated-passphrase", R)                          32 bytes, an AES-256-GCM key (sealed.js)
 *   inviteKey     = HMAC-SHA256(S, "no1d-swap/v1/board-invite/install")  32 bytes
 *   historyKey    = HMAC-SHA256(S, "no1d-swap/v1/payout-history/install") 32 bytes, an AES-256-GCM key for payout-history.sealed (sealed.js)
 *   keyCheck      = first 8 bytes of HMAC-SHA256(S, "no1d-swap/v1/key-check"), as 16 lower-case hex characters
 *
 * The run id is read from run.json, never from the folder name. The same thing by hand (no program needed) is written in desktop/README.md and
 * done by desktop/tools/recovery.js. Appendix A of the build spec holds the test vectors; desktop/test/derive.test.js checks them.
 *
 * No function here keeps S: the caller owns the buffer and zero-fills it. Strings made from it (the passphrase) are the caller's to keep short.
 */

const crypto = require("crypto");

const LABELS = Object.freeze(["swap-passphrase", "board", "migrated-passphrase"]);
const RUN_ID_RE = /^[0-9a-f]{32}$/;

class DeriveError extends Error {}

function isRunId(x) {
  return typeof x === "string" && RUN_ID_RE.test(x);
}

function checkSecret(S) {
  if (!Buffer.isBuffer(S) || S.length !== 32) throw new DeriveError("the install secret is not 32 bytes");
}

function mac(S, text) {
  checkSecret(S);
  return crypto.createHmac("sha256", S).update(Buffer.from(text, "ascii")).digest();
}

/** K(L, R): 32 bytes. */
function K(S, label, runId) {
  if (!LABELS.includes(label)) throw new DeriveError("unknown derivation label");
  if (!isRunId(runId)) throw new DeriveError("the run id must be 32 lower-case hex characters");
  return mac(S, `no1d-swap/v1/${label}/${runId}`);
}

/** The swap's passphrase: a 64-character lower-case hex string. */
function passphrase(S, runId) {
  return K(S, "swap-passphrase", runId).toString("hex");
}

function boardKey(S, runId) {
  return K(S, "board", runId);
}

function migratedKey(S, runId) {
  return K(S, "migrated-passphrase", runId);
}

function inviteKey(S) {
  return mac(S, "no1d-swap/v1/board-invite/install");
}

/** K("payout-history", "install"): the key of the sealed history of payout addresses. The run id of this label is the fixed word "install". */
function historyKey(S) {
  return mac(S, "no1d-swap/v1/payout-history/install");
}

/** 16 lower-case hex characters. It tells an install apart from another one; it reveals nothing of S. */
function keyCheck(S) {
  return mac(S, "no1d-swap/v1/key-check").subarray(0, 8).toString("hex");
}

module.exports = { LABELS, DeriveError, isRunId, K, passphrase, boardKey, migratedKey, inviteKey, historyKey, keyCheck };
